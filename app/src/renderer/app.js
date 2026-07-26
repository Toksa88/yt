"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const mainEl = $("#main");
const audio = $("#audio");

const state = {
  page: "search",
  tab: "songs",
  results: { songs: [], albums: [], artists: [] },
  view: { type: "empty" },
  /** ключ -> об'єкт треку; Map, бо порядок вибору має значення */
  picked: new Map(),
  settings: { outDir: "", format: "m4a", watchClipboard: true, volume: 0.8 },
  jobs: new Map(),
  /** null або ідентифікатор пошуку, що зараз виконується (для «Стоп») */
  searchId: null,
  library: { dir: "", tracks: [], missing: false, loaded: false, loading: false },
  /** шляхи файлів, обраних у Сховищі для правки тегів */
  libPicked: new Set(),
  playlists: [],
  /** відкритий плейлист або null */
  openPl: null,
  /** черга відтворення: список треків і місце в ньому */
  pq: { list: [], i: -1 },
  /** ключі «виконавець|назва» того, що вже лежить на диску */
  owned: new Set(),
  playing: null,
};

// ------------------------------------------------------------------ дрібниці

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function dur(sec) {
  if (!sec && sec !== 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function speedStr(bytesPerSec) {
  if (!bytesPerSec) return "";
  const mb = bytesPerSec / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} МБ/с` : `${(bytesPerSec / 1024).toFixed(0)} КБ/с`;
}

function mbStr(bytes) {
  return `${(bytes / 1048576).toFixed(1)} МБ`;
}

/**
 * Українська множина: 1 трек, 2 треки, 5 треків.
 * @param {number} n
 * @param {[string, string, string]} forms — [один, два-чотири, багато]
 */
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${n} ${forms[2]}`;
  if (b === 1) return `${n} ${forms[0]}`;
  if (b >= 2 && b <= 4) return `${n} ${forms[1]}`;
  return `${n} ${forms[2]}`;
}

const TRACKS = ["трек", "треки", "треків"];
const FILES = ["файл", "файли", "файлів"];

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const ownKey = (artist, title) => `${norm(artist)}|${norm(title)}`;

function keyOf(it) {
  return `${it.source}:${it.id}`;
}

const SRC_NAME = {
  ytmusic: "YT Music",
  soundcloud: "SoundCloud",
  itunes: "iTunes",
  musicbrainz: "MusicBrainz",
  url: "посилання",
  bridge: "не знайдено",
};

function badge(src) {
  return `<span class="badge ${esc(src)}">${esc(SRC_NAME[src] || src)}</span>`;
}

/** Порожня картинка замість битого посилання (обкладинок часто просто немає). */
const BLANK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="%2322222f"/><text x="32" y="41" font-size="26" text-anchor="middle" fill="%236a6a85">♫</text></svg>`,
  );

function img(url, cls, extra = "") {
  return `<img class="${cls}" src="${esc(url || BLANK)}" alt="" ${extra} />`;
}

/**
 * Аватар з ініціалів — для виконавців, чийого фото немає (MusicBrainz його не
 * зберігає взагалі). Раніше на їхньому місці було просто чорне тло.
 * Колір виводимо з самого імені, щоб він був стабільним між запусками.
 */
function avatar(name) {
  const text = String(name || "?").trim();
  const initials = text
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] || "")
    .join("")
    .toUpperCase();

  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hash % 360;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 55% 42%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 48) % 360} 55% 26%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="120" height="120" fill="url(#g)"/>` +
    `<text x="60" y="60" fill="#fff" fill-opacity="0.92" font-family="Segoe UI, sans-serif"` +
    ` font-size="46" font-weight="600" text-anchor="middle" dominant-baseline="central">` +
    `${esc(initials)}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/** Локальний файл для тега <audio>: шлях Windows треба зробити валідним URL. */
function fileUrl(p) {
  return "file:///" + encodeURI(String(p).replace(/\\/g, "/")).replace(/#/g, "%23");
}

function loading(text) {
  mainEl.innerHTML = `<div class="empty"><div class="spinner"></div><p>${esc(text)}</p></div>`;
}

function fail(text) {
  mainEl.innerHTML = `<div class="note err">${esc(text)}</div>`;
}

let toastTimer = null;
function toast(text, actions = [], ms = 9000) {
  $("#toastText").textContent = text;
  $("#toastActs").innerHTML = actions
    .map((a, i) => `<button data-toast="${i}" class="${a.primary ? "primary" : "ghost"}">${esc(a.label)}</button>`)
    .join("");
  $("#toastActs").onclick = (e) => {
    const b = e.target.closest("[data-toast]");
    if (!b) return;
    hideToast();
    actions[Number(b.dataset.toast)].run();
  };
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").hidden = true;
}

// ------------------------------------------------------------------ спільні шматки

/** Реєстр усього, що зараз намальовано — щоб клік знав, з чим має справу. */
const index = new Map();

function reindex(...lists) {
  for (const list of lists) for (const it of list || []) if (it) index.set(keyOf(it), it);
}

function songRow(s) {
  const k = keyOf(s);
  const on = state.picked.has(k);
  const owned = state.owned.has(ownKey(s.artist, s.title));
  const dead = s.missing || !s.url;
  return `
    <div class="row${on ? " sel" : ""}${dead ? " dim" : ""}" data-key="${esc(k)}">
      <input type="checkbox" data-act="pick" ${on ? "checked" : ""} ${dead ? "disabled" : ""} />
      ${img(s.thumb, "art")}
      <div class="name">
        <b>${esc(s.title)}${badge(s.missing ? "bridge" : s.source)}${owned ? `<span class="badge owned">вже є</span>` : ""}</b>
        <span class="sub">${esc(s.artist)}</span>
      </div>
      <div class="alb">${esc(s.album || "")}</div>
      <div class="dur">${dur(s.duration)}</div>
      <div class="act">
        ${dead ? "" : `<button data-act="listen" class="ghost" title="Послухати не завантажуючи">▶</button>`}
        ${dead ? "" : `<button data-act="dl-one" class="primary">ЗАБИРАЮ!</button>`}
      </div>
    </div>`;
}

function albumCard(a) {
  return `
    <div class="card" data-act="open-album" data-key="${esc(keyOf(a))}">
      ${img(a.thumb, "cover")}
      <div class="t">${esc(a.title)}</div>
      <div class="s">${esc([a.artist, a.year, a.trackCount ? a.trackCount + " тр." : ""].filter(Boolean).join(" · "))}</div>
      <div class="s">${badge(a.source)}</div>
    </div>`;
}

function artistCard(a) {
  return `
    <div class="card round" data-act="open-artist" data-key="${esc(keyOf(a))}">
      ${img(a.thumb || avatar(a.name), "cover")}
      <div class="t">${esc(a.name)}</div>
      <div class="s">${esc(a.subtitle || "")}</div>
      <div class="s">${badge(a.source)}</div>
    </div>`;
}

// ------------------------------------------------------------------ сторінка «Шукач»

function renderResults() {
  const r = state.results;
  reindex(r.songs, r.albums, r.artists);

  $("#tabs").hidden = false;
  $$(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === state.tab);
    t.querySelector(".cnt").textContent = r[t.dataset.tab].length;
  });

  const list = r[state.tab];
  const head = state.results.note ? `<div class="note info">${esc(state.results.note)}</div>` : "";

  if (!list.length) {
    mainEl.innerHTML =
      head + `<div class="empty"><div class="empty-ico">∅</div><p>Тут нічого не знайшлося. Спробуй іншу вкладку або інший запит.</p></div>`;
    return;
  }

  if (state.tab === "songs") mainEl.innerHTML = head + `<div class="rows">${list.map(songRow).join("")}</div>`;
  else if (state.tab === "albums") mainEl.innerHTML = head + `<div class="grid">${list.map(albumCard).join("")}</div>`;
  else mainEl.innerHTML = head + `<div class="grid">${list.map(artistCard).join("")}</div>`;
}

function renderAlbum(a) {
  reindex(a.songs, [a]);
  $("#tabs").hidden = true;
  const canGrab = Boolean(a.url);

  mainEl.innerHTML = `
    <button class="ghost back" data-act="back">← Назад</button>
    <div class="detail-head">
      ${img(a.thumb, "cover")}
      <div class="meta">
        <div class="sub">Альбом ${badge(a.source)}</div>
        <h1>${esc(a.title)}</h1>
        <div class="sub">${esc([a.artist, a.year, plural(a.songs.length, TRACKS)].filter(Boolean).join(" · "))}</div>
        <div class="btns">
          <button class="primary" data-act="dl-album" data-key="${esc(keyOf(a))}" ${canGrab ? "" : "disabled"}>
            ЗАБИРАЮ ВЕСЬ АЛЬБОМ!
          </button>
          <button class="ghost" data-act="pick-all">Вибрати всі треки</button>
          ${a.artistId ? `<button class="ghost" data-act="open-artist-id" data-id="${esc(a.artistId)}">Виконавець</button>` : ""}
        </div>
      </div>
    </div>
    ${canGrab ? "" : `<div class="note">Цей альбом знайдено лише в каталозі — прямого джерела звуку немає.</div>`}
    <div class="rows">${a.songs.map(songRow).join("")}</div>`;
}

function renderArtist(a) {
  reindex(a.topSongs, a.albums, a.singles, a.similar);
  $("#tabs").hidden = true;
  const sec = (title, html) => (html ? `<h3 class="sec">${title}</h3>${html}` : "");
  const grid = (items) => (items?.length ? `<div class="grid">${items.map(albumCard).join("")}</div>` : "");

  mainEl.innerHTML = `
    <button class="ghost back" data-act="back">← Назад</button>
    <div class="detail-head artist">
      ${img(a.thumb || avatar(a.name), "cover")}
      <div class="meta">
        <div class="sub">Виконавець ${badge(a.source)}</div>
        <h1>${esc(a.name)}</h1>
        <div class="btns"><button class="ghost" data-act="pick-all">Вибрати популярні треки</button></div>
      </div>
    </div>
    ${sec("Популярні треки", a.topSongs?.length ? `<div class="rows">${a.topSongs.map(songRow).join("")}</div>` : "")}
    ${sec("Альбоми", grid(a.albums))}
    ${sec("Сингли та EP", grid(a.singles))}
    ${sec("Схожі виконавці", a.similar?.length ? `<div class="grid">${a.similar.map(artistCard).join("")}</div>` : "")}`;
}

function renderCatalogArtist(a, releases) {
  reindex(releases);
  $("#tabs").hidden = true;
  mainEl.innerHTML = `
    <button class="ghost back" data-act="back">← Назад</button>
    <div class="detail-head artist">
      ${img(a.thumb || avatar(a.name), "cover")}
      <div class="meta">
        <div class="sub">Виконавець ${badge(a.source)}</div>
        <h1>${esc(a.name)}</h1>
        <div class="sub">${esc(a.subtitle || "")}</div>
      </div>
    </div>
    <div class="note">Дискографія з каталогу MusicBrainz — вона повніша за YouTube, але сам звук треба знайти. Клікни на альбом, і додаток пошукає його в YouTube&nbsp;Music.</div>
    ${releases.length ? `<div class="grid">${releases.map(albumCard).join("")}</div>` : `<div class="note">Релізів не знайдено.</div>`}`;
}

// ------------------------------------------------------------------ сторінка «Черга»

function jobRow(j) {
  const pct = Math.round(j.percent || 0);
  const eq = `<span class="eq"><i></i><i></i><i></i><i></i></span>`;
  let barCls = "";
  let note = "";

  if (j.status === "done") {
    barCls = "done";
    note = `<small class="ok">Готово · ${plural(j.files.length, FILES)}</small>`;
  } else if (j.status === "error") {
    barCls = "err";
    note = `<small class="err">${esc(j.error || "помилка")}</small>`;
  } else if (j.status === "canceled") {
    note = `<small>Скасовано</small>`;
  } else if (j.status === "retrying") {
    barCls = "err";
    note = `<small class="warn">${esc(j.error || "збій")} — чекаю і пробую ще раз…</small>`;
  } else if (j.status === "queued") {
    note = `<small>У черзі…</small>`;
  } else {
    const parts = [];
    if (j.total > 1) parts.push(`трек ${j.index || 1} з ${j.total}`);
    if (j.attempt) parts.push(`спроба ${j.attempt + 1}`);
    if (j.phase === "process") parts.push("обробка: обкладинка й теги");
    else if (j.speed) parts.push(speedStr(j.speed));
    note = `<small>${eq}${esc(parts.join(" · ") || "починаю…")}</small>`;
  }

  const acts = [];
  if (["active", "queued", "retrying"].includes(j.status))
    acts.push(`<button data-jact="cancel" data-id="${j.id}">Стоп</button>`);
  if (j.status === "error" || j.status === "canceled")
    acts.push(`<button data-jact="retry" data-id="${j.id}">Ще раз</button>`);
  if (j.status === "done" && j.files[0])
    acts.push(`<button data-jact="reveal" data-id="${j.id}">Показати</button>`);

  return `
    <div class="job" data-id="${j.id}">
      ${img(j.thumb, "art")}
      <div class="jn"><b>${esc(j.title)}</b>${note}</div>
      <div class="bar ${barCls}"><i data-w="${j.status === "queued" ? 0 : pct}"></i></div>
      <div class="jact">${acts.join("")}</div>
    </div>`;
}

function renderQueue() {
  $("#tabs").hidden = true;
  const list = [...state.jobs.values()].reverse();
  mainEl.innerHTML = `
    <div class="qhead">
      <h1>Черга</h1>
      <span class="grow"></span>
      <button class="ghost" id="qOpen">Відкрити теку</button>
      <button class="ghost" id="qClear">Прибрати завершені</button>
    </div>
    ${list.length ? list.map(jobRow).join("") : `<div class="note">Черга порожня. Знайди щось у Шукачі й тисни «ЗАБИРАЮ!».</div>`}`;
  applyBars();
}

/** Ширину смужок задаємо через CSSOM: атрибут style блокує наша ж CSP. */
function applyBars() {
  for (const bar of mainEl.querySelectorAll(".bar > i")) bar.style.width = bar.dataset.w + "%";
}

function refreshQueueBadge() {
  const busy = [...state.jobs.values()].filter((j) =>
    ["active", "queued", "retrying"].includes(j.status),
  ).length;
  const badgeEl = $("#navQueue");
  badgeEl.hidden = state.jobs.size === 0;
  badgeEl.textContent = busy || state.jobs.size;
  $("#netbar").hidden = busy === 0;
}

// ------------------------------------------------------------------ сторінка «Сховище»

function libRow(t) {
  const isPlaying = state.playing?.path === t.path;
  const on = state.libPicked.has(t.path);
  return `
    <div class="row${isPlaying ? " playing" : ""}${on ? " sel" : ""}" data-path="${esc(t.path)}">
      <input type="checkbox" data-lact="pick" ${on ? "checked" : ""} />
      ${img(null, "art", `data-cover="${esc(t.path)}"`)}
      <div class="name">
        <b>${esc(t.title)}</b>
        <span class="sub">${esc(t.artist || "невідомий виконавець")}${
          t.bitrate ? `<span class="badge url">${t.ext} ${t.bitrate} kb/s</span>` : ""
        }</span>
      </div>
      <div class="alb">${esc(t.album || "")}</div>
      <div class="dur">${dur(t.duration)}</div>
      <div class="act">
        <button data-lact="play" class="primary">${isPlaying && !audio.paused ? "❚❚" : "▶"}</button>
        <button data-lact="tags" class="ghost">Теги</button>
        <button data-lact="reveal" class="ghost">Показати</button>
        <button data-lact="trash" class="ghost danger">У кошик</button>
      </div>
    </div>`;
}

function renderLibrary() {
  $("#tabs").hidden = true;
  const L = state.library;

  if (L.loading) return loading("Читаю теги з файлів…");

  const head = `
    <div class="libhead">
      <h1>Сховище</h1>
      <span class="grow"></span>
      <button class="ghost" id="libRescan">Оновити</button>
      <button class="ghost" id="libOpen">Відкрити теку</button>
    </div>
    <div class="libhead"><span class="path">${esc(L.dir)}</span></div>`;

  if (L.missing) {
    mainEl.innerHTML = head + `<div class="note err">Теки не існує. Обери іншу в Налаштуваннях.</div>`;
    return;
  }
  if (!L.tracks.length) {
    mainEl.innerHTML =
      head + `<div class="note">Тут поки порожньо. Усе, що завантажиш, з'явиться в цьому списку.</div>`;
    return;
  }

  const total = L.tracks.reduce((a, t) => a + t.size, 0);
  mainEl.innerHTML =
    head +
    `<div class="note">${plural(L.tracks.length, TRACKS)} · ${mbStr(total)}</div>` +
    `<div class="rows">${L.tracks.map(libRow).join("")}</div>`;
  loadCovers();
}

/** Обкладинки тягнемо лише для видимих рядків: інакше сотня файлів = сотня читань. */
let coverObserver = null;
function loadCovers() {
  coverObserver?.disconnect();
  coverObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        coverObserver.unobserve(el);
        const p = el.dataset.cover;
        window.api
          .libCover(p)
          .then((uri) => {
            if (uri) el.src = uri;
          })
          .catch(() => {});
      }
    },
    { root: mainEl, rootMargin: "200px" },
  );
  for (const el of mainEl.querySelectorAll("[data-cover]")) coverObserver.observe(el);
}

async function loadLibrary(force = false) {
  const L = state.library;
  if (L.loading) return;
  if (L.loaded && !force) return;
  L.loading = true;
  if (state.page === "library") render();

  try {
    const r = await window.api.libScan(state.settings.outDir);
    L.dir = r.dir;
    L.tracks = r.tracks;
    L.missing = r.missing;
    L.loaded = true;
    state.owned = new Set(r.tracks.map((t) => ownKey(t.artist, t.title)));
  } catch (e) {
    L.tracks = [];
    L.missing = true;
    L.error = e.message;
  } finally {
    L.loading = false;
    if (state.page === "library") render();
  }
}

// ------------------------------------------------------------------ сторінка «Плейлисти»

/** Плейлист зберігає шляхи; самі треки беремо зі Сховища. */
function plTracks(pl) {
  return (pl?.tracks || [])
    .map((p) => state.library.tracks.find((t) => t.path === p))
    .filter(Boolean);
}

function renderPlaylists() {
  $("#tabs").hidden = true;

  if (state.openPl) {
    const pl = state.playlists.find((p) => p.id === state.openPl);
    if (!pl) {
      state.openPl = null;
      return renderPlaylists();
    }
    const tracks = plTracks(pl);
    const lost = pl.tracks.length - tracks.length;

    mainEl.innerHTML = `
      <button class="ghost back" data-plact="back">← Усі плейлисти</button>
      <div class="libhead">
        <h1>${esc(pl.name)}</h1>
        <span class="grow"></span>
        <button class="primary" data-plact="playall" ${tracks.length ? "" : "disabled"}>▶ Слухати все</button>
        <button class="ghost" data-plact="rename" data-id="${esc(pl.id)}">Перейменувати</button>
        <button class="ghost danger" data-plact="delete" data-id="${esc(pl.id)}">Видалити</button>
      </div>
      <div class="note">${plural(tracks.length, TRACKS)}${
        lost ? ` · ${plural(lost, ["файл не знайдено", "файли не знайдено", "файлів не знайдено"])}` : ""
      }</div>
      ${
        tracks.length
          ? `<div class="rows">${tracks.map((t) => plTrackRow(t, pl.id)).join("")}</div>`
          : `<div class="note">Порожньо. Вибери треки у Сховищі й тисни «У плейлист».</div>`
      }`;
    loadCovers();
    return;
  }

  mainEl.innerHTML = `
    <div class="libhead">
      <h1>Плейлисти</h1>
      <span class="grow"></span>
      <button class="primary" data-plact="new">Створити плейлист</button>
    </div>
    ${
      state.playlists.length
        ? state.playlists
            .map(
              (p) => `
      <div class="plcard">
        <div class="pic">☰</div>
        <div class="who" data-plact="open" data-id="${esc(p.id)}">
          <b>${esc(p.name)}</b>
          <small>${plural(p.tracks.length, TRACKS)}</small>
        </div>
        <div class="pact">
          <button class="primary" data-plact="playpl" data-id="${esc(p.id)}" ${p.tracks.length ? "" : "disabled"}>▶</button>
          <button class="ghost" data-plact="rename" data-id="${esc(p.id)}">Перейменувати</button>
          <button class="ghost danger" data-plact="delete" data-id="${esc(p.id)}">Видалити</button>
        </div>
      </div>`,
            )
            .join("")
        : `<div class="note">Плейлистів ще немає. Створи перший — або вибери треки у Сховищі й тисни «У плейлист».</div>`
    }`;
}

function plTrackRow(t, plId) {
  const isPlaying = state.playing?.path === t.path;
  return `
    <div class="row${isPlaying ? " playing" : ""}" data-path="${esc(t.path)}">
      <span></span>
      ${img(null, "art", `data-cover="${esc(t.path)}"`)}
      <div class="name">
        <b>${esc(t.title)}</b>
        <span class="sub">${esc(t.artist || "невідомий виконавець")}</span>
      </div>
      <div class="alb">${esc(t.album || "")}</div>
      <div class="dur">${dur(t.duration)}</div>
      <div class="act">
        <button data-lact="play" class="primary">${isPlaying && !audio.paused ? "❚❚" : "▶"}</button>
        <button data-plact="drop" data-id="${esc(plId)}" class="ghost">Прибрати</button>
      </div>
    </div>`;
}

async function loadPlaylists() {
  state.playlists = await window.api.plList();
}

function openPlModal(paths) {
  if (!paths.length) return;
  $("#plModalCount").textContent = `Обрано ${plural(paths.length, TRACKS)}`;
  $("#plModalList").innerHTML = state.playlists.length
    ? state.playlists
        .map(
          (p) => `<div class="plrow" data-pladd="${esc(p.id)}">
            <b>${esc(p.name)}</b><small>${plural(p.tracks.length, TRACKS)}</small></div>`,
        )
        .join("")
    : `<div class="mnote">Плейлистів ще немає — створи нижче.</div>`;
  $("#plNewName").value = "";
  $("#plModal").hidden = false;
  $("#plModal").dataset.paths = JSON.stringify(paths);
}

// ------------------------------------------------------------------ сторінка «Налаштування»

function renderSettings() {
  $("#tabs").hidden = true;
  const s = state.settings;
  mainEl.innerHTML = `
    <div class="settings">
      <h1 class="page">Налаштування</h1>

      <div class="set">
        <h4>Куди зберігати</h4>
        <p>Сюди складається все завантажене; звідси ж читається Сховище.</p>
        <div class="ctl">
          <button class="ghost" id="folderBtn" title="${esc(s.outDir)}">📁 <span id="folderName">${esc(s.outDir)}</span></button>
        </div>
      </div>

      <div class="set">
        <h4>Формат файлу</h4>
        <p>
          Джерела віддають лише стиснутий звук — lossless там немає взагалі, тому FLAC у списку
          відсутній: він зробив би файл утричі більшим без жодного виграшу в якості.
        </p>
        <p>
          <b>OPUS</b> — найкраще, що дає YouTube (близько 155&nbsp;kb/s), без перекодування.
          Але це молодий формат: Android і комп'ютер його грають, а старі магнітоли та iPhone — ні.<br />
          <b>M4A</b> — теж без перекодування, але потік слабший (близько 130&nbsp;kb/s). Грає скрізь.<br />
          <b>MP3&nbsp;320</b> — єдиний варіант із перекодуванням: mp3 у джерелах не існує, тож це
          ще одне стиснення поверх стиснутого. Варто брати лише заради дуже старої техніки.
        </p>
        <div class="ctl">
          <select id="format">
            <option value="m4a"${s.format === "m4a" ? " selected" : ""}>M4A — грає скрізь (рекомендовано)</option>
            <option value="opus"${s.format === "opus" ? " selected" : ""}>OPUS — найкраща якість</option>
            <option value="mp3"${s.format === "mp3" ? " selected" : ""}>MP3 320 — для старої техніки</option>
          </select>
        </div>
      </div>

      <div class="set">
        <h4>Окрема тека для альбому</h4>
        <p>Коли завантажуєш цілий альбом, його треки складаються у власну теку з назвою альбому.</p>
        <div class="ctl">
          <label class="switch">
            <input type="checkbox" id="albumFolder" ${s.albumFolder ? "checked" : ""} />
            Класти альбом в окрему теку
          </label>
        </div>
      </div>

      <div class="set">
        <h4>Показувати в Discord, що слухаєш</h4>
        <p>
          Discord показує назву <b>зареєстрованого додатка</b>, а не заголовок нашого вікна,
          тому потрібен власний ID. Це безкоштовно й на дві хвилини:
          відкрий <b>discord.com/developers/applications</b> → <b>New Application</b> →
          назви його як хочеш (саме цю назву й побачать друзі) → на вкладці
          <b>General Information</b> скопіюй <b>Application ID</b> і встав сюди.
          Discord має бути запущений.
        </p>
        <div class="ctl">
          <label class="switch">
            <input type="checkbox" id="discordOn" ${s.discordEnabled ? "checked" : ""} />
            Увімкнути
          </label>
        </div>
        <div class="ctl spaced">
          <input type="text" id="discordId" class="wide" placeholder="Application ID (18–19 цифр)"
                 value="${esc(s.discordAppId || "")}" spellcheck="false" />
          <button class="ghost" id="discordTest">Перевірити</button>
        </div>
        <div class="mnote" id="discordMsg"></div>
      </div>

      <div class="set">
        <h4>Стежити за буфером обміну</h4>
        <p>Коли скопіюєш посилання на музику, програма запропонує його завантажити.</p>
        <div class="ctl">
          <label class="switch">
            <input type="checkbox" id="clipToggle" ${s.watchClipboard ? "checked" : ""} />
            Пропонувати завантаження скопійованих посилань
          </label>
        </div>
      </div>

      <div class="set">
        <h4>Звідки качається звук</h4>
        <p>
          YouTube Music, YouTube, SoundCloud. Посилання зі <b>Spotify</b> та <b>Apple Music</b>
          теж приймаються, але звідти качати неможливо — там потік захищений DRM. З таких
          посилань беруться лише назви, а сам звук шукається в YouTube Music.
          <b>Bandcamp</b> закритий захистом від автоматів, тому пошуку по ньому немає.
        </p>
      </div>

      <div class="set">
        <h4>Авторські права</h4>
        <p>
          Завантажуй лише те, на що маєш право: власні записи, музику під вільною ліцензією
          (наприклад Creative Commons) або суспільне надбання. Відповідальність за дотримання
          авторських прав несе користувач програми.
        </p>
      </div>

      <div class="set" id="binSet"></div>
    </div>`;

  window.api.binaries().then((b) => {
    const el = $("#binSet");
    if (!el) return;
    el.innerHTML = `
      <h4>Зовнішні програми</h4>
      <p>Без них можливий лише пошук, завантаження не працюватиме.</p>
      <div class="ctl">
        <span>yt-dlp: ${b.ytdlp ? `<code>${esc(b.ytdlp.version || b.ytdlp.path)}</code>` : "<b>не знайдено</b>"}</span>
        <span>ffmpeg: ${b.ffmpeg ? `<code>${esc(b.ffmpeg)}</code>` : "<b>не знайдено</b>"}</span>
      </div>`;
  });
}

// ------------------------------------------------------------------ малювання

function render() {
  $("#topbar").hidden = state.page !== "search";
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.page === state.page));

  if (state.page === "queue") renderQueue();
  else if (state.page === "library") renderLibrary();
  else if (state.page === "playlists") renderPlaylists();
  else if (state.page === "settings") renderSettings();
  else {
    const v = state.view;
    if (v.type === "results") renderResults();
    else if (v.type === "album") renderAlbum(v.data);
    else if (v.type === "artist") renderArtist(v.data);
    else if (v.type === "catalogArtist") renderCatalogArtist(v.artist, v.releases);
    else {
      $("#tabs").hidden = true;
      mainEl.innerHTML = `
        <div class="empty">
          <div class="empty-ico">♫</div>
          <h2>Знайди музику</h2>
          <p>Введи назву пісні, альбому чи виконавця — пошук іде одразу по YouTube&nbsp;Music,
             SoundCloud, iTunes і MusicBrainz. Посилання теж працює.</p>
        </div>`;
    }
  }
  refreshSelbar();
}

function goto(page) {
  state.page = page;
  if (page === "library") loadLibrary();
  if (page === "playlists") {
    state.openPl = null;
    // Плейлисти показують треки зі Сховища, тож воно має бути прочитане.
    loadLibrary();
    loadPlaylists().then(render);
  }
  render();
  if (page === "search") $("#q").focus();
}

function refreshSelbar() {
  const isLib = state.page === "library";
  const n = isLib ? state.libPicked.size : state.picked.size;
  $("#selbar").hidden = n === 0 || !["search", "library"].includes(state.page);
  $("#selCount").textContent = `${n} вибрано`;
  $("#selDl").hidden = isLib;
  $("#selTags").hidden = !isLib;
  $("#selPl").hidden = !isLib;
}

// ------------------------------------------------------------------ пошук

function searchBusy(on) {
  $("#go").disabled = on;
  $("#go").textContent = on ? "Шукаю…" : "Шукати";
  $("#stop").hidden = !on;
}

async function doSearch(e) {
  e?.preventDefault();
  const q = $("#q").value.trim();
  if (!q || state.searchId) return;

  const sources = $$("#sources input:checked").map((i) => i.value);
  if (!sources.length) return fail("Не обрано жодного джерела.");

  const id = `s${Date.now()}`;
  state.searchId = id;
  state.page = "search";
  searchBusy(true);
  state.picked.clear();
  refreshSelbar();
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.page === "search"));
  $("#topbar").hidden = false;
  loading(/^https?:/i.test(q) ? "Читаю посилання…" : "Шукаю по всіх джерелах…");

  try {
    const r = await window.api.search(q, sources, id);
    // Поки чекали, користувач міг натиснути «Стоп» і почати новий пошук —
    // тоді цей результат уже нікому не потрібен і малювати його не можна.
    if (state.searchId !== id) return;

    state.results = { songs: r.songs || [], albums: r.albums || [], artists: r.artists || [] };
    state.results.note = null;

    if (r.mode === "bridge") {
      const miss = r.missing ? `, ${r.missing} не знайшлося` : "";
      state.results.note =
        `«${r.title}» зі ${r.bridge.providerName}: звідти качати неможливо (захищений потік), ` +
        `тому звук шукався в YouTube Music${miss}.`;
    }

    if (r.mode !== "search" || !state.results[state.tab].length) {
      state.tab = ["songs", "albums", "artists"].find((t) => state.results[t].length) || "songs";
    }
    state.view = { type: "results" };
    render();

    if (r.errors?.length) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Частина джерел не відповіла: " + r.errors.join("; ");
      mainEl.prepend(note);
    }
  } catch (err) {
    if (state.searchId !== id) return;
    if (/Зупинено/.test(err.message)) mainEl.innerHTML = `<div class="note">Пошук зупинено.</div>`;
    else fail("Пошук не вдався: " + err.message);
  } finally {
    if (state.searchId === id) {
      state.searchId = null;
      searchBusy(false);
    }
  }
}

function stopSearch() {
  if (!state.searchId) return;
  window.api.cancelSearch(state.searchId).catch(() => {});
  state.searchId = null;
  searchBusy(false);
  mainEl.innerHTML = `<div class="note">Пошук зупинено.</div>`;
}

async function openAlbum(item) {
  if (!item) return;
  loading("Відкриваю альбом…");
  try {
    let album;
    if (item.source === "ytmusic") {
      album = await window.api.album(item.id);
    } else {
      // Каталожний альбом (iTunes/MusicBrainz) звуку не має — шукаємо його
      // відповідник у YouTube Music.
      album = await window.api.resolveCatalog(item);
      if (!album) {
        mainEl.innerHTML =
          `<button class="ghost back" data-act="back">← Назад</button>` +
          `<div class="note err">«${esc(item.title)}» є в каталозі, але в YouTube Music такого альбому знайти не вдалося.</div>`;
        return;
      }
    }
    state.view = { type: "album", data: album };
    render();
  } catch (err) {
    fail("Не вдалося відкрити альбом: " + err.message);
  }
}

async function openArtistById(id) {
  loading("Відкриваю виконавця…");
  try {
    state.view = { type: "artist", data: await window.api.artist(id) };
    render();
  } catch (err) {
    fail("Не вдалося відкрити виконавця: " + err.message);
  }
}

async function openArtist(item) {
  if (!item) return;
  if (item.source === "ytmusic") return openArtistById(item.id);
  loading("Читаю дискографію…");
  try {
    const releases = await window.api.mbReleases(item.id);
    state.view = { type: "catalogArtist", artist: item, releases };
    render();
  } catch (err) {
    fail("Не вдалося прочитати дискографію: " + err.message);
  }
}

// ------------------------------------------------------------------ завантаження

async function enqueue(items) {
  const good = items.filter((i) => i && i.url);
  if (!good.length) {
    toast("У цих результатів немає прямого джерела звуку — відкрий їх і завантаж через YouTube Music.");
    return;
  }
  try {
    await window.api.dlAdd(good, { outDir: state.settings.outDir, format: state.settings.format });
    toast(`Додано в чергу: ${plural(good.length, TRACKS)}`,
      [{ label: "Показати чергу", run: () => goto("queue"), primary: true }], 4000);
  } catch (err) {
    toast("Не вдалося поставити в чергу: " + err.message);
  }
}

function togglePick(key, on) {
  const it = index.get(key);
  if (!it) return;
  if (on) state.picked.set(key, it);
  else state.picked.delete(key);
  mainEl.querySelector(`.row[data-key="${CSS.escape(key)}"]`)?.classList.toggle("sel", on);
  refreshSelbar();
}

function clearPicks() {
  state.picked.clear();
  mainEl.querySelectorAll('.row input[data-act="pick"]').forEach((cb) => (cb.checked = false));
  mainEl.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
  refreshSelbar();
}

// ------------------------------------------------------------------ теги

let tagTargets = [];

function openTagEditor(paths) {
  tagTargets = paths.map((p) => state.library.tracks.find((t) => t.path === p)).filter(Boolean);
  if (!tagTargets.length) return;

  const one = tagTargets.length === 1;
  const same = (key) => {
    const v = tagTargets[0][key] || "";
    return tagTargets.every((t) => (t[key] || "") === v) ? v : "";
  };

  $("#tagHead").textContent = one ? "Змінити теги" : `Змінити теги: ${plural(tagTargets.length, FILES)}`;
  $("#tagFiles").textContent = one
    ? tagTargets[0].file
    : tagTargets.slice(0, 3).map((t) => t.file).join(", ") + (tagTargets.length > 3 ? " …" : "");
  $("#tagArtist").value = same("artist");
  $("#tagTitle").value = one ? tagTargets[0].title : "";
  $("#tagAlbum").value = same("album");
  $("#tagTitleWrap").hidden = !one;
  $("#tagRename").checked = true;
  $("#tagHint").className = "mnote";
  $("#tagHint").textContent = one
    ? "Порожнє поле означає «не чіпати». Звук і обкладинка не змінюються."
    : "Порожнє поле означає «не чіпати». Назви не показано — вона своя в кожного файлу; " +
      "при перейменуванні кожен трек збереже власну назву.";
  $("#tagModal").hidden = false;
  $("#tagArtist").focus();
}

async function saveTags() {
  const artist = $("#tagArtist").value.trim();
  const title = $("#tagTitleWrap").hidden ? "" : $("#tagTitle").value.trim();
  const album = $("#tagAlbum").value.trim();
  const rename = $("#tagRename").checked;

  const patch = {};
  if (artist) patch.artist = artist;
  if (title) patch.title = title;
  if (album) patch.album = album;
  if (!Object.keys(patch).length) {
    $("#tagHint").className = "mnote err";
    $("#tagHint").textContent = "Нема чого зберігати — усі поля порожні.";
    return;
  }

  // Файл, який зараз відкритий плеєром, Windows не дасть перейменувати:
  // звільняємо його, перш ніж чіпати.
  if (tagTargets.some((t) => t.path === state.playing?.path)) stopPlayback();

  $("#tagSave").disabled = true;
  $("#tagSave").textContent = "Зберігаю…";
  try {
    // Передаємо поточні назву й виконавця кожного файлу: при масовій правці
    // ім'я має скластись із нового виконавця та ВЛАСНОЇ назви кожного треку.
    const items = tagTargets.map((t) => ({ path: t.path, title: t.title, artist: t.artist }));
    const results = await window.api.libTags(items, { ...patch, rename });

    const bad = results.filter((r) => !r.ok);
    $("#tagModal").hidden = true;
    state.libPicked.clear();
    await loadLibrary(true);

    if (bad.length) {
      toast(`Не вдалося змінити ${plural(bad.length, FILES)}: ${bad[0].error}`, [], 12000);
    } else {
      toast(`Теги оновлено: ${plural(results.length, FILES)}`, [], 4000);
    }
  } catch (e) {
    $("#tagHint").className = "mnote err";
    $("#tagHint").textContent = "Не вдалося: " + e.message;
  } finally {
    $("#tagSave").disabled = false;
    $("#tagSave").textContent = "Зберегти";
  }
}

// ------------------------------------------------------------------ плеєр

/** Один ключ і для локального файлу, і для треку з пошуку. */
const trackKey = (t) => (t ? t.path || t.url : null);

/**
 * @param {object} track локальний файл ({path}) або результат пошуку ({url})
 * @param {object[]} [list] черга, у якій цей трек стоїть (для ⏭ і ⏮)
 */
async function play(track, list) {
  if (!track) return;
  const same = trackKey(state.playing) === trackKey(track);

  if (same && !audio.paused) {
    audio.pause();
    return;
  }
  if (same && audio.src) {
    audio.play().catch(() => {});
    return;
  }

  if (list) {
    state.pq.list = list;
    state.pq.i = list.findIndex((t) => trackKey(t) === trackKey(track));
  } else if (state.pq.list.every((t) => trackKey(t) !== trackKey(track))) {
    state.pq = { list: [track], i: 0 };
  } else {
    state.pq.i = state.pq.list.findIndex((t) => trackKey(t) === trackKey(track));
  }

  state.playing = track;
  $("#plTitle").textContent = track.title;
  $("#plArtist").textContent = track.artist || "невідомий виконавець";
  $("#plArt").src = track.thumb || BLANK;
  $("#player").classList.remove("idle");
  $("#plPlay").disabled = false;
  $("#plSeek").disabled = false;
  syncNavBtns();

  if (track.path) {
    audio.src = fileUrl(track.path);
    window.api.libCover(track.path).then((u) => {
      if (u && trackKey(state.playing) === trackKey(track)) $("#plArt").src = u;
    });
  } else {
    // Трек із пошуку: справжнє посилання на звук треба спершу отримати,
    // і це кілька секунд — тому одразу кажемо, що працюємо.
    $("#plArtist").textContent = "готую потік…";
    try {
      const url = await window.api.streamUrl(track.url);
      if (trackKey(state.playing) !== trackKey(track)) return; // встигли перемкнути
      audio.src = url;
      $("#plArtist").textContent = track.artist || "невідомий виконавець";
    } catch (e) {
      if (trackKey(state.playing) !== trackKey(track)) return;
      $("#plArtist").textContent = track.artist || "";
      toast("Не вдалося отримати потік: " + e.message);
      return;
    }
  }

  audio.play().catch((e) => toast("Не вдалося відтворити: " + e.message));
}

function playAt(i) {
  const t = state.pq.list[i];
  if (!t) return;
  state.pq.i = i;
  play(t);
}

function syncNavBtns() {
  const { list, i } = state.pq;
  $("#plPrev").disabled = !(i > 0);
  $("#plNext").disabled = !(i >= 0 && i < list.length - 1);
}

/** Те, що зараз грає, — у статус Discord. */
function pushDiscord() {
  const t = state.playing;
  if (!t) return window.api.discordActivity(null).catch(() => {});
  return window.api
    .discordActivity({
      title: t.title,
      artist: t.artist,
      album: t.album,
      // Обкладинку з тегів (data:) Discord не візьме — лише звичайне посилання.
      image: /^https?:/.test(t.thumb || "") ? t.thumb : null,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      position: audio.currentTime,
      paused: audio.paused,
    })
    .catch(() => {});
}

/** Повністю відпускає файл: інакше Windows не дасть його перейменувати. */
function stopPlayback() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.playing = null;
  state.pq = { list: [], i: -1 };
  window.api.discordActivity(null).catch(() => {});
  $("#player").classList.add("idle");
  $("#plPlay").disabled = true;
  $("#plSeek").disabled = true;
  $("#plTitle").textContent = "Нічого не грає";
  $("#plArtist").textContent = "Натисни ▶ на треку у Сховищі";
  $("#plArt").src = BLANK;
}

function syncPlayBtn() {
  $("#plPlay").textContent = audio.paused ? "▶" : "❚❚";
  syncNavBtns();
  mainEl.querySelectorAll(".row[data-path]").forEach((r) => {
    const on = r.dataset.path === state.playing?.path;
    r.classList.toggle("playing", on);
    const b = r.querySelector('[data-lact="play"]');
    if (b) b.textContent = on && !audio.paused ? "❚❚" : "▶";
  });
  mainEl.querySelectorAll(".row[data-key]").forEach((r) => {
    const it = index.get(r.dataset.key);
    const on = it && trackKey(it) === trackKey(state.playing);
    r.classList.toggle("playing", Boolean(on));
    const b = r.querySelector('[data-act="listen"]');
    if (b) b.textContent = on && !audio.paused ? "❚❚" : "▶";
  });
  pushDiscord();
}

audio.addEventListener("play", syncPlayBtn);
audio.addEventListener("pause", syncPlayBtn);
audio.addEventListener("ended", () => {
  syncPlayBtn();
  // Далі за чергою; якщо це був останній трек — просто зупиняємось.
  if (state.pq.i >= 0 && state.pq.i < state.pq.list.length - 1) playAt(state.pq.i + 1);
});
audio.addEventListener("loadedmetadata", () => {
  $("#plEnd").textContent = dur(audio.duration);
  pushDiscord();
});
audio.addEventListener("timeupdate", () => {
  $("#plNow").textContent = dur(audio.currentTime);
  if (audio.duration) $("#plSeek").value = String((audio.currentTime / audio.duration) * 1000);
});
audio.addEventListener("error", () => {
  if (audio.src) toast("Файл не відтворюється — можливо, його видалили або формат не підтримується.");
});

$("#plPlay").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
$("#plPrev").addEventListener("click", () => playAt(state.pq.i - 1));
$("#plNext").addEventListener("click", () => playAt(state.pq.i + 1));
$("#plSeek").addEventListener("input", () => {
  if (audio.duration) audio.currentTime = (Number($("#plSeek").value) / 1000) * audio.duration;
});
$("#plVol").addEventListener("input", () => {
  audio.volume = Number($("#plVol").value) / 100;
  state.settings.volume = audio.volume;
  window.api.setSettings({ volume: audio.volume }).catch(() => {});
});

// ------------------------------------------------------------------ події

$("#searchForm").addEventListener("submit", doSearch);
$("#stop").addEventListener("click", stopSearch);

$$(".navbtn").forEach((b) => b.addEventListener("click", () => goto(b.dataset.page)));

$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    state.tab = t.dataset.tab;
    state.view = { type: "results" };
    render();
  }),
);

mainEl.addEventListener("click", (e) => {
  // --- кнопки з data-act (Шукач) ---
  const btn = e.target.closest("[data-act]");
  if (btn) {
    const act = btn.dataset.act;
    const rowKey = btn.closest("[data-key]")?.dataset.key;
    if (act === "pick") return togglePick(rowKey, btn.checked);
    if (act === "listen") {
      // Слухаємо прямо з результатів пошуку, нічого не завантажуючи.
      const it = index.get(rowKey);
      const queue = (state.results[state.tab] || []).filter((s) => s.kind === "song" && s.url);
      return play(it, queue.length ? queue : undefined);
    }
    if (act === "dl-one") return enqueue([index.get(rowKey)]);
    if (act === "dl-album") return enqueue([index.get(btn.dataset.key)]);
    if (act === "open-album") return openAlbum(index.get(btn.dataset.key));
    if (act === "open-artist") return openArtist(index.get(btn.dataset.key));
    if (act === "open-artist-id") return openArtistById(btn.dataset.id);
    if (act === "back") {
      state.view = { type: "results" };
      return render();
    }
    if (act === "pick-all") {
      mainEl.querySelectorAll('.row input[data-act="pick"]:not(:disabled)').forEach((cb) => {
        if (!cb.checked) {
          cb.checked = true;
          togglePick(cb.closest(".row").dataset.key, true);
        }
      });
      return;
    }
  }

  // --- кнопки Сховища ---
  const lb = e.target.closest("[data-lact]");
  if (lb) {
    const p = lb.closest("[data-path]")?.dataset.path;
    const track = state.library.tracks.find((t) => t.path === p);
    if (!track) return;
    if (lb.dataset.lact === "pick") {
      if (lb.checked) state.libPicked.add(p);
      else state.libPicked.delete(p);
      lb.closest(".row").classList.toggle("sel", lb.checked);
      refreshSelbar();
      return;
    }
    if (lb.dataset.lact === "tags") return openTagEditor([p]);
    if (lb.dataset.lact === "play") {
      // Черга — увесь видимий список, щоб працювали ⏭ і автоперехід.
      const pl = state.openPl ? state.playlists.find((x) => x.id === state.openPl) : null;
      return play(track, pl ? plTracks(pl) : state.library.tracks);
    }
    if (lb.dataset.lact === "reveal") return window.api.reveal(p);
    if (lb.dataset.lact === "trash") {
      if (!confirm(`Перемістити «${track.title}» у кошик?`)) return;
      return window.api
        .libTrash(p)
        .then(() => {
          state.library.tracks = state.library.tracks.filter((t) => t.path !== p);
          render();
        })
        .catch((err) => toast("Не вдалося: " + err.message));
    }
  }

  // --- черга ---
  const jb = e.target.closest("[data-jact]");
  if (jb) {
    const job = state.jobs.get(jb.dataset.id);
    if (jb.dataset.jact === "cancel") return window.api.dlCancel(jb.dataset.id);
    if (jb.dataset.jact === "retry") return window.api.dlRetry(jb.dataset.id);
    if (jb.dataset.jact === "reveal" && job?.files[0]) return window.api.reveal(job.files[0]);
  }

  // --- плейлисти ---
  const pb = e.target.closest("[data-plact]");
  if (pb) {
    const act = pb.dataset.plact;
    const id = pb.dataset.id;
    if (act === "back") {
      state.openPl = null;
      return render();
    }
    if (act === "open") {
      state.openPl = id;
      return render();
    }
    if (act === "new") {
      const name = prompt("Назва нового плейлиста:");
      if (!name?.trim()) return;
      return window.api.plCreate(name).then((list) => {
        state.playlists = list;
        render();
      });
    }
    if (act === "rename") {
      const cur = state.playlists.find((p) => p.id === id);
      const name = prompt("Нова назва:", cur?.name || "");
      if (!name?.trim()) return;
      return window.api.plRename(id, name).then((list) => {
        state.playlists = list;
        render();
      });
    }
    if (act === "delete") {
      const cur = state.playlists.find((p) => p.id === id);
      if (!confirm(`Видалити плейлист «${cur?.name}»? Самі файли лишаться на диску.`)) return;
      return window.api.plRemove(id).then((list) => {
        state.playlists = list;
        state.openPl = null;
        render();
      });
    }
    if (act === "drop") {
      const p = pb.closest("[data-path]")?.dataset.path;
      return window.api.plRemoveTrack(id, p).then((list) => {
        state.playlists = list;
        render();
      });
    }
    if (act === "playall" || act === "playpl") {
      const pl = state.playlists.find((p) => p.id === (id || state.openPl));
      const list = plTracks(pl);
      if (list.length) play(list[0], list);
      return;
    }
  }

  if (e.target.id === "qOpen" || e.target.id === "libOpen")
    return window.api.openFolder(state.settings.outDir);
  if (e.target.id === "qClear")
    return window.api.dlClear().then((left) => {
      state.jobs = new Map(left.map((j) => [j.id, j]));
      refreshQueueBadge();
      render();
    });
  if (e.target.id === "libRescan") return loadLibrary(true);
  if (e.target.id === "folderBtn" || e.target.closest("#folderBtn")) return chooseFolder();

  // --- клік по рядку треку вмикає галочку, по рядку Сховища — програвання ---
  if (btn || lb || jb || pb) return;
  const row = e.target.closest(".row");
  if (!row) return;
  if (row.dataset.path) {
    const track = state.library.tracks.find((t) => t.path === row.dataset.path);
    if (!track) return;
    const pl = state.openPl ? state.playlists.find((x) => x.id === state.openPl) : null;
    play(track, pl ? plTracks(pl) : state.library.tracks);
    return;
  }
  const cb = row.querySelector('input[data-act="pick"]');
  if (!cb || cb.disabled) return;
  cb.checked = !cb.checked;
  togglePick(row.dataset.key, cb.checked);
});

mainEl.addEventListener("change", (e) => {
  if (e.target.id === "format") {
    state.settings.format = e.target.value;
    window.api.setSettings({ format: e.target.value });
  }
  if (e.target.id === "clipToggle") {
    state.settings.watchClipboard = e.target.checked;
    window.api.setSettings({ watchClipboard: e.target.checked });
  }
  if (e.target.id === "albumFolder") {
    state.settings.albumFolder = e.target.checked;
    window.api.setSettings({ albumFolder: e.target.checked });
  }
  if (e.target.id === "discordOn") {
    state.settings.discordEnabled = e.target.checked;
    window.api.setSettings({ discordEnabled: e.target.checked });
    if (!e.target.checked) window.api.discordDisconnect().catch(() => {});
    else if (state.settings.discordAppId) pushDiscord();
  }
});

mainEl.addEventListener("input", (e) => {
  if (e.target.id === "discordId") {
    state.settings.discordAppId = e.target.value.trim();
    window.api.setSettings({ discordAppId: state.settings.discordAppId });
  }
});

mainEl.addEventListener("click", async (e) => {
  if (e.target.id !== "discordTest") return;
  const msg = $("#discordMsg");
  const id = $("#discordId").value.trim();
  msg.className = "mnote";
  msg.textContent = "Підключаюсь…";
  try {
    await window.api.discordConnect(id);
    msg.className = "mnote";
    msg.textContent = "Підключено. Статус з'явиться, щойно щось заграє.";
    if (state.playing) pushDiscord();
  } catch (err) {
    msg.className = "mnote err";
    msg.textContent =
      err.message === "Invalid Client ID"
        ? "Discord не знає такого додатка — перевір Application ID."
        : "Не вийшло: " + err.message;
  }
});

// Обкладинка з каталогу часто 404 — CSP забороняє inline onerror, тому ловимо тут.
mainEl.addEventListener(
  "error",
  (e) => {
    if (e.target.tagName === "IMG" && e.target.src !== BLANK) e.target.src = BLANK;
  },
  true,
);

$("#selNone").addEventListener("click", () => {
  if (state.page === "library") {
    state.libPicked.clear();
    mainEl.querySelectorAll('input[data-lact="pick"]').forEach((cb) => (cb.checked = false));
    mainEl.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
    refreshSelbar();
  } else clearPicks();
});

$("#selTags").addEventListener("click", () => openTagEditor([...state.libPicked]));
$("#selPl").addEventListener("click", () => openPlModal([...state.libPicked]));

$("#plCancel").addEventListener("click", () => ($("#plModal").hidden = true));
$("#plModal").addEventListener("click", async (e) => {
  if (e.target.id === "plModal") return ($("#plModal").hidden = true);
  const row = e.target.closest("[data-pladd]");
  if (!row) return;
  const paths = JSON.parse($("#plModal").dataset.paths || "[]");
  state.playlists = await window.api.plAdd(row.dataset.pladd, paths);
  $("#plModal").hidden = true;
  toast(`Додано в плейлист: ${plural(paths.length, TRACKS)}`, [], 3500);
});
$("#plCreateAdd").addEventListener("click", async () => {
  const name = $("#plNewName").value.trim();
  if (!name) {
    $("#plNewName").focus();
    return;
  }
  const paths = JSON.parse($("#plModal").dataset.paths || "[]");
  const list = await window.api.plCreate(name);
  state.playlists = await window.api.plAdd(list[0].id, paths);
  $("#plModal").hidden = true;
  toast(`Створено «${name}» — ${plural(paths.length, TRACKS)}`, [], 3500);
});
$("#tagCancel").addEventListener("click", () => ($("#tagModal").hidden = true));
$("#tagSave").addEventListener("click", saveTags);
$("#tagModal").addEventListener("click", (e) => {
  if (e.target.id === "tagModal") $("#tagModal").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if ($("#tagModal").hidden) return;
  if (e.key === "Escape") $("#tagModal").hidden = true;
  if (e.key === "Enter" && e.target.tagName === "INPUT") saveTags();
});
$("#selDl").addEventListener("click", () => {
  const items = [...state.picked.values()];
  clearPicks();
  enqueue(items);
});

$("#toastClose").addEventListener("click", hideToast);

async function chooseFolder() {
  const dir = await window.api.chooseFolder();
  if (!dir) return;
  state.settings.outDir = dir;
  state.library.loaded = false;
  if (state.page === "settings") render();
  loadLibrary(true);
}

$$("#sources input").forEach((cb) =>
  cb.addEventListener("change", () =>
    window.api.setSettings({ sources: $$("#sources input:checked").map((i) => i.value) }),
  ),
);

window.api.onDlUpdate((job) => {
  const was = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  refreshQueueBadge();

  if (state.page === "queue") {
    // Перемальовуємо весь список лише коли змінився склад: інакше кожне
    // оновлення прогресу гасило б натискання на кнопки в черзі.
    if (!was) render();
    else {
      const el = mainEl.querySelector(`.job[data-id="${job.id}"]`);
      if (el) {
        el.outerHTML = jobRow(job);
        applyBars();
      } else render();
    }
  }

  // Завантажене одразу має з'явитись у Сховищі й позначитись у пошуку.
  if (job.status === "done" && was?.status !== "done") loadLibrary(true);
});

window.api.onClipboardLink((url) => {
  if (!state.settings.watchClipboard) return;
  toast("О, бачу лінк. Качаємо?", [
    {
      label: "Так",
      primary: true,
      run: () => {
        $("#q").value = url;
        goto("search");
        doSearch();
      },
    },
    { label: "Ні", run: hideToast },
  ]);
});

// ------------------------------------------------------------------ старт

(async function init() {
  const s = await window.api.getSettings();
  state.settings = s;
  $$("#sources input").forEach((cb) => (cb.checked = s.sources.includes(cb.value)));
  audio.volume = s.volume ?? 0.8;
  $("#plVol").value = String(Math.round(audio.volume * 100));

  const b = await window.api.binaries();
  if (!b.ok) {
    const miss = [];
    if (!b.ytdlp) miss.push("yt-dlp");
    if (!b.ffmpeg) miss.push("ffmpeg");
    const w = $("#warn");
    w.hidden = false;
    w.textContent =
      `Не знайдено: ${miss.join(", ")}. Пошук працюватиме, а завантаження — ні. ` +
      `Поклади ${miss.join(" і ")} у теку bin поруч із програмою.`;
  }

  state.jobs = new Map((await window.api.dlList()).map((j) => [j.id, j]));
  refreshQueueBadge();
  await loadPlaylists();
  render();
  $("#q").focus();

  if (s.discordEnabled && s.discordAppId) {
    window.api.discordConnect(s.discordAppId).catch(() => {});
  }

  // Сховище читаємо у фоні: воно потрібне ще й для позначки «вже є» в пошуку.
  loadLibrary();
})();
