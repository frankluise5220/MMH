// Preload for the hidden update-source dialog (electron/updater-feed.html).
//
// Same sandbox rules as update-preload.cjs: contextBridge only, no Node access
// in the page. The dialog can read the effective feed, replace it (persisted in
// desktop-config.json), and close itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mmhUpdaterFeed", {
  get: () => ipcRenderer.invoke("mmh:updater-feed-get"),
  save: (value) => ipcRenderer.invoke("mmh:updater-feed-set", value),
  close: () => ipcRenderer.invoke("mmh:updater-feed-close"),
});
