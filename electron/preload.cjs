// MMH Windows desktop preload (sandboxed).
//
// Runs in the renderer with context isolation + sandbox enabled, so it only
// gets the tiny subset of Electron APIs allowed in a sandboxed preload:
// `contextBridge` and `ipcRenderer`. It exposes a narrow, typed bridge so the
// web settings page can trigger an update check and subscribe to results,
// without ever granting the page Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mmhDesktop", {
  // Ask the main process to check for updates. Resolves with a status string.
  checkForUpdates: () => ipcRenderer.invoke("mmh:check-for-updates"),
  // Current app version (from Electron's app.getVersion()).
  getVersion: () => ipcRenderer.invoke("mmh:get-version"),
  // Subscribe to update lifecycle events pushed from the main process.
  // Returns an unsubscribe function.
  onUpdateStatus: (callback) => {
    const handler = (_event, data) => {
      try {
        callback(data);
      } catch {
        // A throwing subscriber must never break the IPC listener.
      }
    };
    ipcRenderer.on("mmh:update-status", handler);
    return () => ipcRenderer.removeListener("mmh:update-status", handler);
  },
});
