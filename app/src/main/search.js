"use strict";
/**
 * Пошук по всіх джерелах і приведення результатів до спільного вигляду.
 *
 * Джерела різні за природою:
 *   YouTube Music — і каталог, і звук (основа);
 *   SoundCloud    — і каталог, і звук, але лише окремі треки;
 *   iTunes        — ЛИШЕ каталог альбомів (звідти качати неможливо);
 *   MusicBrainz   — ЛИШЕ каталог виконавців і їхніх релізів.
 *
 * Результати з iTunes/MusicBrainz не мають посилання на звук. Це навмисно:
 * вони показують, що взагалі існує на світі, а завантаження йде через пошук
 * цього ж альбому в YouTube Music (див. resolveCatalogItem).
 */

const { spawn } = require("child_process");
const binaries = require("./binaries");
const bridge = require("./bridge");

const UA_MB = "MusicGrabber/1.0 ( https://github.com/local/music-grabber )";
const NET_TIMEOUT = 15000;

// ---------------------------------------------------------------- утиліти

/**
 * Усе, що зараз виконується для конкретного пошуку: процеси yt-dlp та
 * контролери мережевих запитів. Потрібно, щоб кнопка «Стоп» справді
 * зупиняла роботу, а не просто ховала результат.
 * @type {Map<string, {procs: Set<any>, ctls: Set<AbortController>, stopped: boolean}>}
 */
const running = new Map();

function begin(id) {
  if (!id) return null;
  const slot = { procs: new Set(), ctls: new Set(), stopped: false };
  running.set(id, slot);
  return slot;
}

function finish(id) {
  running.delete(id);
}

function cancel(id) {
  const slot = running.get(id);
  if (!slot) return false;
  slot.stopped = true;
  for (const ctl of slot.ctls) ctl.abort();
  for (const p of slot.procs) {
    try {
      p.kill();
    } catch {
      /* процес міг уже завершитись */
    }
  }
  running.delete(id);
  return true;
}

function slotOf(id) {
  return id ? running.get(id) : null;
}

/** fetch із тайм-аутом: без нього зависле джерело вішає весь пошук. */
async function getJson(url, opts = {}) {
  const ctl = new AbortController();
  const slot = slotOf(opts.searchId);
  if (slot) slot.ctls.add(ctl);
  const t = setTimeout(() => ctl.abort(), opts.timeout || NET_TIMEOUT);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
    if (slot) slot.ctls.delete(ctl);
  }
}

/** Обкладинки YouTube віддає з розміром у самому URL — просимо більшу. */
function biggestThumb(thumbs) {
  if (!Array.isArray(thumbs) || !thumbs.length) return null;
  const best = thumbs.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
  return (best.url || "").replace(/=w\d+-h\d+/, "=w480-h480");
}

function secs(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

// ---------------------------------------------------------------- yt-dlp

/** Запускає yt-dlp і повертає масив розібраних JSON-рядків. */
function ytdlpJson(args, { timeout = 60000, searchId } = {}) {
  return new Promise((resolve, reject) => {
    const bin = binaries.ytdlp();
    if (!bin) return reject(new Error("yt-dlp не знайдено"));

    const child = spawn(bin.file, [...bin.prefix, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const slot = slotOf(searchId);
    if (slot) slot.procs.add(child);

    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (slot) slot.procs.delete(child);
      if (slot?.stopped) return reject(new Error("Зупинено"));
      const rows = [];
      for (const lineRaw of out.split("\n")) {
        const line = lineRaw.trim();
        if (!line.startsWith("{")) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          /* обірваний рядок — просто пропускаємо */
        }
      }
      if (!rows.length && code !== 0) {
        return reject(new Error(err.trim().split("\n").pop() || `yt-dlp код ${code}`));
      }
      resolve(rows);
    });
  });
}

// ---------------------------------------------------------------- YouTube Music

let _ytm = null;
let _ytmInit = null;

async function ytm() {
  if (_ytm) return _ytm;
  if (!_ytmInit) {
    _ytmInit = (async () => {
      const mod = require("ytmusic-api");
      const YTMusic = mod.default || mod.YTMusic || mod;
      const inst = new YTMusic();
      await inst.initialize();
      _ytm = inst;
      return inst;
    })().catch((e) => {
      _ytmInit = null; // дати шанс наступній спробі
      throw e;
    });
  }
  return _ytmInit;
}

function ytSong(s) {
  return {
    kind: "song",
    source: "ytmusic",
    id: s.videoId,
    url: `https://music.youtube.com/watch?v=${s.videoId}`,
    title: s.name,
    artist: s.artist?.name || "",
    artistId: s.artist?.artistId || null,
    album: s.album?.name || "",
    albumId: s.album?.albumId || null,
    duration: secs(s.duration),
    thumb: biggestThumb(s.thumbnails),
  };
}

function ytAlbum(a) {
  return {
    kind: "album",
    source: "ytmusic",
    id: a.albumId,
    url: a.playlistId ? `https://music.youtube.com/playlist?list=${a.playlistId}` : null,
    playlistId: a.playlistId || null,
    title: a.name,
    artist: a.artist?.name || "",
    artistId: a.artist?.artistId || null,
    year: a.year || null,
    trackCount: null,
    thumb: biggestThumb(a.thumbnails),
  };
}

function ytArtist(a) {
  return {
    kind: "artist",
    source: "ytmusic",
    id: a.artistId,
    name: a.name,
    subtitle: "",
    thumb: biggestThumb(a.thumbnails),
  };
}

// ---------------------------------------------------------------- SoundCloud

async function soundcloud(query, limit = 15, searchId) {
  const rows = await ytdlpJson(
    [`scsearch${limit}:${query}`, "--flat-playlist", "--dump-json", "--no-warnings", "--ignore-errors"],
    { searchId },
  );
  return rows
    .filter((r) => r.url || r.webpage_url)
    .map((r) => {
      // SoundCloud пише «Виконавець - Назва» в title; ріжемо, щоб колонки
      // збігалися з YouTube Music, а не дублювали автора в назві.
      let title = r.title || "";
      const uploader = r.uploader || r.channel || "";
      const dash = title.indexOf(" - ");
      if (dash > 0 && title.slice(0, dash).toLowerCase() === uploader.toLowerCase()) {
        title = title.slice(dash + 3);
      }
      return {
        kind: "song",
        source: "soundcloud",
        id: String(r.id || r.url),
        url: r.webpage_url || r.url,
        title,
        artist: uploader,
        artistId: null,
        album: "",
        albumId: null,
        duration: secs(r.duration),
        thumb: r.thumbnails?.length ? r.thumbnails[r.thumbnails.length - 1].url : r.thumbnail || null,
      };
    });
}

// ---------------------------------------------------------------- iTunes

async function itunesAlbums(query, limit = 12, searchId) {
  const j = await getJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=${limit}`,
    { searchId },
  );
  return (j.results || []).map((a) => ({
    kind: "album",
    source: "itunes",
    id: `itunes:${a.collectionId}`,
    url: null, // з iTunes качати неможливо — потрібен пошук у YouTube Music
    title: a.collectionName,
    artist: a.artistName,
    artistId: null,
    year: a.releaseDate ? Number(a.releaseDate.slice(0, 4)) : null,
    trackCount: a.trackCount || null,
    genre: a.primaryGenreName || "",
    thumb: (a.artworkUrl100 || "").replace("100x100bb", "400x400bb") || null,
  }));
}

// ---------------------------------------------------------------- MusicBrainz

/**
 * Фото виконавця з Deezer.
 *
 * Deezer радо віддає щось на будь-який запит: на «Black Magick SS» він
 * повертає гурт «BLACK MAGICK» — це інший гурт. Показати чуже обличчя гірше,
 * ніж не показати нічого, тому беремо фото ЛИШЕ за точним збігом імені,
 * а в решті випадків інтерфейс намалює аватар з ініціалами.
 */
async function deezerPhoto(name) {
  const want = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!want) return null;
  try {
    const j = await getJson(
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=3`,
      { timeout: 6000 },
    );
    for (const a of j.data || []) {
      const got = String(a.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      if (got === want) return a.picture_big || a.picture_medium || null;
    }
  } catch {
    /* Deezer недоступний — не біда, це лише прикраса */
  }
  return null;
}

async function musicbrainzArtists(query, limit = 8, searchId) {
  const j = await getJson(
    `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`,
    { headers: { "User-Agent": UA_MB }, searchId },
  );
  const artists = (j.artists || []).map((a) => ({
    kind: "artist",
    source: "musicbrainz",
    id: a.id,
    name: a.name,
    subtitle: [a.disambiguation, a.country, a["life-span"]?.begin?.slice(0, 4)]
      .filter(Boolean)
      .join(" · "),
    thumb: null, // сам MusicBrainz фото виконавців не зберігає
  }));

  // Фото шукаємо лише для перших кількох: далі це вже не варте затримки.
  await Promise.all(
    artists.slice(0, 5).map(async (a) => {
      a.thumb = await deezerPhoto(a.name);
    }),
  );
  return artists;
}

/** Повна дискографія з MusicBrainz — там є навіть те, чого нема на YouTube. */
async function musicbrainzReleases(mbid) {
  const j = await getJson(
    `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&type=album|ep&fmt=json&limit=100`,
    { headers: { "User-Agent": UA_MB }, timeout: 25000 },
  );
  const groups = j["release-groups"] || [];
  groups.sort((a, b) => (a["first-release-date"] || "").localeCompare(b["first-release-date"] || ""));
  return groups.map((g) => ({
    kind: "album",
    source: "musicbrainz",
    id: g.id,
    url: null,
    title: g.title,
    artist: "",
    year: g["first-release-date"] ? Number(g["first-release-date"].slice(0, 4)) : null,
    trackCount: null,
    genre: g["primary-type"] || "",
    thumb: `https://coverartarchive.org/release-group/${g.id}/front-250`,
  }));
}

// ---------------------------------------------------------------- посилання

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s.trim());
}

/** Розкриває будь-яке посилання (YouTube, SoundCloud, Bandcamp…) у список треків. */
async function resolveUrl(url, searchId) {
  begin(searchId);
  let rows;
  try {
    rows = await ytdlpJson(
      ["--flat-playlist", "--dump-single-json", "--no-warnings", "--ignore-errors", url],
      { timeout: 90000, searchId },
    );
  } finally {
    finish(searchId);
  }
  const info = rows[0];
  if (!info) throw new Error("Не вдалося прочитати посилання");

  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : null;
  const list = entries || [info];

  const songs = list.map((e) => ({
    kind: "song",
    source: "url",
    id: String(e.id || e.url),
    url: e.webpage_url || e.url || url,
    title: e.track || e.title || "?",
    artist: e.artist || e.uploader || e.channel || info.uploader || "",
    artistId: null,
    album: e.album || (entries ? info.title : "") || "",
    albumId: null,
    duration: secs(e.duration),
    thumb: e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1].url : e.thumbnail || null,
  }));

  return { title: info.title || url, songs };
}

// ---------------------------------------------------------------- рекомендації

/** «2:18» -> 138. У радіо тривалість приходить рядком, а не числом. */
function mmss(s) {
  if (typeof s === "number") return secs(s);
  const p = String(s || "").split(":").map(Number);
  if (p.length === 2 && p.every(Number.isFinite)) return p[0] * 60 + p[1];
  if (p.length === 3 && p.every(Number.isFinite)) return p[0] * 3600 + p[1] * 60 + p[2];
  return null;
}

/**
 * Радіо за треком — власна черга рекомендацій YouTube Music.
 *
 * Формат тут інший, ніж у пошуку: artists приходить одним рядком, duration —
 * як «2:18», а thumbnail одиничним посиланням. Тому окремий перетворювач.
 */
async function radio(videoId) {
  const y = await ytm();
  const list = await y.getUpNexts(videoId);
  return (list || [])
    .filter((t) => t.videoId)
    .map((t) => ({
      kind: "song",
      source: "ytmusic",
      id: t.videoId,
      url: `https://music.youtube.com/watch?v=${t.videoId}`,
      title: t.title || t.name || "?",
      artist: typeof t.artists === "string" ? t.artists : t.artists?.[0]?.name || "",
      artistId: null,
      album: "",
      albumId: null,
      duration: mmss(t.duration),
      thumb: (t.thumbnail || "").replace(/=w\d+-h\d+/, "=w480-h480") || null,
    }));
}

/** Головна YouTube Music: добірки, чарти, локальні хіти. */
async function home() {
  const y = await ytm();
  const sections = await y.getHomeSections();
  return (sections || [])
    .map((s) => ({
      title: s.title,
      items: (s.contents || s.items || [])
        .filter((i) => i && (i.playlistId || i.albumId || i.videoId))
        .map((i) => ({
          kind: i.videoId ? "song" : "mix",
          source: "ytmusic",
          id: i.playlistId || i.albumId || i.videoId,
          playlistId: i.playlistId || null,
          albumId: i.albumId || null,
          videoId: i.videoId || null,
          url: i.videoId ? `https://music.youtube.com/watch?v=${i.videoId}` : null,
          title: i.name || i.title || "?",
          artist: i.artist?.name || (typeof i.artists === "string" ? i.artists : "") || "",
          thumb: biggestThumb(i.thumbnails) || i.thumbnail || null,
        })),
    }))
    .filter((s) => s.items.length);
}

/**
 * Треки добірки з головної.
 *
 * Головна складається з авто-міксів з ідентифікаторами виду RDCLAK5uy_…, і
 * на них ytmusic-api відповідає 400 усіма трьома методами (перевірено). Такі
 * списки читає yt-dlp, тож він тут запасний — повільніший, зате працює.
 */
async function mixTracks(playlistId) {
  try {
    const y = await ytm();
    const list = await y.getPlaylistVideos(playlistId);
    const mapped = (list || [])
      .filter((t) => t.videoId)
      .map((t) => ({
        kind: "song",
        source: "ytmusic",
        id: t.videoId,
        url: `https://music.youtube.com/watch?v=${t.videoId}`,
        title: t.name || t.title || "?",
        artist: t.artist?.name || (typeof t.artists === "string" ? t.artists : "") || "",
        artistId: t.artist?.artistId || null,
        album: "",
        albumId: null,
        duration: mmss(t.duration),
        thumb: biggestThumb(t.thumbnails) || t.thumbnail || null,
      }));
    if (mapped.length) return mapped;
  } catch {
    /* нижче спробуємо через yt-dlp */
  }

  const rows = await ytdlpJson(
    [
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      "--ignore-errors",
      `https://music.youtube.com/playlist?list=${playlistId}`,
    ],
    { timeout: 90000 },
  );
  return rows
    .filter((e) => e.id && String(e.id).length === 11)
    .map((e) => ({
      kind: "song",
      source: "ytmusic",
      id: e.id,
      url: `https://music.youtube.com/watch?v=${e.id}`,
      title: e.track || e.title || "?",
      artist: e.artist || e.uploader || e.channel || "",
      artistId: null,
      album: e.album || "",
      albumId: null,
      duration: secs(e.duration),
      thumb: e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1].url : e.thumbnail || null,
    }));
}

/** Текст пісні; порожньо — нормальний результат для інструменталу. */
async function lyrics(videoId) {
  const y = await ytm();
  try {
    const l = await y.getLyrics(videoId);
    const text = Array.isArray(l) ? l.join("\n") : String(l ?? "");
    return text.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- міст Spotify/Apple

/** Виконує завдання пачками по `limit` — 50 запитів разом YouTube не любить. */
async function inBatches(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

const normTitle = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\((feat|ft)\.?[^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Бере посилання зі Spotify/Apple Music і повертає ті самі треки, але знайдені
 * в YouTube Music. Те, чого там немає, повертаємо з позначкою — мовчки
 * викидати треки зі списку не можна, інакше «альбом на 12 пісень» тихо
 * перетворюється на 9 і ніхто не розуміє чому.
 */
async function resolveBridge(url, searchId) {
  begin(searchId);
  try {
    const meta = await bridge.resolve(url);
    if (!meta) throw new Error("Це посилання не з підтримуваного сервісу");

    const y = await ytm();
    const songs = await inBatches(meta.items, 5, async (it) => {
      const slot = running.get(searchId);
      if (searchId && (!slot || slot.stopped)) return null;

      let found = [];
      try {
        found = await y.searchSongs(`${it.artist} ${it.title}`.trim());
      } catch {
        /* один невдалий запит не має валити весь список */
      }
      const want = normTitle(it.title);
      const hit =
        found.find((s) => normTitle(s.name) === want) ||
        found.find((s) => normTitle(s.name).includes(want) || want.includes(normTitle(s.name))) ||
        found[0];

      if (!hit) {
        return {
          kind: "song",
          source: "bridge",
          id: `miss:${it.artist}:${it.title}`,
          url: null,
          title: it.title,
          artist: it.artist,
          album: "",
          duration: null,
          thumb: null,
          missing: true,
        };
      }
      return { ...ytSong(hit), bridgedFrom: meta.providerName };
    });

    const slot = running.get(searchId);
    if (searchId && (!slot || slot.stopped)) {
      const err = new Error("Зупинено");
      err.stopped = true;
      throw err;
    }

    const list = songs.filter(Boolean);
    return {
      meta,
      songs: list,
      missing: list.filter((s) => s.missing).length,
    };
  } finally {
    finish(searchId);
  }
}

// ---------------------------------------------------------------- головне

/**
 * Шукає всюди паралельно. Джерело, яке впало або відповіло надто довго,
 * не має права зламати весь пошук — тому allSettled і збір помилок окремо.
 */
async function searchAll(query, sources, searchId) {
  const use = (name) => !sources || sources.includes(name);
  const errors = [];
  begin(searchId);

  const tasks = {
    ytSongs: use("ytmusic") ? ytm().then((y) => y.searchSongs(query)) : null,
    ytAlbums: use("ytmusic") ? ytm().then((y) => y.searchAlbums(query)) : null,
    ytArtists: use("ytmusic") ? ytm().then((y) => y.searchArtists(query)) : null,
    sc: use("soundcloud") ? soundcloud(query, 15, searchId) : null,
    it: use("itunes") ? itunesAlbums(query, 12, searchId) : null,
    mb: use("musicbrainz") ? musicbrainzArtists(query, 8, searchId) : null,
  };

  const keys = Object.keys(tasks).filter((k) => tasks[k]);
  const done = await Promise.allSettled(keys.map((k) => tasks[k]));

  const slot = running.get(searchId);
  const wasStopped = Boolean(slot?.stopped) || (searchId && !slot);
  finish(searchId);
  if (wasStopped) {
    const err = new Error("Зупинено");
    err.stopped = true;
    throw err;
  }

  const got = {};
  keys.forEach((k, i) => {
    if (done[i].status === "fulfilled") {
      got[k] = done[i].value;
    } else {
      got[k] = [];
      errors.push(`${k}: ${done[i].reason?.message || done[i].reason}`);
    }
  });

  const songs = [...(got.ytSongs || []).map(ytSong), ...(got.sc || [])];

  // Альбом, що є і в YouTube Music, і в iTunes, показуємо один раз —
  // лишаємо версію з YouTube Music, бо тільки її можна одразу завантажити.
  const albums = (got.ytAlbums || []).map(ytAlbum);
  const seen = new Set(albums.map((a) => `${a.artist}|${a.title}`.toLowerCase()));
  for (const a of got.it || []) {
    const key = `${a.artist}|${a.title}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      albums.push(a);
    }
  }

  const artists = [...(got.ytArtists || []).map(ytArtist), ...(got.mb || [])];

  return { songs, albums, artists, errors };
}

async function getAlbum(albumId) {
  const y = await ytm();
  const a = await y.getAlbum(albumId);
  return {
    kind: "album",
    source: "ytmusic",
    id: a.albumId,
    title: a.name,
    artist: a.artist?.name || "",
    artistId: a.artist?.artistId || null,
    year: a.year || null,
    playlistId: a.playlistId || null,
    url: a.playlistId ? `https://music.youtube.com/playlist?list=${a.playlistId}` : null,
    thumb: biggestThumb(a.thumbnails),
    songs: (a.songs || []).map((s) => ({
      ...ytSong(s),
      album: a.name,
      albumId: a.albumId,
      // У треках всередині альбому YouTube часто не дублює обкладинку —
      // підставляємо альбомну, інакше в списку зяють порожні квадрати.
      thumb: biggestThumb(s.thumbnails) || biggestThumb(a.thumbnails),
    })),
  };
}

async function getArtist(artistId) {
  const y = await ytm();
  const a = await y.getArtist(artistId);
  return {
    kind: "artist",
    source: "ytmusic",
    id: a.artistId,
    name: a.name,
    thumb: biggestThumb(a.thumbnails),
    description: a.description || "",
    topSongs: (a.topSongs || []).map(ytSong),
    albums: (a.topAlbums || []).map(ytAlbum),
    singles: (a.topSingles || []).map(ytAlbum),
    similar: (a.similarArtists || []).map(ytArtist),
  };
}

/**
 * Каталожний результат (iTunes/MusicBrainz) не має звуку. Шукаємо той самий
 * альбом у YouTube Music і повертаємо його, якщо назва справді збігається.
 */
async function resolveCatalogItem(item) {
  const q = `${item.artist || ""} ${item.title}`.trim();
  const y = await ytm();
  const found = await y.searchAlbums(q);
  const want = item.title.toLowerCase().replace(/\s+/g, " ").trim();

  const hit =
    found.find((a) => a.name.toLowerCase().replace(/\s+/g, " ").trim() === want) ||
    found.find((a) => a.name.toLowerCase().includes(want)) ||
    null;

  if (!hit) return null;
  return getAlbum(hit.albumId);
}

module.exports = {
  cancel,
  radio,
  home,
  mixTracks,
  lyrics,
  searchAll,
  resolveBridge,
  bridgeProvider: bridge.provider,
  getAlbum,
  getArtist,
  resolveCatalogItem,
  musicbrainzReleases,
  resolveUrl,
  looksLikeUrl,
};
