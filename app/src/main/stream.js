"use strict";
/**
 * Пряме посилання на звук — щоб слухати знайдене, не завантажуючи.
 *
 * yt-dlp віддає URL, який сервер обслуговує частинами (Range/206), а саме так
 * і працює тег <audio>. Посилання прив'язане до часу: у ньому є параметр
 * expire, після якого воно мертве, тому кешуємо з оглядкою на цей час.
 */

const { spawn } = require("child_process");
const binaries = require("./binaries");

/** @type {Map<string, {url: string, expires: number}>} */
const cache = new Map();

/** Дістає час протухання з самого посилання; якщо його нема — даємо 30 хвилин. */
function expiryOf(url) {
  const m = url.match(/[?&]expire=(\d+)/);
  if (m) return Number(m[1]) * 1000 - 60000; // хвилина запасу
  return Date.now() + 30 * 60 * 1000;
}

function resolve(pageUrl) {
  const hit = cache.get(pageUrl);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.url);

  return new Promise((res, rej) => {
    const bin = binaries.ytdlp();
    if (!bin) return rej(new Error("yt-dlp не знайдено"));

    const child = spawn(
      bin.file,
      [
        ...bin.prefix,
        // m4a найкраще для прослуховування: браузер його точно розуміє,
        // на відміну від opus у webm-контейнері.
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "-g",
        "--no-warnings",
        "--no-playlist",
        pageUrl,
      ],
      { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const url = out.trim().split("\n").find((l) => l.startsWith("http"));
      if (!url) {
        return rej(new Error(err.trim().split("\n").pop() || "Не вдалося отримати потік"));
      }
      cache.set(pageUrl, { url, expires: expiryOf(url) });
      res(url);
    });
  });
}

module.exports = { resolve };
