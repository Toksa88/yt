"use strict";
/**
 * Пошук зовнішніх програм, без яких додаток не працює: yt-dlp та ffmpeg.
 *
 * Порядок пошуку однаковий для обох: спершу те, що лежить поруч із додатком
 * (це єдиний варіант, який точно є на чужому комп'ютері), потім PATH, потім
 * типові місця встановлення. yt-dlp має ще запасний варіант — Python-модуль,
 * бо на машині розробника exe зазвичай немає, а `py -m yt_dlp` є.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, execFile } = require("child_process");

// Поза Electron (тести, перевірка з консолі) `require("electron")` віддає
// не об'єкт, а рядок зі шляхом — тому app може бути undefined. Модуль має
// працювати й так, інакше нічого тут не перевіриш без запуску вікна.
let app = null;
try {
  app = require("electron").app || null;
} catch {
  /* electron не встановлено — працюємо як звичайний Node */
}

const IS_WIN = process.platform === "win32";
const EXE = (name) => (IS_WIN ? name + ".exe" : name);

/** Теки, куди ми самі кладемо бінарники: у зібраному додатку та в дереві розробки. */
function bundledDirs() {
  const dirs = [];
  // Профіль користувача — перший навмисно: сюди лягає yt-dlp, оновлений уже
  // після встановлення (див. tools.js). Вшита в інсталятор копія застаріває,
  // і свіжа мусить її переважати, а не навпаки.
  if (app) {
    try {
      dirs.push(path.join(app.getPath("userData"), "bin"));
    } catch {
      /* профіль недоступний — обійдемось вшитою копією */
    }
  }
  if (app && app.isPackaged) {
    dirs.push(path.join(process.resourcesPath, "bin"));
    dirs.push(path.dirname(app.getPath("exe")));
  }
  dirs.push(path.join(__dirname, "..", "..", "bin"));
  return dirs;
}

function inPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* теки з PATH може не існувати — це нормально */
    }
  }
  return null;
}

function findExe(name, extraPatterns = []) {
  for (const dir of bundledDirs()) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  const onPath = inPath(name);
  if (onPath) return onPath;

  for (const dir of extraPatterns) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Розкриває %VAR% у шляху (Windows-стиль, бо саме такі константи нижче). */
function expand(p) {
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || "");
}

/** winget кладе ffmpeg у теку з версією в назві — доводиться перебирати. */
function wingetFfmpegDirs() {
  const root = expand("%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages");
  const out = [];
  let pkgs = [];
  try {
    pkgs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const pkg of pkgs) {
    if (!/^Gyan\.FFmpeg/i.test(pkg)) continue;
    const dir = path.join(root, pkg);
    let subs = [];
    try {
      subs = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const sub of subs) out.push(path.join(dir, sub, "bin"));
    out.push(dir);
  }
  return out;
}

let _ytdlp;
/**
 * @returns {{file: string, prefix: string[], kind: "exe"|"python"} | null}
 * prefix — аргументи, які треба підставити ПЕРЕД нашими (для `py -m yt_dlp`).
 */
function ytdlp() {
  if (_ytdlp !== undefined) return _ytdlp;

  const exe = findExe(EXE("yt-dlp"));
  if (exe) {
    _ytdlp = { file: exe, prefix: [], kind: "exe" };
    return _ytdlp;
  }

  // Запасний варіант для розробки: yt-dlp, встановлений як пакет Python.
  for (const py of IS_WIN ? ["py", "python"] : ["python3", "python"]) {
    try {
      execFileSync(py, ["-m", "yt_dlp", "--version"], {
        stdio: "ignore",
        timeout: 20000,
      });
      _ytdlp = { file: py, prefix: ["-m", "yt_dlp"], kind: "python" };
      return _ytdlp;
    } catch {
      /* немає такого Python або в ньому немає yt_dlp */
    }
  }

  _ytdlp = null;
  return _ytdlp;
}

let _ffmpegDir;
/** @returns {string|null} тека з ffmpeg (yt-dlp хоче саме теку, не файл) */
function ffmpegDir() {
  if (_ffmpegDir !== undefined) return _ffmpegDir;

  const extra = [
    ...wingetFfmpegDirs(),
    expand("%LOCALAPPDATA%\\Microsoft\\WinGet\\Links"),
    "C:\\ffmpeg\\bin",
    expand("%ProgramFiles%\\ffmpeg\\bin"),
  ];
  const hit = findExe(EXE("ffmpeg"), extra);
  _ffmpegDir = hit ? path.dirname(hit) : null;
  return _ffmpegDir;
}

/** Скидає кеш — потрібно після того, як користувач доклав бінарник вручну. */
function reset() {
  _ytdlp = undefined;
  _ffmpegDir = undefined;
  _version = undefined;
}

/**
 * Версія yt-dlp. Кеш тут не заради швидкості: yt-dlp.exe — це запакований
 * Python, і КОЖЕН його запуск спершу розпаковує себе в тимчасову теку. На
 * холодну це кілька секунд, і питати версію щоразу заново — розкіш.
 */
let _version;

/**
 * Те саме, але не блокуючи процес.
 *
 * status() лишається синхронним: він потрібен інтерфейсу один раз на старті,
 * і там усе одно нічого не намальовано. А от фоновій перевірці оновлень так
 * робити не можна — синхронний запуск морозить головний процес, а разом з
 * ним IPC і все вікно: Сховище зависає на «читаю теги», кнопки не тиснуться.
 */
function ytdlpVersion() {
  return new Promise((resolve) => {
    if (_version !== undefined) return resolve(_version);
    const y = ytdlp();
    if (!y) {
      _version = null;
      return resolve(null);
    }
    execFile(
      y.file,
      [...y.prefix, "--version"],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
      (err, out) => {
        _version = err ? null : String(out).trim();
        resolve(_version);
      },
    );
  });
}

function status() {
  const y = ytdlp();
  const f = ffmpegDir();
  let version = _version ?? null;
  if (y && _version === undefined) {
    try {
      version = execFileSync(y.file, [...y.prefix, "--version"], {
        encoding: "utf8",
        timeout: 20000,
      }).trim();
    } catch {
      /* є файл, але не запускається — покажемо як «версія невідома» */
      version = null;
    }
    _version = version;
  }
  return {
    ytdlp: y ? { path: y.file, kind: y.kind, version } : null,
    ffmpeg: f,
    ok: Boolean(y && f),
  };
}

module.exports = { ytdlp, ffmpegDir, status, ytdlpVersion, reset, bundledDirs };
