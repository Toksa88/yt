"use strict";

const path = require("path");
const { app } = require("electron");
const store = require("./store");

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
  sources: ["ytmusic", "youtube", "soundcloud", "itunes", "musicbrainz"],
  /**
   * Джерела, які користувач уже бачив. Потрібні, щоб відрізнити «вимкнув
   * свідомо» від «з'явилось у новій версії»: без цього нове джерело мовчки
   * лишалося б вимкненим у всіх, хто вже колись запускав програму.
   */
  knownSources: [],
  watchClipboard: true,
  /**
   * Масштаб інтерфейсу. На великому моніторі зі стовідсотковим масштабом
   * системи все виглядає дрібним, і кожен запуск починався б із Ctrl+«+».
   */
  zoom: 1,
  volume: 0.8,
  shuffle: false,
  repeat: "off",
  // Альбом кладеться в окрему теку — інакше десяток треків тоне в колекції.
  albumFolder: true,
  // Discord показує назву ЗАРЕЄСТРОВАНОГО додатка, а не заголовок нашого вікна.
  discordEnabled: false,
  discordAppId: "",
  /**
   * Свіжий yt-dlp — умова роботи, а не забаганка: YouTube ламає старі версії
   * раз на кілька тижнів. Тому типово ввімкнено, але вимикається — на випадок
   * платного або обмеженого інтернету.
   */
  ytdlpAutoUpdate: true,
  ytdlpCheckedAt: 0,
};

/** Порожнє поле означає «взяти вшитий ID», а не «вимкнути». */
function discordAppId(s) {
  return String(s.discordAppId || "").trim() || BUILTIN_DISCORD_APP_ID;
}

let cache = null;

function load() {
  if (cache) return cache;
  // Налаштування — єдине з трьох, що не шкода: усе тут має типове значення,
  // і зіпсований файл коштує лише кількох галочок.
  const saved = store.readJson(FILE(), {
    fallback: {},
    valid: (v) => v && typeof v === "object" && !Array.isArray(v),
  });
  cache = { ...DEFAULTS, ...saved };
  if (!cache.outDir) cache.outDir = path.join(app.getPath("music"), "Завантажено");

  // Джерело, додане в новій версії, вмикаємо один раз — далі рішення за
  // користувачем. Порожній knownSources означає налаштування зі старої
  // версії: там усе, що було на той момент, вважаємо баченим.
  const known = new Set(cache.knownSources?.length ? cache.knownSources : cache.sources);
  let changed = false;
  for (const s of DEFAULTS.sources) {
    if (known.has(s)) continue;
    known.add(s);
    if (!cache.sources.includes(s)) cache.sources.push(s);
    changed = true;
  }
  cache.knownSources = [...known];
  if (changed) save({});

  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  store.writeJson(FILE(), cache);
  return cache;
}

module.exports = { load, save, discordAppId, BUILTIN_DISCORD_APP_ID };
