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
  // Start (or resume) the download. The main process owns it from there: it
  // re-checks, opens the update window and streams progress into it.
  downloadUpdate: () => ipcRenderer.invoke("mmh:download-update"),
  // Restart into the installer that was already downloaded.
  installUpdate: () => ipcRenderer.invoke("mmh:update-install"),
  // Bring the download window back to the front (user closed it earlier).
  showDownloadWindow: () => ipcRenderer.invoke("mmh:open-update-window"),
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
