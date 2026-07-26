"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require("electron");

const binaries = require("./binaries");
const search = require("./search");
const downloads = require("./download");
const settings = require("./settings");
const library = require("./library");
const tags = require("./tags");
const stream = require("./stream");
const playlists = require("./playlists");
const personal = require("./personal");
const { Discord } = require("./discord");

const discord = new Discord();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#12121a",
    title: "Music Grabber",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Помилки інтерфейсу інакше лишаються всередині вікна: якщо додаток
  // запущено з MG_DEBUG=1, вони йдуть у консоль, звідки їх видно.
  if (process.env.MG_DEBUG) {
    win.webContents.on("console-message", (_e, level, message, line, src) => {
      const tag = ["log", "warn", "ERROR"][level] || level;
      console.log(`[renderer/${tag}] ${message}  (${String(src).split("/").pop()}:${line})`);
    });
    win.webContents.on("render-process-gone", (_e, d) => console.log("[renderer] впав:", d.reason));
  }
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Посилання «відкрити на YouTube» мають іти в системний браузер,
  // а не підміняти вікно додатка.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

/**
 * Меню потрібне не для краси: без нього в Electron не працюють гарячі клавіші
 * буфера обміну, і Ctrl+V у полі пошуку мовчить.
 */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Правка",
        submenu: [
          { role: "undo", label: "Скасувати" },
          { role: "redo", label: "Повторити" },
          { type: "separator" },
          { role: "cut", label: "Вирізати" },
          { role: "copy", label: "Копіювати" },
          { role: "paste", label: "Вставити" },
          { role: "selectAll", label: "Виділити все" },
        ],
      },
      {
        label: "Вигляд",
        submenu: [
          { role: "reload", label: "Перезавантажити" },
          { role: "toggleDevTools", label: "Інструменти розробника" },
          { type: "separator" },
          { role: "resetZoom", label: "Звичайний масштаб" },
          { role: "zoomIn", label: "Більше" },
          { role: "zoomOut", label: "Менше" },
          { type: "separator" },
          { role: "togglefullscreen", label: "На весь екран" },
        ],
      },
    ]),
  );
}

// ------------------------------------------------------------------ IPC

/** Обгортка: помилка в будь-якому обробнику має доїхати до інтерфейсу текстом. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
}

handle("binaries:status", () => binaries.status());

handle("search:query", async (query, sources, searchId) => {
  const q = String(query || "").trim();
  if (!q) throw new Error("Порожній запит");

  if (search.looksLikeUrl(q)) {
    // Spotify та Apple Music віддають захищений потік — yt-dlp там безсилий.
    // Тому не вдаємо, ніби качаємо звідти: беремо назви й шукаємо в YT Music.
    if (search.bridgeProvider(q)) {
      const r = await search.resolveBridge(q, searchId);
      return {
        mode: "bridge",
        title: r.meta.name,
        bridge: { ...r.meta, items: undefined },
        missing: r.missing,
        songs: r.songs,
        albums: [],
        artists: [],
        errors: [],
      };
    }
    const res = await search.resolveUrl(q, searchId);
    return { mode: "url", title: res.title, songs: res.songs, albums: [], artists: [], errors: [] };
  }
  return { mode: "search", ...(await search.searchAll(q, sources, searchId)) };
});

handle("search:cancel", (searchId) => search.cancel(searchId));

handle("search:album", (id) => search.getAlbum(id));
handle("search:artist", (id) => search.getArtist(id));
handle("search:resolveCatalog", (item) => search.resolveCatalogItem(item));
handle("search:mbReleases", (mbid) => search.musicbrainzReleases(mbid));

handle("dl:add", (items, opts) => {
  const s = settings.load();
  return downloads.add(items, {
    outDir: opts?.outDir || s.outDir,
    format: opts?.format || s.format,
    albumFolder: opts?.albumFolder ?? s.albumFolder,
  });
});
handle("dl:cancel", (id) => downloads.cancel(id));
handle("dl:retry", (id) => downloads.retry(id));
handle("dl:list", () => downloads.list());
handle("dl:clear", () => downloads.clearFinished());

handle("settings:get", () => settings.load());
handle("settings:set", (patch) => settings.save(patch));

handle("dialog:folder", async () => {
  const s = settings.load();
  const r = await dialog.showOpenDialog(win, {
    title: "Куди зберігати музику",
    defaultPath: s.outDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return settings.save({ outDir: r.filePaths[0] }).outDir;
});

handle("lib:scan", (dir) => library.scan(dir || settings.load().outDir));

/**
 * @param {Array<{path: string, title: string}>} items файли з їхніми поточними назвами
 * @param {object} patch спільні зміни для всіх
 */
handle("lib:tags", async (items, patch) => {
  const results = [];
  for (const it of items) {
    // При масовій правці назву не задають (вона своя в кожного файлу), але
    // перейменувати треба все одно — тож підставляємо назву самого файлу.
    const own = { ...patch };
    if (own.rename && !own.title) own.title = it.title;
    if (own.rename && !own.artist) own.artist = it.artist;

    try {
      const r = await tags.write(it.path, own);
      library.forget(it.path);
      library.forget(r.path);
      // Плейлист посилається на шлях, тож після перейменування його треба
      // полагодити — інакше трек тихо зникне зі списку.
      if (r.renamed) {
        playlists.repath(it.path, r.path);
        personal.repath(it.path, r.path);
      }
      results.push({ file: it.path, ok: true, path: r.path, renamed: r.renamed });
    } catch (e) {
      // Один заблокований файл не має зривати правку решти — але й мовчати
      // про нього не можна, тому кожен результат повертаємо окремо.
      results.push({ file: it.path, ok: false, error: e.message });
    }
  }
  return results;
});

handle("lib:cover", (file) => library.cover(file));

// Саме в кошик, а не назавжди: помилковий клік не має нищити музику.
handle("lib:trash", async (file) => {
  await shell.trashItem(file);
  library.forget(file);
  return true;
});

handle("stream:url", (url, force) => stream.resolve(url, force));

handle("reco:radio", (videoId) => search.radio(videoId));
handle("reco:home", () => search.home());
handle("reco:mix", (playlistId) => search.mixTracks(playlistId));
handle("reco:lyrics", (videoId) => search.lyrics(videoId));

handle("fav:list", () => personal.favorites());
handle("fav:toggle", (track) => personal.favToggle(track));
handle("hist:list", () => personal.history());
handle("hist:add", (track) => personal.historyAdd(track));
handle("hist:clear", () => personal.historyClear());

handle("pl:list", () => playlists.load());
handle("pl:create", (name) => playlists.create(name));
handle("pl:rename", (id, name) => playlists.rename(id, name));
handle("pl:remove", (id) => playlists.remove(id));
handle("pl:add", (id, paths) => playlists.addTracks(id, paths));
handle("pl:removeTrack", (id, path) => playlists.removeTrack(id, path));

handle("discord:connect", async (appId) => {
  const id = String(appId || "").trim() || settings.BUILTIN_DISCORD_APP_ID;
  if (!id) {
    throw new Error(
      "ID додатка не вказано. Вшитого в програму теж немає — створи додаток " +
        "на discord.com/developers/applications і встав його Application ID.",
    );
  }
  await discord.connect(id);
  return true;
});
handle("discord:disconnect", () => {
  discord.setActivity(null);
  discord.disconnect();
  return true;
});
handle("discord:status", () => ({ connected: discord.connected }));
handle("discord:activity", (track) => {
  const s = settings.load();

  // Саме́ по собі під'єднання до Discord уже малює в профілі голе
  // «грає ‹назва додатка›» — ще до будь-якого статусу. Тому коли нічого не
  // грає, ми не просто знімаємо статус, а розриваємо з'єднання: інакше
  // в профілі назавжди висить назва програми без жодної пісні.
  if (!track || !s.discordEnabled) {
    discord.setActivity(null);
    discord.disconnect();
    return false;
  }

  // Підключаємось ліниво — тоді Discord, запущений уже після нашої програми,
  // все одно підхопиться з першим же треком.
  const id = settings.discordAppId(s);
  if (!discord.connected && id) discord.connect(id).catch(() => {});
  return discord.setActivity(track);
});

handle("shell:reveal", (file) => {
  if (file) shell.showItemInFolder(file);
  return true;
});
handle("shell:openFolder", (dir) => shell.openPath(dir || settings.load().outDir));
handle("shell:external", (url) => {
  if (/^https?:/.test(url)) shell.openExternal(url);
  return true;
});

downloads.bus.on("update", (job) => {
  if (win && !win.isDestroyed()) win.webContents.send("dl:update", job);
});

// ------------------------------------------------------------------ буфер обміну

const MUSIC_LINK =
  /^https?:\/\/(?:[\w-]+\.)*(youtube\.com|youtu\.be|soundcloud\.com|spotify\.com|bandcamp\.com|music\.apple\.com)\/\S+$/i;

/**
 * Стежить за буфером обміну і пропонує завантажити скопійоване посилання.
 * Те, що лежало в буфері ДО запуску, навмисно пропускаємо: інакше програма
 * вітає користувача підказкою про лінк, який він копіював годину тому.
 */
function watchClipboard() {
  let last = "";
  try {
    last = clipboard.readText() || "";
  } catch {
    /* буфер може бути зайнятий іншою програмою */
  }

  setInterval(() => {
    let text = "";
    try {
      text = (clipboard.readText() || "").trim();
    } catch {
      return;
    }
    if (text === last) return;
    last = text;
    if (!settings.load().watchClipboard) return;
    if (text.length > 500 || !MUSIC_LINK.test(text)) return;
    if (win && !win.isDestroyed()) win.webContents.send("clipboard:link", text);
  }, 1200);
}

// ------------------------------------------------------------------ старт

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    watchClipboard();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
