"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "settings.json");

const DEFAULTS = {
  outDir: "",
  format: "mp3",
  sources: ["ytmusic", "soundcloud", "itunes", "musicbrainz"],
};

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

module.exports = { load, save };
