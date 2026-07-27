"use strict";
/**
 * Власні плейлисти користувача.
 *
 * Зберігаємо повні дані треку, а не самі шляхи. Спершу тут були шляхи, і це
 * була помилка задуму: тоді в плейлист можна було покласти лише вже
 * завантажене, хоча природно хотіти скласти список із того, що ти щойно
 * знайшов і слухаєш потоком.
 *
 * Старий формат (масив рядків) читається й далі — його записи перетворюються
 * на треки при завантаженні, щоб уже створені плейлисти не загубились.
 */

const path = require("path");
const { app } = require("electron");
const personal = require("./personal");
const store = require("./store");

const FILE = () => path.join(app.getPath("userData"), "playlists.json");

/** @type {null | Array<{id: string, name: string, tracks: string[], created: number}>} */
let cache = null;
let seq = 0;

/** Запис зі старого формату (просто шлях) робимо повноцінним треком. */
function upgrade(entry) {
  if (typeof entry !== "string") return entry;
  const base = path.basename(entry, path.extname(entry));
  const dash = base.indexOf(" - ");
  return {
    key: entry,
    path: entry,
    url: null,
    source: "local",
    artist: dash > 0 ? base.slice(0, dash).trim() : "",
    title: dash > 0 ? base.slice(dash + 3).trim() : base,
    album: "",
    duration: null,
    thumb: null,
  };
}

function load() {
  if (cache) return cache;
  cache = store.readJson(FILE(), { fallback: [], valid: Array.isArray });
  for (const p of cache) {
    p.tracks = (p.tracks || []).map(upgrade).filter(Boolean);
    const n = Number(String(p.id).replace(/\D/g, ""));
    if (n > seq) seq = n;
  }
  return cache;
}

function save() {
  store.writeJson(FILE(), cache);
  return cache;
}

function create(name) {
  load();
  const clean = String(name || "").trim() || "Новий плейлист";
  cache.unshift({ id: `p${++seq}`, name: clean, tracks: [], created: Date.now() });
  return save();
}

function rename(id, name) {
  load();
  const p = cache.find((x) => x.id === id);
  if (p) p.name = String(name || "").trim() || p.name;
  return save();
}

function remove(id) {
  load();
  cache = cache.filter((x) => x.id !== id);
  return save();
}

/** @param {Array<object>} tracks локальні файли або треки з пошуку — байдуже */
function addTracks(id, tracks) {
  load();
  const p = cache.find((x) => x.id === id);
  if (!p) return cache;
  for (const raw of tracks || []) {
    const t = personal.slim(raw);
    if (!t.key) continue;
    if (!p.tracks.some((x) => x.key === t.key)) p.tracks.push(t);
  }
  return save();
}

function removeTrack(id, key) {
  load();
  const p = cache.find((x) => x.id === id);
  if (p) p.tracks = p.tracks.filter((t) => t.key !== key);
  return save();
}

/** Після перейменування файлу треба полагодити посилання в усіх плейлистах. */
function repath(oldPath, newPath) {
  load();
  let touched = false;
  for (const p of cache) {
    for (const t of p.tracks) {
      if (t.path === oldPath) {
        t.path = newPath;
        t.key = newPath;
        touched = true;
      }
    }
  }
  return touched ? save() : cache;
}

module.exports = { load, create, rename, remove, addTracks, removeTrack, repath };
