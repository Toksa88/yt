"use strict";
/**
 * Власні плейлисти користувача.
 *
 * Зберігаємо шляхи до файлів, а не копії треків: плейлист має посилатись на
 * те, що реально лежить на диску. Якщо файл зникне, він просто не покажеться
 * у списку — але з плейлиста його не викидаємо мовчки, бо диск могли просто
 * тимчасово від'єднати.
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "playlists.json");

/** @type {null | Array<{id: string, name: string, tracks: string[], created: number}>} */
let cache = null;
let seq = 0;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    cache = Array.isArray(raw) ? raw : [];
  } catch {
    cache = []; // перший запуск або зіпсований файл
  }
  for (const p of cache) {
    const n = Number(String(p.id).replace(/\D/g, ""));
    if (n > seq) seq = n;
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2), "utf8");
  } catch {
    /* не змогли записати — плейлисти не переживуть перезапуск */
  }
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

function addTracks(id, paths) {
  load();
  const p = cache.find((x) => x.id === id);
  if (!p) return cache;
  for (const t of paths) {
    if (!p.tracks.includes(t)) p.tracks.push(t);
  }
  return save();
}

function removeTrack(id, trackPath) {
  load();
  const p = cache.find((x) => x.id === id);
  if (p) p.tracks = p.tracks.filter((t) => t !== trackPath);
  return save();
}

/** Після перейменування файлу треба полагодити посилання в усіх плейлистах. */
function repath(oldPath, newPath) {
  load();
  let touched = false;
  for (const p of cache) {
    const i = p.tracks.indexOf(oldPath);
    if (i >= 0) {
      p.tracks[i] = newPath;
      touched = true;
    }
  }
  return touched ? save() : cache;
}

module.exports = { load, create, rename, remove, addTracks, removeTrack, repath };
