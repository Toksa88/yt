"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const mainEl = $("#main");
const audio = $("#audio");

const state = {
  // Стартова сторінка мусить збігатися з кнопкою, позначеною active в
  // розмітці, інакше панель показує одне, а на екрані інше.
  page: "home",
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
  /** ключі (шлях або посилання) вподобаних треків */
  favs: new Set(),
  history: [],
  /** фільтр у Сховищі */
  libFilter: "",
  /** відкритий плейлист або null */
  openPl: null,
  /** черга відтворення: список треків і місце в ньому */
  pq: { list: [], i: -1 },
  shuffle: false,
  /** "off" | "all" | "one" */
  repeat: "off",
  home: { sections: [], loaded: false, loading: false },
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
  youtube: "YouTube",
  local: "з диска",
  soundcloud: "SoundCloud",
  itunes: "iTunes",
  musicbrainz: "MusicBrainz",
  url: "посилання",
  bridge: "не знайдено",
};

function badge(src) {
  return `<span class="badge ${esc(src)}">${esc(SRC_NAME[src] || src)}</span>`;
}

/**
 * Іконки.
 *
 * Малюємо їх самі, а не емодзі: емодзі кожна система малює по-своєму (десь
 * кольорові, десь ні, десь іншого розміру), і вирівняти їх у рядку неможливо.
 * SVG успадковує колір тексту через currentColor і масштабується разом із ним.
 */
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16.7 16.7"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M4.5 19.5h15"/>',
  library: '<circle cx="7" cy="17.5" r="2.8"/><circle cx="18" cy="15.5" r="2.5"/><path d="M9.8 17.5V6.4l10.7-2.2v11.3"/>',
  playlist: '<path d="M4 7h11"/><path d="M4 12h11"/><path d="M4 17h7"/><circle cx="17.5" cy="16.5" r="2.5"/><path d="M20 16.5V9.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-3l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.3v-.2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1.2Z"/>',
  volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M17.8 7a8 8 0 0 1 0 10"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/>',
  play: '<path d="M8 5.2 19 12 8 18.8z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5.5 9 12l9 6.5z" fill="currentColor" stroke="none"/><rect x="5" y="5.5" width="2.4" height="13" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 5.5 15 12l-9 6.5z" fill="currentColor" stroke="none"/><rect x="16.6" y="5.5" width="2.4" height="13" rx="1" fill="currentColor" stroke="none"/>',
  close: '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>',
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  note: '<circle cx="7" cy="17.5" r="2.8"/><path d="M9.8 17.5V4.5l9 2.2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  tag: '<path d="M11.5 3.5H20v8.5l-8.4 8.4a1.5 1.5 0 0 1-2.1 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.1z"/><circle cx="16" cy="8" r="1.4"/>',
  reveal: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5"/><path d="m9.6 13.4 2.4-2.4 2.4 2.4"/>',
  empty: '<circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/>',
  home: '<path d="m3.5 10.5 8.5-7 8.5 7"/><path d="M5.5 9.6V20h13V9.6"/><path d="M10 20v-5.5h4V20"/>',
  radio: '<circle cx="12" cy="12" r="2.4"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6"/><path d="M15.8 15.8a5.4 5.4 0 0 0 0-7.6"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8"/><path d="M18.4 18.4a9 9 0 0 0 0-12.8"/>',
  shuffle: '<path d="M17 4.5 20 7l-3 2.5"/><path d="M17 14.5 20 17l-3 2.5"/><path d="M4 7h3.5l9 10H20"/><path d="M4 17h3.5l2.4-2.7"/><path d="M14.1 9.7 16.5 7H20"/>',
  repeat: '<path d="M7.5 4.5 5 7l2.5 2.5"/><path d="M16.5 19.5 19 17l-2.5-2.5"/><path d="M5 7h11a3 3 0 0 1 3 3v1"/><path d="M19 17H8a3 3 0 0 1-3-3v-1"/>',
  lyrics: '<path d="M4.5 6h11"/><path d="M4.5 10.5h11"/><path d="M4.5 15h7"/><circle cx="17.5" cy="17" r="2.2"/><path d="M19.7 17V9.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 3C19.5 15.4 12 20 12 20z"/>',
  heartOn: '<path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 3C19.5 15.4 12 20 12 20z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.4 2"/>',
  queue: '<path d="M4 6.5h11"/><path d="M4 11h11"/><path d="M4 15.5h7"/><path d="m14.5 13 5.5 3.2-5.5 3.3z" fill="currentColor" stroke="none"/>',
  // Три однакові рівносторонні трикутники, зсунуті від спільного центра на
  // 120°. Переплетення (де смуга проходить зверху, а де знизу) на 26 пікселях
  // однаково не читається, тому малюємо спрощену форму — саме її й малюють
  // майже всюди.
  valknut:
    '<path d="M12 5.05 6.11 15.25h11.78z"/><path d="M9.88 8.73 3.99 18.93h11.78z"/><path d="M14.12 8.73 8.23 18.93h11.78z"/>',
  up: '<path d="M12 19V6"/><path d="m6.5 11.5 5.5-5.5 5.5 5.5"/>',
  down: '<path d="M12 5v13"/><path d="m6.5 12.5 5.5 5.5 5.5-5.5"/>',
};

function icon(name, cls = "") {
  return (
    `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${ICONS[name] || ""}</svg>`
  );
}

/** Заповнює статичні місця в розмітці, позначені data-icon. */
function paintIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    el.innerHTML = icon(el.dataset.icon);
  }
}

/** Порожня картинка замість битого посилання (обкладинок часто просто немає). */
const BLANK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="%23141417"/><text x="32" y="41" font-size="26" text-anchor="middle" fill="%235c5c66">♫</text></svg>`,
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
  // Тема майже без кольору, тож і аватари беруть не відтінок, а яскравість:
  // кольорові квадрати в сірому списку били б по очах дужче за самі обкладинки.
  const light = 16 + (hash % 14);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(240 6% ${light + 10}%)"/>` +
    `<stop offset="1" stop-color="hsl(240 6% ${light}%)"/>` +
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

/**
 * Заміна window.prompt: у Electron він кидає «prompt() is not supported» і
 * рве обробник кліку, через що кнопки просто мовчали.
 * @returns {Promise<string|null>} null, якщо скасували
 */
function askText({ title, label, value = "", ok = "Гаразд" }) {
  return new Promise((resolve) => {
    const modal = $("#askModal");
    const input = $("#askInput");
    $("#askTitle").textContent = title;
    $("#askLabel").textContent = label;
    $("#askOk").textContent = ok;
    input.value = value;
    modal.hidden = false;
    input.focus();
    input.select();

    const done = (val) => {
      modal.hidden = true;
      $("#askOk").removeEventListener("click", onOk);
      $("#askCancel").removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      modal.removeEventListener("click", onBackdrop);
      resolve(val);
    };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === "Enter") onOk();
      if (e.key === "Escape") onCancel();
    };
    const onBackdrop = (e) => {
      if (e.target === modal) onCancel();
    };

    $("#askOk").addEventListener("click", onOk);
    $("#askCancel").addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    modal.addEventListener("click", onBackdrop);
  });
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
        ${dead ? "" : `<button data-act="listen" class="ghost iconbtn" title="Послухати не завантажуючи">${icon("play")}</button>`}
        ${dead ? "" : `<button data-act="playnext" class="ghost iconbtn" title="Грати наступним">${icon("queue")}</button>`}
        ${favBtn(s)}
        ${dead ? "" : `<button data-act="toplaylist" class="ghost iconbtn" title="У плейлист">${icon("plus")}</button>`}
        ${s.source === "ytmusic" ? `<button data-act="radio" class="ghost iconbtn" title="Радіо за цим треком">${icon("radio")}</button>` : ""}
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
      head +
      `<div class="empty"><div class="empty-ico">${icon("empty")}</div>` +
      `<p>Тут нічого не знайшлося. Спробуй іншу вкладку або інший запит.</p></div>`;
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
    <button class="ghost back" data-act="back">${icon("back")} Назад</button>
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
    <button class="ghost back" data-act="back">${icon("back")} Назад</button>
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
    <button class="ghost back" data-act="back">${icon("back")} Назад</button>
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
        <button data-lact="play" class="primary iconbtn">${icon(isPlaying && !audio.paused ? "pause" : "play")}</button>
        <button data-lact="playnext" class="ghost iconbtn" title="Грати наступним">${icon("queue")}</button>
        ${favBtn(t)}
        <button data-lact="toplaylist" class="ghost">${icon("plus")} У плейлист</button>
        <button data-lact="tags" class="ghost">${icon("tag")} Теги</button>
        <button data-lact="reveal" class="ghost">${icon("reveal")} Показати</button>
        <button data-lact="trash" class="ghost danger">${icon("trash")} У кошик</button>
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
      <input type="text" id="libSearch" class="libfind" placeholder="Пошук у сховищі…"
             spellcheck="false" value="${esc(state.libFilter)}" />
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

  const q = norm(state.libFilter);
  const shown = q
    ? L.tracks.filter((t) => norm(`${t.artist} ${t.title} ${t.album} ${t.file}`).includes(q))
    : L.tracks;

  const total = L.tracks.reduce((a, t) => a + t.size, 0);
  mainEl.innerHTML =
    head +
    `<div class="note">${
      q
        ? `Знайдено ${plural(shown.length, TRACKS)} із ${plural(L.tracks.length, TRACKS)}`
        : `${plural(L.tracks.length, TRACKS)} · ${mbStr(total)}`
    }</div>` +
    (shown.length
      ? `<div class="rows">${shown.map(libRow).join("")}</div>`
      : `<div class="note">Нічого не збіглося з «${esc(state.libFilter)}».</div>`);
  loadCovers();
}

/**
 * Обкладинки Сховища.
 *
 * Читання однієї обкладинки — 8 мс, тож перші екрани вантажимо одразу, без
 * посередників. Раніше все йшло через IntersectionObserver, і він часом
 * мовчав (вікно ще не промальоване або пригальмоване фоном) — картинки
 * лишались порожніми на рівному місці. Ліниве завантаження лишаємо тільки
 * для хвоста великих списків, де воно справді має сенс.
 */
const EAGER_COVERS = 30;
let coverObserver = null;

function fetchCover(el) {
  const p = el.dataset.cover;
  if (!p || el.dataset.coverDone) return;
  el.dataset.coverDone = "1";
  window.api
    .libCover(p)
    .then((uri) => {
      if (uri) el.src = uri;
    })
    .catch(() => {});
}

function loadCovers() {
  coverObserver?.disconnect();
  const els = [...mainEl.querySelectorAll("[data-cover]")];

  for (const el of els.slice(0, EAGER_COVERS)) fetchCover(el);

  const rest = els.slice(EAGER_COVERS);
  if (!rest.length) return;

  coverObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        coverObserver.unobserve(e.target);
        fetchCover(e.target);
      }
    },
    { root: mainEl, rootMargin: "300px" },
  );
  for (const el of rest) coverObserver.observe(el);
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

// ------------------------------------------------------------------ сторінка «Головна»

/**
 * Рядок історії. Зберігає і локальні файли, і мережеві треки, тому клік має
 * вести туди, куди веде сам трек: файл — грати з диска, посилання — потоком.
 */
function histRow(t) {
  const owned = state.owned.has(ownKey(t.artist, t.title));
  const playing = trackKey(state.playing) === t.key;
  return `
    <div class="row${playing ? " playing" : ""}" data-hist="${esc(t.key)}">
      <span></span>
      ${img(t.thumb, "art")}
      <div class="name">
        <b>${esc(t.title)}${owned ? `<span class="badge owned">вже є</span>` : ""}</b>
        <span class="sub">${esc(t.artist || "")}</span>
      </div>
      <div class="alb">${esc(t.album || "")}</div>
      <div class="dur">${dur(t.duration)}</div>
      <div class="act">
        <button data-hact="histplay" class="primary iconbtn">${icon("play")}</button>
      </div>
    </div>`;
}

function mixCard(m) {
  return `
    <div class="card" data-hact="mix" data-id="${esc(m.playlistId || m.id)}" data-title="${esc(m.title)}">
      ${img(m.thumb || avatar(m.title), "cover")}
      <div class="t">${esc(m.title)}</div>
      <div class="s">${esc(m.artist || "")}</div>
    </div>`;
}

function renderHome() {
  $("#tabs").hidden = true;
  const H = state.home;

  if (H.loading) return loading("Читаю рекомендації YouTube Music…");
  if (H.error) return fail("Не вдалося прочитати головну: " + H.error);

  // Своє — вище чужого: те, що ти слухав, важливіше за чужі чарти.
  const hist = state.history.slice(0, 12);
  const mine = hist.length
    ? `<h3 class="sec">${icon("clock")} Нещодавно слухав` +
      `<button class="ghost tiny" data-hact="histclear">Очистити</button></h3>` +
      `<div class="rows">${hist.map(histRow).join("")}</div>`
    : "";

  mainEl.innerHTML =
    `<h1 class="page">Головна</h1>` +
    mine +
    (H.sections.length
      ? H.sections
          .map(
            (s) =>
              `<h3 class="sec">${esc(s.title)}</h3><div class="grid">${s.items.map(mixCard).join("")}</div>`,
          )
          .join("")
      : `<div class="note">Порожньо. Перевір інтернет і онови сторінку.</div>`);
}

async function loadHome(force = false) {
  const H = state.home;
  if (H.loading || (H.loaded && !force)) return;
  H.loading = true;
  H.error = null;
  if (state.page === "home") render();
  try {
    H.sections = await window.api.home();
    H.loaded = true;
  } catch (e) {
    H.error = e.message;
  } finally {
    H.loading = false;
    if (state.page === "home") render();
  }
}

/** Добірка з головної: показуємо треклист і одразу вмикаємо. */
async function openMix(playlistId, title) {
  loading("Відкриваю добірку…");
  try {
    const tracks = await window.api.mix(playlistId);
    reindex(tracks);
    state.view = { type: "mix", title, tracks };
    state.page = "home";
    $("#tabs").hidden = true;
    mainEl.innerHTML = `
      <button class="ghost back" data-hact="homeback">${icon("back")} Головна</button>
      <div class="libhead">
        <h1>${esc(title || "Добірка")}</h1>
        <span class="grow"></span>
        <button class="primary" data-hact="playmix">${icon("play")} Слухати все</button>
        <button class="primary" data-hact="grabmix">${icon("download")} ЗАБИРАЮ ВСЕ!</button>
      </div>
      <div class="note">${plural(tracks.length, TRACKS)}</div>
      <div class="rows">${tracks.map(songRow).join("")}</div>`;
    state.mixTracks = tracks;
    state.mixId = playlistId;
    state.mixTitle = title;
  } catch (e) {
    fail("Не вдалося відкрити добірку: " + e.message);
  }
}

/** Радіо за треком — власні рекомендації YouTube Music. */
async function startRadio(track) {
  if (!track?.id) return;
  toast("Складаю радіо…", [], 2500);
  try {
    const list = await window.api.radio(track.id);
    if (!list.length) return toast("Для цього треку радіо немає.");
    reindex(list);
    // Сам трек попереду, далі рекомендації.
    const full = [track, ...list.filter((t) => t.id !== track.id)];
    play(full[0], full);
    toast(`Радіо: ${plural(full.length, TRACKS)}`, [], 3500);
  } catch (e) {
    toast("Радіо не вийшло: " + e.message);
  }
}

// ------------------------------------------------------------------ сторінка «Плейлисти»

/**
 * Треки плейлиста. Для локальних файлів беремо свіжий запис зі Сховища —
 * там актуальні теги, тривалість і обкладинка; для мережевих лишаємо те,
 * що збережено. Файл, якого зараз немає на диску, не викидаємо: диск могли
 * просто від'єднати.
 */
function plTracks(pl) {
  return (pl?.tracks || []).map((t) => {
    if (!t.path) return t;
    return state.library.tracks.find((x) => x.path === t.path) || { ...t, missing: true };
  });
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
    // Качати треба лише те, чого ще немає на диску: у локальних треків
    // посилання немає взагалі, вони вже свої.
    const toGrab = tracks.filter((t) => !t.path && t.url);

    mainEl.innerHTML = `
      <button class="ghost back" data-plact="back">← Усі плейлисти</button>
      <div class="libhead">
        <h1>${esc(pl.name)}</h1>
        <span class="grow"></span>
        <button class="primary" data-plact="playall" ${tracks.length ? "" : "disabled"}>${icon("play")} Слухати все</button>
        <button class="primary" data-plact="plgrab" ${toGrab.length ? "" : "disabled"}
                title="${toGrab.length ? `Завантажити ${plural(toGrab.length, TRACKS)}` : "Усе вже на диску"}">
          ${icon("download")} ЗАБИРАЮ ВСЕ!
        </button>
        <button class="ghost" data-plact="rename" data-id="${esc(pl.id)}">Перейменувати</button>
        <button class="ghost danger" data-plact="delete" data-id="${esc(pl.id)}">Видалити</button>
      </div>
      <div class="note">${plural(tracks.length, TRACKS)}${
        lost ? ` · ${plural(lost, ["файл не знайдено", "файли не знайдено", "файлів не знайдено"])}` : ""
      }</div>
      ${
        tracks.length
          ? `<div class="rows">${tracks.map((t) => plTrackRow(t, pl.id)).join("")}</div>`
          : `<div class="note info">Порожньо. Треки додаються зі <b>Сховища</b>: наведи на трек
               і тисни «У плейлист», або постав галочки на кількох одразу — тоді кнопка
               з'явиться внизу екрана.</div>`
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
        <div class="pic">${icon("playlist")}</div>
        <div class="who" data-plact="open" data-id="${esc(p.id)}">
          <b>${esc(p.name)}</b>
          <small>${plural(p.tracks.length, TRACKS)}</small>
        </div>
        <div class="pact">
          <button class="primary iconbtn" data-plact="playpl" data-id="${esc(p.id)}" ${p.tracks.length ? "" : "disabled"}>${icon("play")}</button>
          <button class="ghost" data-plact="rename" data-id="${esc(p.id)}">Перейменувати</button>
          <button class="ghost danger" data-plact="delete" data-id="${esc(p.id)}">Видалити</button>
        </div>
      </div>`,
            )
            .join("")
        : `<div class="note info">Плейлистів ще немає. Натисни <b>«Створити плейлист»</b> угорі,
             а тоді додавай у нього треки зі <b>Сховища</b> кнопкою «У плейлист».</div>`
    }`;
}

function plTrackRow(t, plId) {
  const key = trackKey(t) || t.key;
  const isPlaying = trackKey(state.playing) === key;
  const cover = t.path
    ? img(null, "art", `data-cover="${esc(t.path)}"`)
    : img(t.thumb, "art");
  return `
    <div class="row${isPlaying ? " playing" : ""}${t.missing ? " dim" : ""}" data-pkey="${esc(key)}">
      <span></span>
      ${cover}
      <div class="name">
        <b>${esc(t.title)}${
          t.path
            ? ""
            : `<span class="badge ${esc(t.source || "ytmusic")}">${esc(SRC_NAME[t.source] || "потік")}</span>`
        }${t.missing ? `<span class="badge miss">файлу немає</span>` : ""}</b>
        <span class="sub">${esc(t.artist || "невідомий виконавець")}</span>
      </div>
      <div class="alb">${esc(t.album || "")}</div>
      <div class="dur">${dur(t.duration)}</div>
      <div class="act">
        <button data-plact="plplay" class="primary iconbtn">${icon(isPlaying && !audio.paused ? "pause" : "play")}</button>
        <button data-plact="drop" data-id="${esc(plId)}" class="ghost">${icon("close")} Прибрати</button>
      </div>
    </div>`;
}

async function loadPlaylists() {
  state.playlists = await window.api.plList();
}

/** @param {object[]} tracks локальні файли або треки з пошуку — байдуже які */
function openPlModal(tracks) {
  tracks = (tracks || []).filter(Boolean);
  if (!tracks.length) return;
  $("#plModalCount").textContent = `Обрано ${plural(tracks.length, TRACKS)}`;
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
  $("#plModal").dataset.tracks = JSON.stringify(tracks);
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
          <button class="ghost" id="folderBtn" title="${esc(s.outDir)}">${icon("folder")} <span id="folderName">${esc(s.outDir)}</span></button>
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
          Discord показує назву <b>зареєстрованого додатка</b>, а не заголовок нашого вікна.
          ID такого додатка вшитий у програму, тому тому, хто просто нею користується,
          нічого налаштовувати не треба — досить увімкнути галочку. Поле нижче потрібне,
          лише якщо хочеш підставити свій додаток з іншою назвою.
        </p>
        <p>
          Свій ID береться так: <b>discord.com/developers/applications</b> →
          <b>New Application</b> → назви як хочеш (саме цю назву побачать друзі) →
          вкладка <b>General Information</b> → <b>Application ID</b>.
          Це не таємниця: Discord показує цей ID у кожному статусі.
        </p>
        <p>
          Щоб статус було видно, у самому Discord має бути ввімкнено показ активності
          (Налаштування → Приватність активності), і Discord має бути запущений.
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
        <h4>Масштаб інтерфейсу</h4>
        <p>
          На великому моніторі, де система працює без збільшення, усе виглядає дрібним.
          Обране значення пам'ятається між запусками. Те саме роблять <b>Ctrl</b>&nbsp;+&nbsp;<b>=</b>
          і <b>Ctrl</b>&nbsp;+&nbsp;<b>−</b>, а <b>Ctrl</b>&nbsp;+&nbsp;<b>0</b> повертає звичайний.
        </p>
        <div class="ctl">
          <select id="zoom">
            ${[0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
              .map(
                (z) =>
                  `<option value="${z}"${Math.abs((s.zoom || 1) - z) < 0.01 ? " selected" : ""}>${Math.round(
                    z * 100,
                  )}%${z === 1 ? " — звичайний" : ""}</option>`,
              )
              .join("")}
          </select>
        </div>
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
      <div class="set">
        <h4>Версія</h4>
        <p>Оновлення завантажується саме, коли з'явиться нове; програма запропонує перезапуск.</p>
        <div class="ctl"><span id="appVer">…</span></div>
      </div>
    </div>`;

  window.api
    .version()
    .then((v) => {
      const el = $("#appVer");
      if (el) el.innerHTML = `Music Grabber <code>${esc(v)}</code>`;
    })
    .catch(() => {});

  renderBins();
}

/** Стан yt-dlp та ffmpeg і ручне оновлення yt-dlp. */
async function renderBins() {
  const el = $("#binSet");
  if (!el) return;

  const b = await window.api.binaries();
  const s = state.settings;
  el.innerHTML = `
    <h4>Зовнішні програми</h4>
    <p>
      <b>yt-dlp</b> завантажує, <b>ffmpeg</b> обробляє. Обидві вшиті в інсталятор,
      тож ставити їх окремо не треба. Якщо запускаєш програму з вихідних кодів —
      виконай <code>npm run bins</code>, і вони самі ляжуть у теку <code>app/bin</code>.
    </p>
    <p>
      yt-dlp мусить бути свіжим: YouTube регулярно змінює свій бік, і стара версія
      просто перестає качати. Оновлена копія лягає у профіль користувача — тека
      з програмою при цьому не чіпається, тому права адміністратора не потрібні.
    </p>
    <div class="ctl">
      <span>yt-dlp: ${b.ytdlp ? `<code>${esc(b.ytdlp.version || b.ytdlp.path)}</code>` : "<b>не знайдено</b>"}</span>
      <span>ffmpeg: ${b.ffmpeg ? `<code>${esc(b.ffmpeg)}</code>` : "<b>не знайдено</b>"}</span>
    </div>
    <div class="ctl">
      <label class="switch">
        <input type="checkbox" id="ytdlpAuto" ${s.ytdlpAutoUpdate ? "checked" : ""} />
        Оновлювати yt-dlp автоматично
      </label>
    </div>
    <div class="ctl spaced">
      <button class="ghost" id="ytdlpUpd">Перевірити оновлення</button>
    </div>
    <div class="mnote" id="ytdlpMsg"></div>`;
}

/** Ручна перевірка: спершу питаємо GitHub, качаємо лише якщо є що. */
async function updateYtdlp() {
  const btn = $("#ytdlpUpd");
  const msg = $("#ytdlpMsg");
  if (!btn || !msg) return;

  btn.disabled = true;
  msg.className = "mnote";
  msg.textContent = "Питаю GitHub…";
  try {
    const { current, latest, fresh } = await window.api.ytdlpCheck();
    if (fresh) {
      msg.textContent = `Уже найсвіжіша: ${current}`;
      return;
    }
    msg.textContent = `Є ${latest}${current ? ` (стоїть ${current})` : ""} — качаю…`;
    const r = await window.api.ytdlpUpdate();
    // Перемальовуємо весь блок, щоб у рядку стану стояла вже нова версія;
    // повідомлення після цього доводиться писати наново — розмітка інша.
    await renderBins();
    const line = $("#ytdlpMsg");
    if (line) line.textContent = `Оновлено до ${r.version}.`;
    return;
  } catch (e) {
    msg.className = "mnote err";
    msg.textContent = "Не вийшло: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ малювання

function render() {
  $("#topbar").hidden = state.page !== "search";
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.page === state.page));

  if (state.page === "home") {
    if (state.view.type === "mix") {
      /* треклист добірки вже намальовано openMix — не перемальовуємо */
    } else renderHome();
  } else if (state.page === "queue") renderQueue();
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
          <div class="empty-ico">${icon("note")}</div>
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
  if (page === "home") {
    state.view = { type: "empty" };
    loadHome();
  }
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

  // SoundCloud запускаємо паралельно й НЕ чекаємо: він іде вчетверо довше за
  // решту разом узятих, бо щоразу піднімає yt-dlp. Його результати домалюємо,
  // коли прийдуть.
  const wantSC = sources.includes("soundcloud");
  const scPromise = wantSC ? window.api.searchSoundcloud(q, id + "sc").catch(() => []) : null;

  try {
    const r = await window.api.search(q, sources.filter((s) => s !== "soundcloud"), id);
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

    if (r.errors?.length && state.page === "search") {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Частина джерел не відповіла: " + r.errors.join("; ");
      mainEl.prepend(note);
    }

    // Домальовуємо SoundCloud, коли він нарешті відповість.
    if (scPromise) {
      scPromise.then((sc) => {
        if (state.searchId !== null && state.searchId !== id) return; // уже інший пошук
        if (!sc?.length) return;

        // У пам'ять кладемо завжди: людина могла піти в Сховище й повернутись,
        // і тоді треки мають бути на місці.
        state.results.songs = [...state.results.songs, ...sc];

        // А от малювати можна лише те, на що людина зараз дивиться. SoundCloud
        // думає близько чотирьох секунд — за цей час встигаєш піти в Сховище,
        // і підміняти сторінку під руками не можна.
        if (state.page !== "search" || state.view.type !== "results") return;

        if (state.tab === "songs") renderResults();
        else {
          const cnt = document.querySelector('.tab[data-tab="songs"] .cnt');
          if (cnt) cnt.textContent = state.results.songs.length;
        }
      });
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

function isFav(t) {
  const k = trackKey(t);
  return Boolean(k && state.favs.has(k));
}

function favBtn(t) {
  const on = isFav(t);
  return `<button data-fav="1" class="ghost iconbtn heart${on ? " on" : ""}" title="${
    on ? "Прибрати з улюбленого" : "В улюблене"
  }">${icon(on ? "heartOn" : "heart")}</button>`;
}

async function toggleFav(track) {
  if (!track || !trackKey(track)) return;
  const r = await window.api.favToggle(track);
  state.favs = new Set(r.favorites.map((t) => t.key));
  syncHearts();
  toast(r.added ? "Додано в улюблене" : "Прибрано з улюбленого", [], 2200);
}

/** Перемальовує лише самі сердечка — без перезбирання всієї сторінки. */
function syncHearts() {
  for (const el of mainEl.querySelectorAll("[data-fav]")) {
    const row = el.closest("[data-key],[data-path]");
    const t = row?.dataset.path
      ? state.library.tracks.find((x) => x.path === row.dataset.path)
      : index.get(row?.dataset.key);
    if (!t) continue;
    const on = isFav(t);
    el.classList.toggle("on", on);
    el.innerHTML = icon(on ? "heartOn" : "heart");
  }
  const p = $("#plFav");
  if (p) {
    const on = isFav(state.playing);
    p.classList.toggle("on", on);
    p.innerHTML = icon(on ? "heartOn" : "heart");
  }
}

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
  loadLyrics(); // якщо панель відкрита — показати текст уже нового треку
  // В історію пишемо одразу при виборі: якщо чекати кінця треку, туди не
  // потрапить нічого з того, що ти перемкнув на середині.
  window.api
    .histAdd({ ...track, key: trackKey(track) })
    .then((h) => {
      state.history = h;
    })
    .catch(() => {});
  $("#plTitle").textContent = track.title;
  $("#plArtist").textContent = track.artist || "невідомий виконавець";
  $("#plArt").src = track.thumb || BLANK;
  $("#player").classList.remove("idle");
  $("#plPlay").disabled = false;
  $("#plSeek").disabled = false;
  syncNavBtns();
  pushMediaSession();
  renderQueuePanel();

  if (track.path) {
    audio.src = fileUrl(track.path);
    window.api.libCover(track.path).then((u) => {
      if (u && trackKey(state.playing) === trackKey(track)) {
        $("#plArt").src = u;
        pushMediaSession(); // обкладинка дійшла — оновимо й системну панель
      }
    });
  } else {
    // Трек із пошуку: справжнє посилання на звук треба спершу отримати,
    // і це кілька секунд — тому одразу кажемо, що працюємо.
    $("#plArtist").textContent = "готую потік…";
    try {
      const url = await window.api.streamUrl(track.url);
      if (trackKey(state.playing) !== trackKey(track)) return; // встигли перемкнути
      streamRetried = false;
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
  // Наступний готуємо одразу, поки цей ще грає.
  setTimeout(prefetchNext, 1500);
}

/**
 * Готує посилання на потік для наступного треку, поки грає поточний.
 *
 * Отримання посилання коштує ~3.4 с, з яких 2.4 — це просто запуск yt-dlp
 * (виміряно). Прибрати цей час не можна, але можна витратити його заздалегідь:
 * тоді ⏭ і автоперехід спрацьовують миттєво. Головний процес кешує результат,
 * тож повторний запит нічого не коштує.
 */
function prefetchNext() {
  const n = nextIndex(true);
  if (n < 0 || n === state.pq.i) return;
  const t = state.pq.list[n];
  if (!t || t.path || !t.url) return; // локальний файл готувати не треба
  window.api.streamUrl(t.url).catch(() => {});
}

function playAt(i) {
  const t = state.pq.list[i];
  if (!t) return;
  state.pq.i = i;
  play(t);
}

/**
 * Наступний індекс із урахуванням перемішування й повтору.
 * @param {boolean} auto true — трек скінчився сам; false — натиснули ⏭
 * @returns {number} -1 означає «далі нічого»
 */
function nextIndex(auto) {
  const { list, i } = state.pq;
  if (!list.length) return -1;

  // Повтор одного спрацьовує лише сам собою: ⏭ має вести далі, інакше
  // кнопка виглядала б зламаною.
  if (auto && state.repeat === "one") return i;

  if (state.shuffle) {
    if (list.length === 1) return state.repeat === "off" && auto ? -1 : 0;
    let n = i;
    while (n === i) n = Math.floor(Math.random() * list.length);
    return n;
  }

  if (i < list.length - 1) return i + 1;
  return state.repeat === "all" ? 0 : -1;
}

function syncModeBtns() {
  $("#plShuffle").classList.toggle("on", state.shuffle);
  $("#plRepeat").classList.toggle("on", state.repeat !== "off");
  $("#plRepeat").innerHTML = icon("repeat");
  $("#plRepeat").title =
    state.repeat === "one" ? "Повтор: один трек" : state.repeat === "all" ? "Повтор: увесь список" : "Повтор вимкнено";
  $("#plRepeat").dataset.mode = state.repeat;
}

function syncNavBtns() {
  const { list, i } = state.pq;
  $("#plPrev").disabled = !(i > 0);
  // У перемішаному режимі та при повторі списку «наступний» є завжди.
  $("#plNext").disabled = !(i >= 0 && (state.shuffle || state.repeat === "all" || i < list.length - 1));
}

/**
 * Ключ для пошуку тексту пісні.
 *
 * У результатів пошуку та радіо id — це і є відео YouTube. Для файлів на диску
 * ідентифікатор виймається з тегів під час читання Сховища, тому текст
 * знаходиться і для вже завантаженого.
 */
function videoIdOf(t) {
  if (!t) return null;
  if (t.videoId) return t.videoId;
  if (t.source === "ytmusic" && /^[\w-]{11}$/.test(String(t.id || ""))) return t.id;
  return null;
}

function toggleLyrics() {
  const panel = $("#lyricsPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadLyrics();
}

async function loadLyrics() {
  const panel = $("#lyricsPanel");
  if (panel.hidden) return;

  const t = state.playing;
  $("#lyricsTitle").textContent = t ? `${t.artist ? t.artist + " — " : ""}${t.title}` : "Текст пісні";

  if (!t) {
    $("#lyricsBody").innerHTML = `<div class="note">Спершу увімкни трек.</div>`;
    return;
  }

  const id = videoIdOf(t);
  if (!id) {
    $("#lyricsBody").innerHTML =
      `<div class="note">Для цього джерела тексту немає — він шукається лише за треками YouTube Music.</div>`;
    return;
  }

  $("#lyricsBody").innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
  try {
    const text = await window.api.lyrics(id);
    // Поки чекали, трек могли перемкнути — не показуємо чужий текст.
    if (videoIdOf(state.playing) !== id) return;
    $("#lyricsBody").innerHTML = text
      ? `<pre class="ltext">${esc(text)}</pre>`
      : `<div class="note">Тексту для цієї пісні немає. Для інструменталу це нормально.</div>`;
  } catch (e) {
    $("#lyricsBody").innerHTML = `<div class="note err">Не вдалося отримати текст: ${esc(e.message)}</div>`;
  }
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
      // Discord бере лише http(s): вшиту в файл картинку (data:) він не покаже.
      // Для завантажених треків рятує thumbUrl, виведений з тегів файлу.
      image: t.thumbUrl || (/^https?:/.test(t.thumb || "") ? t.thumb : null),
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      position: audio.currentTime,
      paused: audio.paused,
    })
    .catch(() => {});
}

// ------------------------------------------------------------------ черга відтворення

/**
 * Панель «що гратиме далі».
 *
 * Черга існувала від самого початку, але лише всередині програми: побачити її
 * було ніяк, а отже й переставити щось або викинути. Тут вона стає видимою.
 */
function queueRow(t, i) {
  const now = i === state.pq.i;
  return `
    <div class="qrow${now ? " now" : ""}" data-qi="${i}">
      <span class="qn">${now ? icon("play") : i + 1}</span>
      ${img(t.thumb || t.thumbUrl, "qart")}
      <div class="qname">
        <b>${esc(t.title)}</b>
        <span class="sub">${esc(t.artist || "невідомий виконавець")}</span>
      </div>
      <span class="qdur">${dur(t.duration)}</span>
      <span class="qact">
        <button data-qact="up" class="ghost iconbtn" title="Вище" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
        <button data-qact="down" class="ghost iconbtn" title="Нижче" ${
          i === state.pq.list.length - 1 ? "disabled" : ""
        }>${icon("down")}</button>
        <button data-qact="drop" class="ghost iconbtn danger" title="Прибрати з черги">${icon("close")}</button>
      </span>
    </div>`;
}

function renderQueuePanel() {
  const panel = $("#queuePanel");
  if (panel.hidden) return;

  const { list, i } = state.pq;
  $("#queueCount").textContent = list.length ? `${i + 1} з ${list.length}` : "";
  $("#queueBody").innerHTML = list.length
    ? list.map(queueRow).join("")
    : `<div class="note">Черга порожня. Увімкни будь-що — і сюди потрапить увесь список, з якого ти це взяв.</div>`;
}

function toggleQueuePanel() {
  const panel = $("#queuePanel");
  panel.hidden = !panel.hidden;
  // Дві панелі поруч не вміщаються — відкриваючи одну, ховаємо другу.
  if (!panel.hidden) {
    $("#lyricsPanel").hidden = true;
    renderQueuePanel();
  }
}

/** Прибирає трек із черги, не зупиняючи того, що зараз грає. */
function queueDrop(i) {
  const { list } = state.pq;
  if (!list[i]) return;
  list.splice(i, 1);
  // Якщо викинули те, що грає, зсуваємо покажчик на позицію перед дірою:
  // тоді «наступний» веде на трек, який щойно посунувся на це місце.
  if (i <= state.pq.i) state.pq.i--;
  renderQueuePanel();
  syncNavBtns();
}

/** @param {number} i звідки  @param {number} d -1 вище, +1 нижче */
function queueMove(i, d) {
  const { list } = state.pq;
  const j = i + d;
  if (!list[i] || !list[j]) return;
  [list[i], list[j]] = [list[j], list[i]];
  // Покажчик має їхати за самим треком, інакше «зараз грає» перестрибне на чуже.
  if (state.pq.i === i) state.pq.i = j;
  else if (state.pq.i === j) state.pq.i = i;
  renderQueuePanel();
  syncNavBtns();
}

/** Вставляє трек одразу після поточного — класичне «грати наступним». */
function playNext(track) {
  if (!track) return;
  if (!state.playing || state.pq.i < 0) return play(track);

  state.pq.list.splice(state.pq.i + 1, 0, track);
  renderQueuePanel();
  syncNavBtns();
  toast(`«${track.title}» гратиме наступним`, [], 2500);
}

// ------------------------------------------------------------------ система

/**
 * Віддає поточний трек операційній системі.
 *
 * У Windows це та сама панель, що виїжджає при зміні гучності: з обкладинкою,
 * назвою і кнопками. Разом з нею починають працювати медіаклавіші на
 * клавіатурі та навушниках — навіть коли вікно згорнуте й не в фокусі.
 */
function pushMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;

  const t = state.playing;
  if (!t) {
    ms.metadata = null;
    ms.playbackState = "none";
    return;
  }

  // Беремо саме те, що вже показано в плеєрі: для завантаженого файлу це
  // обкладинка з тегів, для знайденого — прев'ю з мережі.
  const art = $("#plArt").src;
  try {
    ms.metadata = new MediaMetadata({
      title: t.title || "?",
      artist: t.artist || "невідомий виконавець",
      album: t.album || "",
      artwork: art && art !== BLANK ? [{ src: art }] : [],
    });
  } catch {
    /* система відмовилась від картинки — назва все одно вже показана */
  }
  ms.playbackState = audio.paused ? "paused" : "playing";
}

/** Смужка перемотки в системній панелі. */
function pushPosition() {
  const ms = navigator.mediaSession;
  if (!ms?.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    ms.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {
    /* трапляється на живому потоці, де тривалість пливе */
  }
}

/** Кнопки системної панелі та медіаклавіші. Ставимо один раз на старті. */
function setupMediaKeys() {
  const ms = navigator.mediaSession;
  if (!ms?.setActionHandler) return;
  const set = (action, fn) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* цю дію система не підтримує — не біда */
    }
  };

  set("play", () => audio.play().catch(() => {}));
  set("pause", () => audio.pause());
  set("stop", stopPlayback);
  set("previoustrack", () => {
    if (state.pq.i > 0) playAt(state.pq.i - 1);
  });
  set("nexttrack", () => {
    const n = nextIndex(false);
    if (n >= 0) playAt(n);
  });
  set("seekbackward", (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset || 10));
  });
  set("seekforward", (d) => {
    if (audio.duration) {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + (d?.seekOffset || 10));
    }
  });
  set("seekto", (d) => {
    if (Number.isFinite(d?.seekTime)) audio.currentTime = d.seekTime;
  });
}

/** Повністю відпускає файл: інакше Windows не дасть його перейменувати. */
function stopPlayback() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.playing = null;
  state.pq = { list: [], i: -1 };
  window.api.discordActivity(null).catch(() => {});
  pushMediaSession();
  renderQueuePanel();
  $("#player").classList.add("idle");
  $("#plPlay").disabled = true;
  $("#plSeek").disabled = true;
  $("#plTitle").textContent = "Нічого не грає";
  $("#plArtist").textContent = "Обери трек у Сховищі або в пошуку";
  $("#plArt").src = BLANK;
}

function syncPlayBtn() {
  $("#plPlay").innerHTML = icon(audio.paused ? "play" : "pause");
  syncNavBtns();
  mainEl.querySelectorAll(".row[data-path]").forEach((r) => {
    const on = r.dataset.path === state.playing?.path;
    r.classList.toggle("playing", on);
    const b = r.querySelector('[data-lact="play"]');
    if (b) b.innerHTML = icon(on && !audio.paused ? "pause" : "play");
  });
  mainEl.querySelectorAll(".row[data-key]").forEach((r) => {
    const it = index.get(r.dataset.key);
    const on = it && trackKey(it) === trackKey(state.playing);
    r.classList.toggle("playing", Boolean(on));
    const b = r.querySelector('[data-act="listen"]');
    if (b) b.innerHTML = icon(on && !audio.paused ? "pause" : "play");
  });
  pushDiscord();
  pushMediaSession();
}

audio.addEventListener("play", syncPlayBtn);
audio.addEventListener("pause", syncPlayBtn);
audio.addEventListener("ended", () => {
  syncPlayBtn();
  const n = nextIndex(true);
  if (n < 0) return; // черга скінчилась
  if (n === state.pq.i) {
    audio.currentTime = 0; // повтор одного треку
    audio.play().catch(() => {});
    return;
  }
  playAt(n);
});
audio.addEventListener("loadedmetadata", () => {
  $("#plEnd").textContent = dur(audio.duration);
  pushDiscord();
  pushPosition();
});
// Саме на seeked, а не на timeupdate: системі досить знати, куди стрибнули,
// а оновлювати позицію двадцять разів на секунду — марна робота.
audio.addEventListener("seeked", pushPosition);
audio.addEventListener("timeupdate", () => {
  $("#plNow").textContent = dur(audio.currentTime);
  if (audio.duration) $("#plSeek").value = String((audio.currentTime / audio.duration) * 1000);
});
/** Щоб одна невдача не перетворилась на нескінченне перезапитування. */
let streamRetried = false;

audio.addEventListener("error", async () => {
  if (!audio.src) return;
  const t = state.playing;

  // Посилання на потік прив'язане до часу і зрідка віддає 403 раніше свого ж
  // терміну. Тоді треба не скаржитись, а перепитати yt-dlp свіже — рівно раз.
  if (t && !t.path && t.url && !streamRetried) {
    streamRetried = true;
    try {
      const fresh = await window.api.streamUrl(t.url, true);
      if (trackKey(state.playing) !== trackKey(t)) return;
      audio.src = fresh;
      audio.play().catch(() => {});
      return;
    } catch {
      /* нижче скажемо чесно */
    }
  }

  toast(
    t && !t.path
      ? "Потік не відкрився. Спробуй ще раз — YouTube зрідка віддає тимчасову помилку."
      : "Файл не відтворюється — можливо, його видалили або формат не підтримується.",
  );
});

$("#plPlay").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
$("#plPrev").addEventListener("click", () => playAt(state.pq.i - 1));
$("#plNext").addEventListener("click", () => {
  const n = nextIndex(false);
  if (n >= 0) playAt(n);
});
$("#plFav").addEventListener("click", () => toggleFav(state.playing));
$("#plRadio").addEventListener("click", () => {
  const t = state.playing;
  if (!t) return toast("Спершу увімкни трек.");
  const id = videoIdOf(t);
  if (!id) return toast("Радіо будується лише за треками YouTube Music.");
  startRadio({ ...t, id, source: "ytmusic" });
});
$("#plLyrics").addEventListener("click", toggleLyrics);
$("#plQueue").addEventListener("click", toggleQueuePanel);
$("#queueClose").addEventListener("click", () => ($("#queuePanel").hidden = true));

$("#queueBody").addEventListener("click", (e) => {
  const row = e.target.closest("[data-qi]");
  if (!row) return;
  const i = Number(row.dataset.qi);

  const act = e.target.closest("[data-qact]")?.dataset.qact;
  if (act === "up") return queueMove(i, -1);
  if (act === "down") return queueMove(i, 1);
  if (act === "drop") return queueDrop(i);

  // Клік по самому рядку — перейти до цього треку.
  if (i !== state.pq.i) playAt(i);
});

/**
 * Гарячі клавіші. Свідомо не чіпаємо їх, коли фокус у полі вводу — інакше
 * пробіл у назві плейлиста ставив би музику на паузу.
 */
document.addEventListener("keydown", (e) => {
  if (!$("#askModal").hidden || !$("#tagModal").hidden || !$("#plModal").hidden) return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.code === "Space") {
    e.preventDefault();
    if (state.playing) (audio.paused ? audio.play() : audio.pause());
    return;
  }
  if (e.code === "ArrowRight" && audio.duration) {
    audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    return;
  }
  if (e.code === "ArrowLeft" && audio.duration) {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
    return;
  }
  if (e.code === "KeyN") {
    const n = nextIndex(false);
    if (n >= 0) playAt(n);
    return;
  }
  if (e.code === "KeyP" && state.pq.i > 0) playAt(state.pq.i - 1);
  if (e.code === "KeyL") toggleLyrics();
  if (e.code === "KeyQ") toggleQueuePanel();
  if (e.code === "KeyF" && state.playing) toggleFav(state.playing);
});
$("#lyricsClose").addEventListener("click", () => ($("#lyricsPanel").hidden = true));
$("#plShuffle").addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  syncModeBtns();
  syncNavBtns();
  window.api.setSettings({ shuffle: state.shuffle }).catch(() => {});
});
$("#plRepeat").addEventListener("click", () => {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  syncModeBtns();
  syncNavBtns();
  window.api.setSettings({ repeat: state.repeat }).catch(() => {});
});
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
    if (act === "playnext") return playNext(index.get(rowKey));
    if (act === "toplaylist") return openPlModal([index.get(rowKey)]);
    if (act === "radio") return startRadio(index.get(rowKey));
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
    if (lb.dataset.lact === "playnext") return playNext(track);
    if (lb.dataset.lact === "toplaylist") return openPlModal([track]);
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

  // --- серце: працює однаково для файлів і для треків із пошуку ---
  const fb = e.target.closest("[data-fav]");
  if (fb) {
    const row = fb.closest("[data-key],[data-path]");
    const t = row?.dataset.path
      ? state.library.tracks.find((x) => x.path === row.dataset.path)
      : index.get(row?.dataset.key);
    return toggleFav(t);
  }

  // --- головна ---
  const hb = e.target.closest("[data-hact]");
  if (hb) {
    if (hb.dataset.hact === "mix") return openMix(hb.dataset.id, hb.dataset.title);
    if (hb.dataset.hact === "histclear") {
      if (!confirm("Очистити історію прослуханого?")) return;
      return window.api.histClear().then(() => {
        state.history = [];
        render();
      });
    }
    if (hb.dataset.hact === "histplay") {
      const key = hb.closest("[data-hist]")?.dataset.hist;
      const t = state.history.find((x) => x.key === key);
      if (!t) return;
      // Локальний файл беремо зі Сховища — у ньому свіжі теги й тривалість.
      const local = t.path && state.library.tracks.find((x) => x.path === t.path);
      return play(local || t, state.history);
    }
    if (hb.dataset.hact === "homeback") {
      state.view = { type: "empty" };
      return render();
    }
    if (hb.dataset.hact === "playmix") {
      const list = state.mixTracks || [];
      if (list.length) play(list[0], list);
      return;
    }
    if (hb.dataset.hact === "grabmix") {
      if (!state.mixId) return;
      // Одним завданням, а не півсотнею окремих: так yt-dlp качає список
      // послідовно, показує «трек X з Y» і складає все в теку добірки.
      return enqueue([
        {
          kind: "album",
          title: state.mixTitle || "Добірка",
          artist: "",
          thumb: state.mixTracks?.[0]?.thumb || null,
          url: `https://music.youtube.com/playlist?list=${state.mixId}`,
        },
      ]);
    }
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
      return askText({ title: "Новий плейлист", label: "Назва", ok: "Створити" }).then(async (name) => {
        if (!name) return;
        state.playlists = await window.api.plCreate(name);
        render();
        toast(`Плейлист «${name}» створено. Додавай треки кнопкою «У плейлист» у Сховищі.`, [], 6000);
      });
    }
    if (act === "rename") {
      const cur = state.playlists.find((p) => p.id === id);
      return askText({ title: "Перейменувати", label: "Назва", value: cur?.name || "" }).then(async (name) => {
        if (!name) return;
        state.playlists = await window.api.plRename(id, name);
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
      const key = pb.closest("[data-pkey]")?.dataset.pkey;
      return window.api.plRemoveTrack(id, key).then((list) => {
        state.playlists = list;
        render();
      });
    }
    if (act === "plplay") {
      const key = pb.closest("[data-pkey]")?.dataset.pkey;
      const list = plTracks(state.playlists.find((p) => p.id === state.openPl));
      const t = list.find((x) => (trackKey(x) || x.key) === key);
      if (t && !t.missing) play(t, list.filter((x) => !x.missing));
      return;
    }
    if (act === "plgrab") {
      const pl = state.playlists.find((p) => p.id === state.openPl);
      const list = plTracks(pl);
      const need = list.filter((t) => !t.path && t.url);
      if (!need.length) return toast("Усі треки цього плейлиста вже на диску.");
      const have = list.length - need.length;
      enqueue(need);
      if (have) toast(`Пропущено ${plural(have, TRACKS)} — вони вже на диску.`, [], 5000);
      return;
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
  if (btn || lb || jb || pb || hb || fb) return;

  // Клік по рядку історії — просто вмикає його.
  const histRowEl = e.target.closest("[data-hist]");
  if (histRowEl) {
    const t = state.history.find((x) => x.key === histRowEl.dataset.hist);
    if (t) {
      const local = t.path && state.library.tracks.find((x) => x.path === t.path);
      play(local || t, state.history);
    }
    return;
  }
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
  if (e.target.id === "zoom") {
    const z = Number(e.target.value);
    state.settings.zoom = z;
    window.api.setZoom(z).catch(() => {});
  }
  if (e.target.id === "ytdlpAuto") {
    state.settings.ytdlpAutoUpdate = e.target.checked;
    window.api.setSettings({ ytdlpAutoUpdate: e.target.checked });
  }
  if (e.target.id === "discordOn") {
    state.settings.discordEnabled = e.target.checked;
    window.api.setSettings({ discordEnabled: e.target.checked });
    // Без перевірки на непорожній ID: порожнє поле означає «вшитий у програму»,
    // і саме так ним користується той, хто нічого не налаштовував.
    if (!e.target.checked) window.api.discordDisconnect().catch(() => {});
    else pushDiscord();
  }
});

mainEl.addEventListener("input", (e) => {
  if (e.target.id === "libSearch") {
    state.libFilter = e.target.value;
    // Перемальовуємо лише список: інакше поле втрачає фокус на кожній літері.
    const q = norm(state.libFilter);
    const shown = q
      ? state.library.tracks.filter((t) =>
          norm(`${t.artist} ${t.title} ${t.album} ${t.file}`).includes(q),
        )
      : state.library.tracks;
    const rows = mainEl.querySelector(".rows");
    if (rows) {
      rows.innerHTML = shown.map(libRow).join("");
      loadCovers();
    } else render();
    const note = mainEl.querySelectorAll(".note")[0];
    if (note && q) note.textContent = `Знайдено ${plural(shown.length, TRACKS)} із ${plural(state.library.tracks.length, TRACKS)}`;
    return;
  }
  if (e.target.id === "discordId") {
    state.settings.discordAppId = e.target.value.trim();
    window.api.setSettings({ discordAppId: state.settings.discordAppId });
  }
});

mainEl.addEventListener("click", async (e) => {
  if (e.target.id === "ytdlpUpd") return updateYtdlp();
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
$("#selPl").addEventListener("click", () =>
  openPlModal([...state.libPicked].map((p) => state.library.tracks.find((t) => t.path === p))),
);

$("#plCancel").addEventListener("click", () => ($("#plModal").hidden = true));
$("#plModal").addEventListener("click", async (e) => {
  if (e.target.id === "plModal") return ($("#plModal").hidden = true);
  const row = e.target.closest("[data-pladd]");
  if (!row) return;
  const tracks = JSON.parse($("#plModal").dataset.tracks || "[]");
  state.playlists = await window.api.plAdd(row.dataset.pladd, tracks);
  $("#plModal").hidden = true;
  toast(`Додано в плейлист: ${plural(tracks.length, TRACKS)}`, [], 3500);
});
$("#plCreateAdd").addEventListener("click", async () => {
  const name = $("#plNewName").value.trim();
  if (!name) {
    $("#plNewName").focus();
    return;
  }
  const tracks = JSON.parse($("#plModal").dataset.tracks || "[]");
  const list = await window.api.plCreate(name);
  state.playlists = await window.api.plAdd(list[0].id, tracks);
  $("#plModal").hidden = true;
  toast(`Створено «${name}» — ${plural(tracks.length, TRACKS)}`, [], 3500);
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

// Оновлення качається саме собою; людині показуємо лише готовий результат,
// щоб не смикати її повідомленнями посеред прослуховування.
window.api.onUpdateState((s) => {
  if (s?.state !== "ready") return;
  toast(
    `Готове оновлення${s.version ? ` до версії ${s.version}` : ""}.`,
    [
      { label: "Перезапустити", primary: true, run: () => window.api.installUpdate() },
      { label: "Пізніше", run: hideToast },
    ],
    0,
  );
});

// Масштаб міняється ще й з клавіатури через меню — тримаємо вибір
// у Налаштуваннях у згоді з дійсністю.
window.api.onZoom((z) => {
  state.settings.zoom = z;
  const sel = $("#zoom");
  if (sel) sel.value = String(z);
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
  paintIcons();
  setupMediaKeys();
  const s = await window.api.getSettings();
  state.settings = s;
  $$("#sources input").forEach((cb) => (cb.checked = s.sources.includes(cb.value)));
  audio.volume = s.volume ?? 0.8;
  $("#plVol").value = String(Math.round(audio.volume * 100));
  state.shuffle = Boolean(s.shuffle);
  state.repeat = ["off", "all", "one"].includes(s.repeat) ? s.repeat : "off";
  syncModeBtns();

  const b = await window.api.binaries();
  if (!b.ok) {
    const miss = [];
    if (!b.ytdlp) miss.push("yt-dlp");
    if (!b.ffmpeg) miss.push("ffmpeg");
    const w = $("#warn");
    w.hidden = false;
    // Зібрана програма несе обидві в собі, тож сюди потрапляє переважно той,
    // хто запустив з вихідних кодів — йому й підказуємо, що робити.
    w.textContent =
      `Не знайдено: ${miss.join(", ")}. Пошук працюватиме, а завантаження — ні. ` +
      `Виконай «npm run bins» або поклади ${miss.join(" і ")} у теку app/bin.`;
  }

  // Оновлення yt-dlp минає тихо, але сказати про нього варто: інакше зміна
  // поведінки (щось раптом знову качається) виглядає випадковою.
  window.api.onYtdlpUpdated((r) => toast(`yt-dlp оновлено до ${r.version}`, [], 5000));

  state.jobs = new Map((await window.api.dlList()).map((j) => [j.id, j]));
  refreshQueueBadge();
  await loadPlaylists();
  state.favs = new Set((await window.api.favList()).map((t) => t.key));
  state.history = await window.api.histList();
  render();
  loadHome();

  // Навмисно НЕ під'єднуємось на старті: саме́ під'єднання малює в профілі
  // «грає Music» без жодної пісні. З'єднання встановиться з першим треком.

  // Сховище читаємо у фоні: воно потрібне ще й для позначки «вже є» в пошуку.
  loadLibrary();
})();
