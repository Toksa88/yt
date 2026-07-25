"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");

const binaries = require("./binaries");
const search = require("./search");
const downloads = require("./download");
const settings = require("./settings");

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
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
