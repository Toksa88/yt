"use strict";
/**
 * Що грало: черга, місце в ній і секунда, на якій зупинились.
 *
 * Живе воно у вікні, але вікно смертне — воно може впасти, і тоді разом з ним
 * зникає черга на сорок треків, яку людина щойно набрала з радіо. Тому вікно
 * пересилає свій стан сюди, а головний процес повертає його назад після
 * перезавантаження й після звичайного запуску програми.
 *
 * ЗАВЖДИ НА ПАУЗІ. Якщо крах спричинив саме той потік, що грав, автоматичне
 * продовження відтворило б крах — і так по колу. Пауза розриває це коло:
 * людина бачить, що саме грало, і сама вирішує, чи вмикати.
 */

const path = require("path");
const { app } = require("electron");
const store = require("./store");

const FILE = () => path.join(app.getPath("userData"), "session.json");

/** Скільки треків черги пам'ятаємо. Радіо дає сорок, альбом — рідко більше. */
const MAX_TRACKS = 200;

/** @type {{list: any[], i: number, position: number, at: number} | null} */
let cache;

/**
 * Запис на диск притлумлено за часом: черга змінюється на кожне «грати
 * наступним» і кожне переставляння, і писати файл на кожен чих ні до чого.
 */
let timer = null;
const WRITE_AFTER_MS = 3000;

function load() {
  if (cache !== undefined) return cache;
  cache = store.readJson(FILE(), {
    fallback: null,
    valid: (v) => v && Array.isArray(v.list) && typeof v.i === "number",
  });
  return cache;
}

/** @param {{list: any[], i: number, position: number}} state */
function save(state) {
  if (!state || !Array.isArray(state.list)) return;

  cache = {
    list: state.list.slice(0, MAX_TRACKS),
    i: Math.min(Number(state.i) || 0, MAX_TRACKS - 1),
    position: Number(state.position) || 0,
    at: Date.now(),
  };

  clearTimeout(timer);
  timer = setTimeout(flush, WRITE_AFTER_MS);
}

/** Записує негайно — потрібно перед виходом, інакше останні секунди губляться. */
function flush() {
  clearTimeout(timer);
  timer = null;
  if (cache) store.writeJson(FILE(), cache);
}

/**
 * Те, що варто відновити.
 *
 * За часом нічого не протухає навмисно: список треків не псується від
 * лежання, і повернутись до нього через тиждень так само доречно, як через
 * хвилину. Мертві записи відсіє вже саме вікно — файл могли видалити,
 * а посилання на потік однаково перепитується щоразу.
 */
function restore() {
  const s = load();
  return s && s.list.length ? s : null;
}

function clear() {
  cache = null;
  clearTimeout(timer);
  store.writeJson(FILE(), null);
}

module.exports = { save, restore, flush, clear, MAX_TRACKS };
