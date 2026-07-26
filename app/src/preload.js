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
  searchSoundcloud: (query, searchId) => call("search:soundcloud", query, searchId),
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

  libScan: (dir) => call("lib:scan", dir),
  libCover: (file) => call("lib:cover", file),
  libTrash: (file) => call("lib:trash", file),
  libTags: (files, patch) => call("lib:tags", files, patch),

  onClipboardLink: (cb) => ipcRenderer.on("clipboard:link", (_e, url) => cb(url)),

  version: () => call("app:version"),
  onUpdateState: (cb) => ipcRenderer.on("update:state", (_e, s) => cb(s)),
  installUpdate: () => ipcRenderer.invoke("update:install"),

  streamUrl: (url, force) => call("stream:url", url, force),

  radio: (videoId) => call("reco:radio", videoId),
  home: () => call("reco:home"),
  mix: (playlistId) => call("reco:mix", playlistId),
  lyrics: (videoId) => call("reco:lyrics", videoId),

  favList: () => call("fav:list"),
  favToggle: (track) => call("fav:toggle", track),
  histList: () => call("hist:list"),
  histAdd: (track) => call("hist:add", track),
  histClear: () => call("hist:clear"),

  plList: () => call("pl:list"),
  plCreate: (name) => call("pl:create", name),
  plRename: (id, name) => call("pl:rename", id, name),
  plRemove: (id) => call("pl:remove", id),
  plAdd: (id, paths) => call("pl:add", id, paths),
  plRemoveTrack: (id, path) => call("pl:removeTrack", id, path),

  discordConnect: (appId) => call("discord:connect", appId),
  discordDisconnect: () => call("discord:disconnect"),
  discordStatus: () => call("discord:status"),
  discordActivity: (track) => call("discord:activity", track),

  getSettings: () => call("settings:get"),
  setSettings: (patch) => call("settings:set", patch),

  chooseFolder: () => call("dialog:folder"),
  reveal: (file) => call("shell:reveal", file),
  openFolder: (dir) => call("shell:openFolder", dir),
  openExternal: (url) => call("shell:external", url),
});
