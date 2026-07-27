"use strict";
/**
 * Оновлення yt-dlp.
 *
 * Це не зручність, а умова роботи: YouTube міняє свій бік раз на кілька
 * тижнів, і вшитий в інсталятор yt-dlp застаріває вже за місяць. Тоді
 * завантаження просто перестає працювати, і користувач бачить незрозумілу
 * помилку від чужої програми, про існування якої він і не здогадується.
 *
 * Оновлену копію кладемо НЕ поруч із програмою, а в профіль користувача:
 * тека встановлення може бути закрита на запис (встановлення «для всіх»),
 * а профіль писемний завжди. binaries.js шукає там першим, тому свіжа копія
 * автоматично переважає вшиту.
 *
 * Власний `yt-dlp -U` тут не годиться: він працює лише для exe і лише коли
 * той exe писемний, а ще нічого не знає про наш запасний варіант із Python.
 */

const fs = require("fs");
const path = require("path");
const binaries = require("./binaries");

let app = null;
try {
  app = require("electron").app || null;
} catch {
  /* поза Electron (тести) оновлювати нічого */
}

const NAME =
  process.platform === "win32" ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp";

const RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const DOWNLOAD = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${NAME}`;

/** Раз на добу — частіше немає сенсу, релізи виходять рідше. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

function userBinDir() {
  return app ? path.join(app.getPath("userData"), "bin") : null;
}

/**
 * Прибирає копії, залишені попереднім оновленням.
 *
 * Windows не дає видалити файл, який зараз виконується, зате дозволяє його
 * перейменувати — саме цим ми й підміняємо yt-dlp на ходу. Стару копію
 * прибираємо вже наступного запуску, коли її точно ніхто не тримає.
 */
function sweepOld() {
  const dir = userBinDir();
  if (!dir) return;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // теки ще немає — нічого прибирати
  }
  for (const n of names) {
    if (n.endsWith(".old") || n.endsWith(".part")) {
      try {
        fs.rmSync(path.join(dir, n), { force: true });
      } catch {
        /* ще зайнятий — заберемо наступного разу */
      }
    }
  }
}

/**
 * Версія, яка стоїть зараз; null — yt-dlp не знайдено або не запускається.
 * Саме асинхронний варіант: синхронний морозить вікно на час розпакування
 * yt-dlp, а це кілька секунд.
 */
function current() {
  return binaries.ytdlpVersion();
}

async function latest() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(RELEASE_API, {
      signal: ctl.signal,
      // GitHub відмовляє запитам без User-Agent.
      headers: { "user-agent": "MusicGrabber", accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`GitHub відповів HTTP ${r.status}`);
    const j = await r.json();
    if (!j.tag_name) throw new Error("GitHub не назвав версію");
    return String(j.tag_name);
  } finally {
    clearTimeout(t);
  }
}

/** @returns {Promise<{current: string|null, latest: string, fresh: boolean}>} */
async function check() {
  const [cur, last] = await Promise.all([current(), latest()]);
  return { current: cur, latest: last, fresh: Boolean(cur) && cur === last };
}

/**
 * Завантажує свіжий yt-dlp у профіль користувача.
 * @returns {Promise<{version: string, path: string}>}
 */
async function update() {
  const dir = userBinDir();
  if (!dir) throw new Error("Оновлення доступне лише у запущеній програмі");

  const version = await latest();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 180000);
  let buf;
  try {
    const r = await fetch(DOWNLOAD, { signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`не вдалося завантажити (HTTP ${r.status})`);
    buf = Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
  // Обрізане завантаження краще впізнати тут, ніж потім ловити «файл не є
  // програмою» посеред першої ж пісні.
  if (buf.length < 1_000_000) throw new Error("завантажений файл підозріло малий");

  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, NAME);
  const part = target + ".part";
  fs.writeFileSync(part, buf);
  if (process.platform !== "win32") fs.chmodSync(part, 0o755);

  if (fs.existsSync(target)) {
    const old = target + ".old";
    try {
      fs.rmSync(old, { force: true });
    } catch {
      /* лишився з минулого разу і ще зайнятий — переживемо */
    }
    fs.renameSync(target, old); // саме перейменування, бо файл може виконуватись
  }
  fs.renameSync(part, target);

  binaries.reset(); // наступний запуск має взяти вже нову копію

  // Заразом і перевірка: якщо завантажене не запускається, краще дізнатись
  // про це тут, ніж посеред першої ж пісні.
  const real = await binaries.ytdlpVersion();
  return { version: real || version, path: target };
}

/**
 * Тиха перевірка за розкладом.
 *
 * Мовчить про все, крім успішного оновлення: немає мережі, GitHub приліг,
 * версія й так свіжа — усе це не проблема користувача й не привід його
 * турбувати.
 *
 * @param {object} settings модуль налаштувань
 * @returns {Promise<{version: string}|null>} що саме оновилось, або null
 */
async function autoUpdate(settings) {
  const s = settings.load();
  if (!s.ytdlpAutoUpdate) return null;
  if (Date.now() - (s.ytdlpCheckedAt || 0) < CHECK_EVERY_MS) return null;

  try {
    const { fresh } = await check();
    // Дату записуємо в будь-якому разі: інакше при кожному запуску без мережі
    // програма знову лізла б у GitHub.
    settings.save({ ytdlpCheckedAt: Date.now() });
    if (fresh) return null;
    return await update();
  } catch {
    settings.save({ ytdlpCheckedAt: Date.now() });
    return null;
  }
}

module.exports = { check, update, autoUpdate, sweepOld, userBinDir, NAME };
