"use strict";
/**
 * Особисте: улюблене та історія прослуханого.
 *
 * На відміну від плейлистів, тут зберігаються не лише шляхи до файлів, а й
 * самі дані треку. Причина проста: вподобати можна й те, що ти щойно знайшов
 * і слухаєш потоком, ще не завантаживши. Якщо тримати самі шляхи, таке
 * вподобання нікуди було б записати.
 */

const path = require("path");
const { app } = require("electron");
const store = require("./store");

const FILE = () => path.join(app.getPath("userData"), "personal.json");

/** Скільки прослуханого пам'ятаємо. Більше — лише роздуває файл. */
const HISTORY_LIMIT = 300;

let cache = null;

function load() {
  if (cache) return cache;
  const raw = store.readJson(FILE(), {
    fallback: { favorites: [], history: [] },
    valid: (v) => v && Array.isArray(v.favorites) && Array.isArray(v.history),
  });
  cache = {
    favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
    history: Array.isArray(raw.history) ? raw.history : [],
  };
  return cache;
}

function save() {
  store.writeJson(FILE(), cache);
  return cache;
}

/** Ключ треку: локальний файл упізнаємо за шляхом, мережевий — за посиланням. */
function keyOf(t) {
  return t?.path || t?.url || null;
}

/** Зберігаємо лише те, що знадобиться для показу й відтворення. */
function slim(t) {
  return {
    key: keyOf(t),
    path: t.path || null,
    url: t.url || null,
    videoId: t.videoId || null,
    source: t.source || (t.path ? "local" : "ytmusic"),
    title: t.title || "?",
    artist: t.artist || "",
    album: t.album || "",
    duration: t.duration || null,
    thumb: t.thumb || t.thumbUrl || null,
  };
}

function favorites() {
  return load().favorites;
}

/** @returns {{favorites: any[], added: boolean}} */
function favToggle(track) {
  load();
  const key = keyOf(track);
  if (!key) return { favorites: cache.favorites, added: false };

  const i = cache.favorites.findIndex((t) => t.key === key);
  if (i >= 0) {
    cache.favorites.splice(i, 1);
    save();
    return { favorites: cache.favorites, added: false };
  }
  cache.favorites.unshift(slim(track));
  save();
  return { favorites: cache.favorites, added: true };
}

/**
 * Перейменування файлу міняє шлях, тобто ключ. Без цього вподобаний трек
 * після правки тегів мовчки перетворювався б на другий, «новий».
 */
function repath(oldPath, newPath) {
  load();
  let touched = false;
  for (const list of [cache.favorites, cache.history]) {
    for (const t of list) {
      if (t.path === oldPath) {
        t.path = newPath;
        t.key = newPath;
        touched = true;
      }
    }
  }
  return touched ? save() : cache;
}

function history() {
  return load().history;
}

function historyAdd(track) {
  load();
  const key = keyOf(track);
  if (!key) return cache.history;

  // Той самий трек підряд (перемотка, пауза, повтор) не має засмічувати список.
  if (cache.history[0]?.key === key) {
    cache.history[0].at = Date.now();
    save();
    return cache.history;
  }

  cache.history = cache.history.filter((t) => t.key !== key);
  cache.history.unshift({ ...slim(track), at: Date.now() });
  if (cache.history.length > HISTORY_LIMIT) cache.history.length = HISTORY_LIMIT;
  save();
  return cache.history;
}

function historyClear() {
  load();
  cache.history = [];
  return save().history;
}

module.exports = { favorites, favToggle, history, historyAdd, historyClear, repath, keyOf, slim };
