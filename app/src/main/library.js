"use strict";
/**
 * Сховище — те, що вже лежить на диску.
 *
 * Читаємо теги напряму з файлів, а не ведемо власну базу: користувач може
 * перекласти файли, перейменувати їх або накачати чимось іншим, і будь-яка
 * наша база одразу розійдеться з дійсністю. Диск тут — єдине джерело правди.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const AUDIO_EXT = new Set([".mp3", ".m4a", ".flac", ".opus", ".ogg", ".oga", ".wav", ".aac", ".wma"]);
const MAX_DEPTH = 6;

// music-metadata має лише ESM-збірку, тож підключаємо його динамічно:
// звичайний require() з нашого CJS-коду на ньому просто впаде.
let _mm = null;
async function mm() {
  if (!_mm) _mm = await import("music-metadata");
  return _mm;
}

/** Кеш розібраних тегів: ключ — шлях, дійсний доки збігаються розмір і mtime. */
const tagCache = new Map();
/** Кеш обкладинок — окремо, бо вони важкі й потрібні не завжди. */
const coverCache = new Map();

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // немає доступу або теку видалили просто зараз
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, depth + 1, out);
    } else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/**
 * Обкладинка як звичайне посилання.
 *
 * Потрібна для статусу в Discord: він приймає лише http(s), а вшита в файл
 * картинка — це data:. Проте yt-dlp лишає в тегах адресу джерела (©cmt у m4a,
 * purl у mp3), і з неї виводиться адреса прев'ю на YouTube.
 */
function youtubeThumb(md) {
  for (const list of Object.values(md.native || {})) {
    for (const tag of list) {
      const v =
        typeof tag.value === "string" ? tag.value : tag.value?.text || tag.value?.url || "";
      const m = String(v).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
      if (m) return `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
    }
  }
  return null;
}

async function readTags(file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }

  const cached = tagCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.data;

  const base = path.basename(file, path.extname(file));
  let title = base;
  let artist = "";
  let album = "";
  let duration = null;
  let bitrate = null;
  let hasCover = false;
  let thumbUrl = null;

  try {
    const { parseFile } = await mm();
    const md = await parseFile(file, { duration: false, skipCovers: true });
    const c = md.common || {};
    if (c.title) title = c.title;
    if (c.artist) artist = c.artist;
    if (c.album) album = c.album;
    hasCover = Boolean(c.picture?.length);
    duration = md.format?.duration ? Math.round(md.format.duration) : null;
    bitrate = md.format?.bitrate ? Math.round(md.format.bitrate / 1000) : null;
    thumbUrl = youtubeThumb(md);
  } catch {
    // Файл може бути битим або ще дозаписуватись — тоді показуємо його
    // за іменем. Ховати його зі списку було б гірше: користувач бачить
    // файл у Провіднику й не розуміє, чому в програмі його нема.
  }

  // Запасний варіант для файлів без тегів: наша ж схема «Автор - Назва».
  if (!artist) {
    const dash = base.indexOf(" - ");
    if (dash > 0) {
      artist = base.slice(0, dash).trim();
      title = base.slice(dash + 3).trim();
    }
  }

  const data = {
    path: file,
    file: path.basename(file),
    dir: path.dirname(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    title,
    artist,
    album,
    duration,
    bitrate,
    hasCover,
    thumbUrl,
    size: st.size,
    mtime: st.mtimeMs,
  };
  tagCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, data });
  return data;
}

/** @returns {Promise<{dir: string, tracks: any[], missing: boolean}>} */
async function scan(dir) {
  if (!dir || !fs.existsSync(dir)) return { dir, tracks: [], missing: true };

  const files = [];
  await walk(dir, 0, files);

  const tracks = [];
  // Порціями, щоб не відкрити тисячу файлів одночасно на повільному диску.
  const CHUNK = 24;
  for (let i = 0; i < files.length; i += CHUNK) {
    const part = await Promise.all(files.slice(i, i + CHUNK).map(readTags));
    for (const t of part) if (t) tracks.push(t);
  }

  tracks.sort((a, b) => b.mtime - a.mtime);
  return { dir, tracks, missing: false };
}

/** Обкладинка як data-URI. Окремим викликом: інтерфейс просить її лише для видимих рядків. */
async function cover(file) {
  if (coverCache.has(file)) return coverCache.get(file);
  let uri = null;
  try {
    const { parseFile } = await mm();
    const md = await parseFile(file, { duration: false });
    const pic = md.common?.picture?.[0];
    if (pic) {
      const buf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);
      uri = `data:${pic.format || "image/jpeg"};base64,${buf.toString("base64")}`;
    }
  } catch {
    /* обкладинки нема або файл не читається */
  }
  // Кешуємо і відсутність теж — інакше інтерфейс питатиме про це щоразу.
  coverCache.set(file, uri);
  return uri;
}

/** Ключі «виконавець|назва» — щоб у пошуку позначати вже завантажене. */
function ownedKeys(tracks) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  return tracks.map((t) => `${norm(t.artist)}|${norm(t.title)}`);
}

function forget(file) {
  tagCache.delete(file);
  coverCache.delete(file);
}

module.exports = { scan, cover, ownedKeys, forget, AUDIO_EXT };
