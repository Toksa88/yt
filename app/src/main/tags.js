"use strict";
/**
 * Редактор тегів уже завантажених файлів.
 *
 * Перезаписуємо через ffmpeg із -c copy: звук не перекодовується, обкладинка
 * лишається (перевірено на mp3, m4a та opus — тривалість і розмір збігаються
 * до байтів). Тому окрема бібліотека для запису тегів не потрібна.
 *
 * Оригінал заміняємо лише після того, як новий файл повністю зібрано: якщо
 * ffmpeg упаде на середині, у користувача лишиться цілий старий файл, а не
 * обрубок.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const binaries = require("./binaries");

const IS_WIN = process.platform === "win32";

function ffmpegPath() {
  const dir = binaries.ffmpegDir();
  if (!dir) throw new Error("ffmpeg не знайдено — без нього теги змінити неможливо");
  return path.join(dir, IS_WIN ? "ffmpeg.exe" : "ffmpeg");
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1 << 22 }, (err, _out, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split("\n").pop()));
      resolve();
    });
  });
}

/** Прибирає з назви те, що Windows не пускає в імена файлів. */
function safeName(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

/** Якщо таке ім'я вже зайняте — додаємо (2), (3)… замість мовчазної перезаписи. */
async function freeName(dir, base, ext, exceptPath) {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
    const full = path.join(dir, name);
    if (full === exceptPath) return full;
    if (!fs.existsSync(full)) return full;
  }
  throw new Error("Не вдалося підібрати вільне ім'я файлу");
}

/**
 * @param {string} file шлях до наявного файлу
 * @param {{artist?: string, title?: string, album?: string, rename?: boolean}} patch
 * @returns {Promise<{path: string, renamed: boolean}>} новий шлях (може змінитись)
 */
async function write(file, patch) {
  if (!fs.existsSync(file)) throw new Error("Файл не знайдено");

  const ext = path.extname(file);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.mg-tmp-${Date.now()}${ext}`);

  const meta = [];
  for (const key of ["artist", "title", "album"]) {
    if (patch[key] === undefined) continue;
    meta.push("-metadata", `${key}=${patch[key]}`);
    // Windows Explorer читає з mp3 ще й «album_artist»; без нього в теці
    // з альбомом файли лишаються згруповані під старим виконавцем.
    if (key === "artist") meta.push("-metadata", `album_artist=${patch[key]}`);
  }
  if (!meta.length) return { path: file, renamed: false };

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", file,
    "-map", "0", // усі потоки, разом із картинкою-обкладинкою
    "-c", "copy", // нічого не перекодовувати
    ...meta,
  ];
  if (ext.toLowerCase() === ".mp3") args.push("-id3v2_version", "3", "-write_id3v1", "1");
  args.push("-y", tmp);

  try {
    await run(ffmpegPath(), args);
    const st = await fsp.stat(tmp);
    if (st.size < 1024) throw new Error("ffmpeg зробив порожній файл");

    // Замінюємо оригінал лише зараз, коли новий файл точно цілий.
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }

  if (!patch.rename) return { path: file, renamed: false };

  const artist = safeName(patch.artist);
  const title = safeName(patch.title);
  if (!artist || !title) return { path: file, renamed: false };

  const want = await freeName(dir, `${artist} - ${title}`, ext, file);
  if (want === file) return { path: file, renamed: false };
  await fsp.rename(file, want);
  return { path: want, renamed: true };
}

module.exports = { write, safeName };
