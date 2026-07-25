"use strict";
/**
 * Міст із сервісів, звідки завантажити неможливо (Spotify, Apple Music).
 *
 * Там потік захищений DRM — його не віддає ніякий інструмент, і обіцяти
 * інше було б брехнею. Але сама сторінка публічно каже, ЩО це за музика.
 * Тому: з посилання беремо назви й виконавців, а звук шукаємо в YouTube
 * Music. Інтерфейс мусить чесно показати, що джерело звуку інше.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SPOTIFY = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i;
const APPLE = /^https?:\/\/music\.apple\.com\//i;

/** Скільки треків максимум тягнемо зі списку: далі це вже не «пісня», а робота на годину. */
const MAX_ITEMS = 100;

function provider(url) {
  if (SPOTIFY.test(url)) return "spotify";
  if (APPLE.test(url)) return "applemusic";
  return null;
}

const PROVIDER_NAME = { spotify: "Spotify", applemusic: "Apple Music" };

async function getText(url, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fromSpotify(url) {
  const [, kind, id] = url.match(SPOTIFY);
  // Сторінка самого Spotify малюється скриптом і в HTML порожня, а от
  // сторінка вбудованого плеєра віддає всі дані звичайним JSON усередині.
  const html = await getText(`https://open.spotify.com/embed/${kind}/${id}`);
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Spotify не віддав дані про це посилання");

  const e = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!e) throw new Error("Spotify не віддав дані про це посилання");

  const thumb = e.visualIdentity?.image?.slice(-1)[0]?.url || null;

  if (kind === "track") {
    return {
      provider: "spotify",
      kind: "track",
      name: e.name,
      artist: (e.artists || []).map((a) => a.name).join(", "),
      thumb,
      items: [{ title: e.name, artist: (e.artists || [])[0]?.name || "" }],
    };
  }

  const list = (e.trackList || []).slice(0, MAX_ITEMS);
  return {
    provider: "spotify",
    kind,
    name: e.name,
    artist: e.subtitle || "",
    thumb,
    items: list.map((t) => ({
      title: t.title,
      // subtitle — це «Виконавець1, Виконавець2»; для пошуку беремо першого.
      artist: String(t.subtitle || "").split(",")[0].trim(),
    })),
  };
}

async function fromApple(url) {
  const html = await getText(url);
  const og = (p) =>
    (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, "i")) || [])[1] ||
    (html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${p}"`, "i")) || [])[1] ||
    "";

  const decode = (s) =>
    s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  const raw = decode(og("title"));
  // Apple пише заголовок як «Назва by Виконавець on Apple Music».
  const m = raw.match(/^(.*?)\s+by\s+(.*?)\s+on\s+Apple Music$/i);
  const name = m ? m[1] : raw.replace(/\s+on Apple Music$/i, "");
  const artist = m ? m[2] : "";
  if (!name) throw new Error("Apple Music не віддав назву");

  const isAlbum = /music\.album/i.test(og("type"));
  return {
    provider: "applemusic",
    kind: isAlbum ? "album" : "track",
    name,
    artist,
    thumb: decode(og("image")) || null,
    items: [{ title: name, artist }],
  };
}

async function resolve(url) {
  const p = provider(url);
  if (!p) return null;
  const data = p === "spotify" ? await fromSpotify(url) : await fromApple(url);
  data.providerName = PROVIDER_NAME[p];
  return data;
}

module.exports = { provider, resolve, PROVIDER_NAME, MAX_ITEMS };
