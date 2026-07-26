"use strict";
/**
 * Черга завантажень поверх yt-dlp.
 *
 * Набір прапорців тут — не випадковий, кожен закриває конкретну поломку,
 * яку видно у файлі на диску. Не прибирати, не перевіривши результат:
 *   --convert-thumbnails jpg  YouTube віддає webp, а його не можна вшити
 *                             ані в mp3, ані в m4a — обкладинка просто ляже
 *                             окремим файлом поруч;
 *   -f bestaudio[ext=m4a]     без цього bestaudio віддає webm/opus (виграє
 *                             за бітрейтом), а в webm обкладинки нема взагалі;
 *   --replace-in-metadata     YouTube пише в тег artist усіх виконавців через
 *                             кому («A, B, B») — саме це показує Провідник;
 *   artists.0 у шаблоні імені те саме, але для назви файлу.
 */

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");
const os = require("os");
const fs = require("fs");
const binaries = require("./binaries");

const MAX_PARALLEL = 2;

/** Скільки разів пробувати завдання, що впало з тимчасової причини. */
const MAX_ATTEMPTS = 3;
/** Пауза перед 2-ю та 3-ю спробою: одразу повторювати 403 марно. */
const BACKOFF_MS = [0, 5000, 15000];

/**
 * Помилки, які минають самі. Перевірено на живому 403: той самий трек з тими
 * самими прапорцями за хвилину качається без проблем, а спроби «полагодити»
 * це іншим клієнтом YouTube ламають вибір формату зовсім.
 */
const TRANSIENT =
  /\b403\b|Forbidden|\b429\b|too many requests|timed? ?out|reset by peer|Connection (aborted|reset)|HTTP Error 5\d\d|Remote end closed|Unable to download (webpage|video data|JSON)|temporarily/i;

/** Спільний корінь для тимчасових файлів усіх завдань. */
const TEMP_ROOT = path.join(os.tmpdir(), "music-grabber");

/** Прибирає теки, що лишились від попереднього запуску (напр. після збою). */
function cleanTempRoot() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    /* якщо не вийшло — не біда, це лише тимчасові файли */
  }
}
cleanTempRoot();

const bus = new EventEmitter();
/** @type {Map<string, any>} */
const jobs = new Map();
const queue = [];
const running = new Map(); // jobId -> ChildProcess
let seq = 0;

function snapshot(job) {
  const { child, ...rest } = job;
  return rest;
}

function emit(job) {
  bus.emit("update", snapshot(job));
}

function buildArgs(job) {
  const args = [];

  if (job.format === "mp3") {
    // Єдиний варіант із перекодуванням: mp3 у джерелах не існує.
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "320K");
  } else if (job.format === "opus") {
    // Найкраще, що взагалі є: на YouTube opus іде ~155 kb/s проти 130 kb/s
    // у m4a. Обкладинку в ogg/opus вшиває mutagen (він усередині yt-dlp).
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "opus");
  } else {
    // bestaudio часто віддає webm/opus (він виграє за бітрейтом) — а в webm
    // обкладинку вшити НЕ можна. Тому просимо саме m4a: ffmpeg лише
    // перекладає контейнер, без перекодування.
    args.push("-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a");
  }

  args.push(
    // Готовий файл — у теку користувача, а вся проміжна робота (webp-обкладинка,
    // .part, проміжний m4a) — у власну тимчасову теку завдання. Без цього
    // невдале завантаження лишало в музиці .jpg без музики, а прибирати його
    // «за розширенням» небезпечно: поруч може качатись інший трек.
    "-P", `home:${job.outDir}`,
    "-P", `temp:${job.tempDir}`,
    // Альбом кладемо в його власну теку, щоб десяток треків не змішувався
    // з рештою колекції. Ланцюжок запасних полів потрібен, бо в альбомів із
    // збірками поле album порожнє — тоді береться назва плейлиста.
    "-o",
    (job.isPlaylist && job.albumFolder
      ? "%(album,playlist_title,playlist,uploader)s/"
      : "") + "%(artists.0,artist,uploader)s - %(track,title)s.%(ext)s",
    "--replace-in-metadata", "artist", ",\\s*.+$", "",
    "--embed-metadata",
    "--embed-thumbnail",
    "--convert-thumbnails", "jpg",
    "--ppa", "embedthumbnail+ffmpeg_o:-c:v mjpeg -vf crop=ih:ih",
    "--windows-filenames",
    "--retries", "10",
    "--fragment-retries", "10",
    "--extractor-retries", "3",
    "--no-warnings",
    "--newline",
    "--no-colors",
    "--encoding", "utf-8",
    "--progress-template",
    "download:@P@%(progress.downloaded_bytes)s@%(progress.total_bytes,progress.total_bytes_estimate)s@%(progress.speed)s@%(progress.eta)s",
    "--print", "after_move:@F@%(filepath)s",
    "--no-simulate",
    // --print неявно вмикає --quiet, а разом з ним глухне і прогрес: смужка
    // просто стоїть на нулі до кінця завантаження. Повертаємо вивід назад.
    "--no-quiet",
  );

  // Один трек з YouTube може висіти в «радіо»-плейлисті на сотні відео —
  // без цього прапорця клік по пісні перетворюється на завантаження міксу.
  if (!job.isPlaylist) args.push("--no-playlist");

  const ff = binaries.ffmpegDir();
  if (ff) args.push("--ffmpeg-location", ff);

  args.push(job.url);
  return args;
}

function parseLine(job, line) {
  if (line.startsWith("@P@")) {
    // Рядок «@P@1024@1412259@485197@2» ділиться на ["", "P", got, total, ...]:
    // перший елемент порожній, бо рядок починається з роздільника.
    const p = line.split("@");
    const got = Number(p[2]);
    const total = Number(p[3]);
    if (Number.isFinite(got) && Number.isFinite(total) && total > 0) {
      job.percent = Math.min(100, (got / total) * 100);
    }
    // Швидкість та ETA yt-dlp іноді віддає як "NA" — Number дасть NaN.
    job.speed = Number(p[4]) || 0;
    job.eta = Number(p[5]) || 0;
    job.phase = "download";
    return true;
  }

  if (line.startsWith("@F@")) {
    const file = line.slice(3).trim();
    if (file && !job.files.includes(file)) job.files.push(file);
    job.done = job.files.length;
    return true;
  }

  // «[download] Downloading item 3 of 12» — єдине джерело правди про те,
  // скільки треків в альбомі: наперед ми цього не знаємо.
  const item = line.match(/Downloading item (\d+) of (\d+)/);
  if (item) {
    job.index = Number(item[1]);
    job.total = Number(item[2]);
    job.percent = 0;
    return true;
  }

  if (/^\[(ExtractAudio|Metadata|EmbedThumbnail|ThumbnailsConvertor|FixupM4a)/.test(line)) {
    job.phase = "process";
    job.percent = 100;
    return true;
  }

  return false;
}

function start(job) {
  const bin = binaries.ytdlp();
  if (!bin) {
    job.status = "error";
    job.error = "yt-dlp не знайдено";
    emit(job);
    return next();
  }

  try {
    fs.mkdirSync(job.outDir, { recursive: true });
    fs.mkdirSync(job.tempDir, { recursive: true });
  } catch (e) {
    job.status = "error";
    job.error = `Не вдалося створити теку: ${e.message}`;
    emit(job);
    return next();
  }

  job.status = "active";
  job.phase = "start";
  emit(job);

  const child = spawn(bin.file, [...bin.prefix, ...buildArgs(job)], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  running.set(job.id, child);
  job.child = child;

  let stderr = "";
  let buf = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim() && parseLine(job, line.trim())) emit(job);
    }
  });

  child.stderr.on("data", (d) => {
    stderr += d;
    // yt-dlp пише сюди і попередження, і фатальні помилки — тримаємо
    // останні рядки, щоб було що показати, якщо процес впаде.
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  child.on("error", (e) => {
    job.status = "error";
    job.error = e.message;
    running.delete(job.id);
    emit(job);
    next();
  });

  child.on("close", (code) => {
    running.delete(job.id);
    job.child = null;
    try {
      fs.rmSync(job.tempDir, { recursive: true, force: true });
    } catch {
      /* теку заберемо при наступному запуску */
    }

    if (job.status === "canceled") {
      emit(job);
      return next();
    }

    if (code === 0 && job.files.length) {
      job.status = "done";
      job.percent = 100;
      job.phase = "done";
      emit(job);
      return next();
    }

    let message;
    if (code === 0) {
      // Код 0 без жодного файлу — так виглядав «тихий успіх», коли насправді
      // не завантажилось нічого. Мовчати про це не можна.
      message = "yt-dlp завершився без помилки, але жодного файлу не створено";
    } else {
      const lines = stderr.trim().split("\n").filter((l) => /error/i.test(l));
      message = (lines.pop() || stderr.trim().split("\n").pop() || `код ${code}`).slice(0, 300);
    }

    if (TRANSIENT.test(message) && job.attempt + 1 < MAX_ATTEMPTS) {
      job.attempt++;
      job.status = "retrying";
      job.error = `${message} — спроба ${job.attempt + 1} з ${MAX_ATTEMPTS}`;
      emit(job);
      setTimeout(() => {
        if (job.status !== "retrying") return; // встигли скасувати, поки чекали
        job.status = "queued";
        job.percent = 0;
        job.files = [];
        job.done = 0;
        emit(job);
        queue.push(job.id);
        next();
      }, BACKOFF_MS[job.attempt]);
      return next();
    }

    job.status = "error";
    job.error = message;
    emit(job);
    next();
  });
}

function next() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const job = jobs.get(queue.shift());
    if (job && job.status === "queued") start(job);
  }
}

/**
 * @param {Array} items треки або альбоми (у альбома має бути playlist-URL)
 * @param {{outDir: string, format: "mp3"|"m4a"}} opts
 */
function add(items, opts) {
  const created = [];
  for (const it of items) {
    if (!it.url) continue;
    const job = {
      id: `j${++seq}`,
      url: it.url,
      title: it.title || it.name || it.url,
      artist: it.artist || "",
      thumb: it.thumb || null,
      isPlaylist: it.kind === "album" || Boolean(it.isPlaylist),
      outDir: opts.outDir,
      tempDir: path.join(TEMP_ROOT, `j${seq}`),
      albumFolder: opts.albumFolder !== false,
      attempt: 0,
      format: ["m4a", "mp3", "opus"].includes(opts.format) ? opts.format : "m4a",
      status: "queued",
      percent: 0,
      speed: 0,
      eta: 0,
      phase: "",
      index: 0,
      total: it.kind === "album" ? 0 : 1,
      done: 0,
      files: [],
      error: null,
      child: null,
    };
    jobs.set(job.id, job);
    queue.push(job.id);
    created.push(snapshot(job));
    emit(job);
  }
  next();
  return created;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;

  // «retrying» теж скасовне: воно чекає на таймері, і той таймер сам
  // перевірить статус, перш ніж повертати завдання в чергу.
  if (job.status === "queued" || job.status === "retrying") {
    job.status = "canceled";
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    emit(job);
    return true;
  }

  const child = running.get(id);
  if (child) {
    job.status = "canceled";
    // yt-dlp запускає ffmpeg окремим процесом: звичайний kill уб'є батька,
    // а ffmpeg лишиться доїдати файл. /T убиває все дерево.
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
    return true;
  }
  return false;
}

function retry(id) {
  const job = jobs.get(id);
  if (!job || ["active", "queued", "retrying"].includes(job.status)) return false;
  job.status = "queued";
  job.percent = 0;
  job.attempt = 0; // ручний повтор дає завданню повний новий набір спроб
  job.error = null;
  job.files = [];
  job.done = 0;
  queue.push(id);
  emit(job);
  next();
  return true;
}

function list() {
  return [...jobs.values()].map(snapshot);
}

function clearFinished() {
  for (const [id, job] of jobs) {
    if (job.status === "done" || job.status === "canceled") jobs.delete(id);
  }
  return list();
}

// buildArgs/parseLine експортуються заради тестів: перевіряти набір прапорців
// через запуск вікна — надто повільно й ненадійно.
module.exports = {
  add, cancel, retry, list, clearFinished, bus,
  buildArgs, parseLine, TRANSIENT, TEMP_ROOT,
};
