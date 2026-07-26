"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "settings.json");

/**
 * ID додатка Discord, вшитий у програму.
 *
 * Це НЕ секрет: Discord показує його в кожному статусі, який бачать усі
 * навколо. Секретним є Client Secret, і він тут не потрібен взагалі.
 *
 * Саме тому ID один на всіх: той, хто просто запустив програму, нічого не
 * налаштовує — його Discord підхопить цю ж назву додатка. Поле в
 * налаштуваннях лишається, щоб можна було підставити свій.
 */
const BUILTIN_DISCORD_APP_ID = "1530859162131759224";

const DEFAULTS = {
  outDir: "",
  // «Як є»: m4a — це рідний формат YouTube, ffmpeg лише перекладає контейнер
  // без перекодування. MP3 доступний у налаштуваннях для старих плеєрів
  // і магнітол, але він завжди означає ще одне стиснення поверх стиснутого.
  format: "m4a",
  sources: ["ytmusic", "soundcloud", "itunes", "musicbrainz"],
  watchClipboard: true,
  volume: 0.8,
  shuffle: false,
  repeat: "off",
  // Альбом кладеться в окрему теку — інакше десяток треків тоне в колекції.
  albumFolder: true,
  // Discord показує назву ЗАРЕЄСТРОВАНОГО додатка, а не заголовок нашого вікна.
  discordEnabled: false,
  discordAppId: "",
};

/** Порожнє поле означає «взяти вшитий ID», а не «вимкнути». */
function discordAppId(s) {
  return String(s.discordAppId || "").trim() || BUILTIN_DISCORD_APP_ID;
}

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    /* перший запуск або зіпсований файл — беремо типові значення */
  }
  cache = { ...DEFAULTS, ...saved };
  if (!cache.outDir) cache.outDir = path.join(app.getPath("music"), "Завантажено");
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2), "utf8");
  } catch {
    /* не змогли записати — налаштування просто не переживуть перезапуск */
  }
  return cache;
}

module.exports = { load, save, discordAppId, BUILTIN_DISCORD_APP_ID };
