"use strict";
/**
 * Єдиний місток між інтерфейсом і системою. Інтерфейс не має доступу ані до
 * Node, ані до файлів — тільки до перелічених нижче викликів.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Розпаковує {ok,data|error} у звичайне значення або виняток. */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r?.ok) throw new Error(r?.error || "Невідома помилка");
  return r.data;
}

contextBridge.exposeInMainWorld("api", {
  binaries: () => call("binaries:status"),

  search: (query, sources, searchId) => call("search:query", query, sources, searchId),
  cancelSearch: (searchId) => call("search:cancel", searchId),
  album: (id) => call("search:album", id),
  artist: (id) => call("search:artist", id),
  resolveCatalog: (item) => call("search:resolveCatalog", item),
  mbReleases: (mbid) => call("search:mbReleases", mbid),

  dlAdd: (items, opts) => call("dl:add", items, opts),
  dlCancel: (id) => call("dl:cancel", id),
  dlRetry: (id) => call("dl:retry", id),
  dlList: () => call("dl:list"),
  dlClear: () => call("dl:clear"),
  onDlUpdate: (cb) => ipcRenderer.on("dl:update", (_e, job) => cb(job)),

  getSettings: () => call("settings:get"),
  setSettings: (patch) => call("settings:set", patch),

  chooseFolder: () => call("dialog:folder"),
  reveal: (file) => call("shell:reveal", file),
  openFolder: (dir) => call("shell:openFolder", dir),
  openExternal: (url) => call("shell:external", url),
});
