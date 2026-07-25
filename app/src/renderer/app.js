"use strict";

const $ = (sel) => document.querySelector(sel);
const mainEl = $("#main");

const state = {
  tab: "songs",
  results: { songs: [], albums: [], artists: [] },
  view: { type: "empty" },
  /** ключ -> об'єкт треку; сам Set лише зберігає порядок вибору */
  picked: new Map(),
  settings: { outDir: "", format: "mp3" },
  jobs: new Map(),
  /** null або ідентифікатор пошуку, що зараз виконується (для «Стоп») */
  searchId: null,
};

// ------------------------------------------------------------------ дрібниці

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function dur(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function size(bytesPerSec) {
  if (!bytesPerSec) return "";
  const mb = bytesPerSec / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} МБ/с` : `${(bytesPerSec / 1024).toFixed(0)} КБ/с`;
}

function keyOf(it) {
  return `${it.source}:${it.id}`;
}

const SRC_NAME = {
  ytmusic: "YT Music",
  soundcloud: "SoundCloud",
  itunes: "iTunes",
  musicbrainz: "MusicBrainz",
  url: "посилання",
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

function img(url, cls) {
  return `<img class="${cls}" src="${esc(url || BLANK)}" alt="" />`;
}

function loading(text) {
  mainEl.innerHTML = `<div class="empty"><div class="spinner"></div><p>${esc(text)}</p></div>`;
}

function fail(text) {
  mainEl.innerHTML = `<div class="note err">${esc(text)}</div>`;
}

// ------------------------------------------------------------------ малювання

function songRow(s) {
  const k = keyOf(s);
  const on = state.picked.has(k);
  return `
    <div class="row${on ? " sel" : ""}" data-key="${esc(k)}">
      <input type="checkbox" data-act="pick" ${on ? "checked" : ""} />
      ${img(s.thumb, "art")}
      <div class="name">
        <b>${esc(s.title)}${badge(s.source)}</b>
        <span class="sub">${esc(s.artist)}</span>
      </div>
      <div class="alb">${esc(s.album || "")}</div>
      <div class="dur">${dur(s.duration)}</div>
      <div class="act">
        <button data-act="dl-one" class="primary">Завантажити</button>
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
      ${img(a.thumb, "cover")}
      <div class="t">${esc(a.name)}</div>
      <div class="s">${esc(a.subtitle || "")}</div>
      <div class="s">${badge(a.source)}</div>
    </div>`;
}

/** Реєстр усього, що зараз намальовано — щоб клік знав, з чим має справу. */
let index = new Map();

function reindex(...lists) {
  for (const list of lists) for (const it of list || []) index.set(keyOf(it), it);
}

function renderResults() {
  const r = state.results;
  reindex(r.songs, r.albums, r.artists);

  $("#tabs").hidden = false;
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === state.tab);
    t.querySelector(".cnt").textContent = r[t.dataset.tab].length;
  });

  const list = r[state.tab];
  if (!list.length) {
    mainEl.innerHTML = `<div class="empty"><div class="empty-ico">∅</div><p>Тут нічого не знайшлося. Спробуй іншу вкладку або інший запит.</p></div>`;
    return;
  }

  if (state.tab === "songs") {
    mainEl.innerHTML = `<div class="rows">${list.map(songRow).join("")}</div>`;
  } else if (state.tab === "albums") {
    mainEl.innerHTML = `<div class="grid">${list.map(albumCard).join("")}</div>`;
  } else {
    mainEl.innerHTML = `<div class="grid">${list.map(artistCard).join("")}</div>`;
  }
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
        <div class="sub">${esc([a.artist, a.year, `${a.songs.length} треків`].filter(Boolean).join(" · "))}</div>
        <div class="btns">
          <button class="primary" data-act="dl-album" data-key="${esc(keyOf(a))}" ${canGrab ? "" : "disabled"}>
            Завантажити альбом
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
      ${img(a.thumb, "cover")}
      <div class="meta">
        <div class="sub">Виконавець ${badge(a.source)}</div>
        <h1>${esc(a.name)}</h1>
        <div class="btns">
          <button class="ghost" data-act="pick-all">Вибрати популярні треки</button>
        </div>
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
      ${img(a.thumb, "cover")}
      <div class="meta">
        <div class="sub">Виконавець ${badge(a.source)}</div>
        <h1>${esc(a.name)}</h1>
        <div class="sub">${esc(a.subtitle || "")}</div>
      </div>
    </div>
    <div class="note">Це дискографія з каталогу MusicBrainz — вона повніша за YouTube, але сам звук треба знайти. Клікни на альбом, і додаток пошукає його в YouTube&nbsp;Music.</div>
    ${releases.length ? `<div class="grid">${releases.map(albumCard).join("")}</div>` : `<div class="note">Релізів не знайдено.</div>`}`;
}

function render() {
  const v = state.view;
  if (v.type === "results") renderResults();
  else if (v.type === "album") renderAlbum(v.data);
  else if (v.type === "artist") renderArtist(v.data);
  else if (v.type === "catalogArtist") renderCatalogArtist(v.artist, v.releases);
  refreshSelbar();
}

function refreshSelbar() {
  const n = state.picked.size;
  $("#selbar").hidden = n === 0;
  $("#selCount").textContent = `${n} вибрано`;
}

// ------------------------------------------------------------------ дії

function searchBusy(on) {
  $("#go").disabled = on;
  $("#go").textContent = on ? "Шукаю…" : "Пошук";
  $("#stop").hidden = !on;
}

async function doSearch(e) {
  e?.preventDefault();
  const q = $("#q").value.trim();
  if (!q || state.searchId) return;

  const sources = [...document.querySelectorAll("#sources input:checked")].map((i) => i.value);
  if (!sources.length) return fail("Не обрано жодного джерела.");

  const id = `s${Date.now()}`;
  state.searchId = id;
  searchBusy(true);
  state.picked.clear();
  refreshSelbar();
  loading("Шукаю по всіх джерелах…");

  try {
    const r = await window.api.search(q, sources, id);
    // Поки чекали, користувач міг натиснути «Стоп» і почати новий пошук —
    // тоді цей результат уже нікому не потрібен і малювати його не можна.
    if (state.searchId !== id) return;
    state.results = { songs: r.songs || [], albums: r.albums || [], artists: r.artists || [] };

    // Посилання дає лише треки — одразу відкриваємо потрібну вкладку,
    // інакше користувач бачить порожні «Альбоми» і думає, що нічого не знайшлось.
    if (r.mode === "url" || !state.results[state.tab].length) {
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

async function enqueue(items) {
  const good = items.filter((i) => i && i.url);
  if (!good.length) {
    alert("У цих результатів немає прямого джерела звуку — відкрий їх і завантаж через YouTube Music.");
    return;
  }
  try {
    await window.api.dlAdd(good, { outDir: state.settings.outDir, format: $("#format").value });
    $("#queue").classList.remove("collapsed");
  } catch (err) {
    alert("Не вдалося поставити в чергу: " + err.message);
  }
}

function togglePick(key, on) {
  const it = index.get(key);
  if (!it) return;
  if (on) state.picked.set(key, it);
  else state.picked.delete(key);
  document.querySelector(`.row[data-key="${CSS.escape(key)}"]`)?.classList.toggle("sel", on);
  refreshSelbar();
}

// ------------------------------------------------------------------ черга

function jobRow(j) {
  const pct = Math.round(j.percent || 0);
  let barCls = "";
  let note = "";

  if (j.status === "done") {
    barCls = "done";
    note = `<small class="ok">Готово · ${j.files.length} файл(ів)</small>`;
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
    if (j.phase === "process") parts.push("обробка (обкладинка, теги)");
    else if (j.speed) parts.push(size(j.speed));
    note = `<small>${esc(parts.join(" · ") || "починаю…")}</small>`;
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

function renderJobs() {
  const list = [...state.jobs.values()];
  $("#qBody").innerHTML = list.length
    ? list.map(jobRow).join("")
    : `<div class="note">Черга порожня.</div>`;

  // Ширину смужки задаємо через CSSOM, а не атрибутом style у розмітці:
  // атрибут блокує наша ж політика безпеки (style-src 'self'), і смужка
  // назавжди лишається на нулі, хоча файл при цьому качається нормально.
  for (const bar of $("#qBody").querySelectorAll(".bar > i")) {
    bar.style.width = bar.dataset.w + "%";
  }
  const busy = list.filter((j) => ["active", "queued", "retrying"].includes(j.status)).length;
  $("#qBadge").textContent = busy || list.length;
}

// ------------------------------------------------------------------ події

$("#searchForm").addEventListener("submit", doSearch);
$("#stop").addEventListener("click", stopSearch);

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    state.tab = t.dataset.tab;
    state.view = { type: "results" };
    render();
  }),
);

mainEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const rowKey = btn.closest("[data-key]")?.dataset.key;

  if (act === "pick") return togglePick(rowKey, btn.checked);
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
    mainEl.querySelectorAll('.row input[data-act="pick"]').forEach((cb) => {
      if (!cb.checked) {
        cb.checked = true;
        togglePick(cb.closest(".row").dataset.key, true);
      }
    });
  }
});

// Клік по рядку (а не по кнопці) теж перемикає галочку — так швидше вибирати.
mainEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-act]")) return;
  const row = e.target.closest(".row");
  if (!row) return;
  const cb = row.querySelector('input[data-act="pick"]');
  cb.checked = !cb.checked;
  togglePick(row.dataset.key, cb.checked);
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
  state.picked.clear();
  document.querySelectorAll('.row input[data-act="pick"]').forEach((cb) => (cb.checked = false));
  document.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
  refreshSelbar();
});

$("#selDl").addEventListener("click", () => {
  const items = [...state.picked.values()];
  state.picked.clear();
  document.querySelectorAll('.row input[data-act="pick"]').forEach((cb) => (cb.checked = false));
  document.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
  refreshSelbar();
  enqueue(items);
});

$("#queueHead").addEventListener("click", (e) => {
  if (e.target.closest("button") && e.target.id !== "qToggle") return;
  $("#queue").classList.toggle("collapsed");
});

$("#qClear").addEventListener("click", async () => {
  const left = await window.api.dlClear();
  state.jobs = new Map(left.map((j) => [j.id, j]));
  renderJobs();
});

$("#qOpen").addEventListener("click", () => window.api.openFolder(state.settings.outDir));

$("#qBody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-jact]");
  if (!b) return;
  const job = state.jobs.get(b.dataset.id);
  if (b.dataset.jact === "cancel") window.api.dlCancel(b.dataset.id);
  if (b.dataset.jact === "retry") window.api.dlRetry(b.dataset.id);
  if (b.dataset.jact === "reveal" && job?.files[0]) window.api.reveal(job.files[0]);
});

$("#folderBtn").addEventListener("click", async () => {
  const dir = await window.api.chooseFolder();
  if (dir) {
    state.settings.outDir = dir;
    $("#folderName").textContent = dir.split(/[\\/]/).pop();
    $("#folderBtn").title = dir;
  }
});

$("#format").addEventListener("change", () => window.api.setSettings({ format: $("#format").value }));

document.querySelectorAll("#sources input").forEach((cb) =>
  cb.addEventListener("change", () =>
    window.api.setSettings({
      sources: [...document.querySelectorAll("#sources input:checked")].map((i) => i.value),
    }),
  ),
);

window.api.onDlUpdate((job) => {
  state.jobs.set(job.id, job);
  renderJobs();
});

// ------------------------------------------------------------------ старт

(async function init() {
  const s = await window.api.getSettings();
  state.settings = s;
  $("#format").value = s.format;
  $("#folderName").textContent = s.outDir.split(/[\\/]/).pop() || s.outDir;
  $("#folderBtn").title = s.outDir;
  document.querySelectorAll("#sources input").forEach((cb) => {
    cb.checked = s.sources.includes(cb.value);
  });

  const b = await window.api.binaries();
  if (!b.ok) {
    const miss = [];
    if (!b.ytdlp) miss.push("yt-dlp");
    if (!b.ffmpeg) miss.push("ffmpeg");
    const w = $("#warn");
    w.hidden = false;
    w.textContent =
      `Не знайдено: ${miss.join(", ")}. Пошук у YouTube Music, iTunes і MusicBrainz працюватиме, ` +
      `а завантаження — ні. Поклади ${miss.join(" і ")} у теку bin поруч із програмою.`;
  }

  state.jobs = new Map((await window.api.dlList()).map((j) => [j.id, j]));
  renderJobs();
  $("#q").focus();
})();
