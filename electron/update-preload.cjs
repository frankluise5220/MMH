// MMH update-download window preload (sandboxed, file:// page).
//
// Deliberately separate from preload.cjs: the download window is a static local
// page that must work even if the Next.js server is unreachable, and it only
// needs three verbs — read state, cancel, restart. Exposing them here keeps the
// web app's bridge (window.mmhDesktop) free of window-lifecycle controls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mmhUpdate", {
  // Subscribe to download state pushed by the main process. Returns an
  // unsubscribe function.
  onState: (callback) => {
    const handler = (_event, data) => {
      try {
        callback(data);
      } catch {
        // A throwing subscriber must never break the IPC listener.
      }
    };
    ipcRenderer.on("mmh:update-window-state", handler);
    return () => ipcRenderer.removeListener("mmh:update-window-state", handler);
  },
  // Current state, for a window opened after the download already started.
  getState: () => ipcRenderer.invoke("mmh:update-state"),
  cancel: () => ipcRenderer.invoke("mmh:update-cancel"),
  install: () => ipcRenderer.invoke("mmh:update-install"),
  close: () => ipcRenderer.invoke("mmh:update-close"),
});
