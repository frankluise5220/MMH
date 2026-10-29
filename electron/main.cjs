// MMH Windows desktop shell (Electron main process).
//
// Responsibilities:
//   1. Spawn the bundled Next.js standalone server with the bundled portable
//      Node.js runtime (resources/node/node.exe).
//   2. Initialize the local SQLite database under %APPDATA%\MMH before the
//      server starts (resources/app/scripts/init-sqlite.cjs).
//   3. Wait for the server to become ready, then open the main window at
//      http://127.0.0.1:<port>.
//   4. Keep the server lifecycle tied to the app: quitting the app stops the
//      server; a crashed server shows an error and exits the app.
//
// The Next.js application code is untouched; this shell only hosts it.

const { app, BrowserWindow, dialog, ipcMain, session: electronSession } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");
// CancellationError / CancellationToken come from electron-updater's own runtime
// dependency (already shipped in the asar, see electron-builder.yml files).
const { CancellationError, CancellationToken } = require("builder-util-runtime");
// File-level updater: replaces resources\app and relaunches, no installer.
const appUpdater = require("./app-updater.cjs");

const isPackaged = app.isPackaged;

// Resolve the data directory: <installDir>\data when writable (packaged),
// projectRoot\data in dev, falling back to %APPDATA%\MMH otherwise.
function resolveDataDir() {
  const candidates = [];
  if (isPackaged) {
    const installDir = path.dirname(process.resourcesPath);
    candidates.push(path.join(installDir, "data"));
  } else {
    candidates.push(path.join(projectRoot, "data"));
  }
  candidates.push(path.join(app.getPath("appData"), "MMH"));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".write-test");
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return candidates[candidates.length - 1];
}

const resourcesDir = process.resourcesPath;
const projectRoot = path.join(__dirname, "..");

// Where the standalone server + portable node live.
const appDir = isPackaged
  ? path.join(resourcesDir, "app")
  : path.join(projectRoot, ".next", "standalone");
// The standalone server and the SQLite bootstrap only need Node semantics, not
// the Electron API. In a packaged build we therefore reuse Electron's own
// binary in ELECTRON_RUN_AS_NODE mode instead of shipping a second ~83 MB Node
// runtime under resources/node. This is only possible because better-sqlite3 is
// now N-API based (v13 ships one platform binary that loads in both runtimes).
const nodeExe = isPackaged
  ? process.execPath
  : path.join(
      projectRoot,
      "release-artifacts",
      "win",
      "node22",
      "node-v22.23.2-win-x64",
      "node.exe",
    );
const nodeRuntimeEnv = isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {};
const iconPath = isPackaged
  ? path.join(resourcesDir, "icon.png")
  : path.join(projectRoot, "public", "branding", "mmh-logo-pwa-512.png");

// The version the user is actually running. A file-level update replaces only
// resources\app, so the asar keeps reporting the shell that shipped the
// installer; the payload's own .mmh-version is authoritative after an update.
const runtimeVersion = appUpdater.readRuntimeVersion(appDir, app.getVersion());

// Sandboxed preload bridging the renderer to the updater via IPC.
const preloadPath = isPackaged
  ? path.join(__dirname, "preload.cjs")
  : path.join(projectRoot, "electron", "preload.cjs");

// The update download window: a static local page plus its own narrow preload,
// so the progress UI never depends on the Next.js server being reachable.
const updateWindowHtmlPath = isPackaged
  ? path.join(__dirname, "update-window.html")
  : path.join(projectRoot, "electron", "update-window.html");
const updateWindowPreloadPath = isPackaged
  ? path.join(__dirname, "update-preload.cjs")
  : path.join(projectRoot, "electron", "update-preload.cjs");

const userDataDir = resolveDataDir();
app.setPath("userData", userDataDir);
// Cookies / localStorage / disk cache follow `sessionData`, not `userData`.
// Electron 44 happens to derive sessionData from userData, but that linkage is a
// default, not a contract, and the difference is invisible until a user finds a
// Chromium profile in C:\Users\...\AppData\Roaming\MMH again. Pin it explicitly:
// the whole profile (Network\Cookies included) lives next to mmh.db, so it moves
// with the install directory and disappears with it.
app.setPath("sessionData", userDataDir);
const dbFile = path.join(userDataDir, "mmh.db");
const logFile = path.join(userDataDir, "logs", "main.log");

// Desktop-only config (LAN access etc.). Stored next to the database so it
// travels with the user's data and survives reinstalls.
const desktopConfigPath = path.join(userDataDir, "desktop-config.json");
function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(desktopConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    return { allowLan: Boolean(parsed.allowLan) };
  } catch {
    return { allowLan: false };
  }
}
const desktopConfig = readDesktopConfig();
const bindHost = desktopConfig.allowLan ? "0.0.0.0" : "127.0.0.1";
// Desktop app uses its own port (17777) so it never collides with the dev
// server (7777) running on the same machine.
const port = Number(process.env.MMH_PORT || 17777);

let serverProc = null;
let mainWindow = null;
let quitting = false;

// Update-download window state (see the "Update window" section below).
let updateWindow = null;
let updateWindowState = { phase: "idle" };
// NSIS channel (electron-updater): cancellation token of the in-flight download.
let downloadCancellation = null;
let downloadVersion = "";
// File-level channel: staged payload waiting for the restart, and the flag its
// download loop polls for cancellation.
let pendingAppUpdate = null;
let appUpdateCancel = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + "\n", "utf8");
  } catch {
    // Logging must never break startup.
  }
  console.log(line);
}

function dbUrl() {
  return "file:" + dbFile.replace(/\\/g, "/");
}

// Where an MMH database from a previous install directory may still live.
//
// The data directory is `<installDir>\data` for a packaged build, so installing
// to a different folder (or reinstalling after the installer's default moved
// between D:\MMH and %LOCALAPPDATA%\Programs\MMH) produced an empty database
// while the old books were still on disk, just in the *previous* install
// directory ("新装之后看不到以前的账簿"). These paths are therefore read-only
// *candidates* to offer the user — see migrateLegacyData for why nothing here is
// ever picked automatically.
function legacyDataCandidates() {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
  const list = [
    path.join(app.getPath("appData"), "MMH"), // legacy Electron userData
    path.join("D:\\", "MMH", "data"), // installer default when a D: drive exists
    path.join(localAppData, "Programs", "MMH", "data"), // per-user default install
    path.join(process.env.ProgramFiles || "C:\\Program Files", "MMH", "data"),
    // Uninstall moves <installDir>\data here before removing the directory and
    // restores it afterwards; if the restore never ran, the data is still here.
    path.join(process.env.TEMP || path.join(localAppData, "Temp"), "MMH-data-backup"),
  ];
  return list.filter((dir) => path.resolve(dir) !== path.resolve(userDataDir));
}

// A real book-keeping database is hundreds of KB at the very least (the native
// schema alone is far bigger), while a freshly initialised shell is much
// smaller. Reading the size also avoids opening (and thus locking) a candidate.
const MIN_REAL_DB_SIZE = 64 * 1024;

function formatStamp(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

function describeLegacyDatabase(item) {
  return (
    item.file + " (" + Math.round(item.size / 1024) + " KB, 修改于 " + formatStamp(item.mtime) + ")"
  );
}

// Every existing database in the candidate directories, most recently written
// first. Recency — not size — is what identifies the book the user was actually
// working in: a stale copy can easily be the bigger one (more history), so
// "largest wins" is exactly the wrong heuristic and must not decide anything.
function findLegacyDatabases() {
  const found = [];
  for (const dir of legacyDataCandidates()) {
    const candidate = path.join(dir, "mmh.db");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size >= MIN_REAL_DB_SIZE) {
        found.push({ dir, file: candidate, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch {
      // Not there; keep scanning.
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || b.size - a.size);
  return found;
}

// 2026-10-28 incident: this used to *silently* copy the largest candidate over
// the current database whenever the current file was missing or still an empty
// shell. With two install directories the two copies fought over one book: the
// install that started first imported a stale copy from the other directory and
// the books the user was actually working in disappeared ("数据被换掉了").
//
// Rules from now on, no exceptions:
//   1. An existing database file is authoritative and is NEVER touched, not even
//      when it looks small or empty — anything unexpected is reported, not
//      "repaired" by overwriting it.
//   2. Import happens only when the current data directory has no database at
//      all, and only after the user explicitly picks a file, and only in a
//      packaged build (dev/CI never blocks on a dialog).
//   3. The source file is copied, never moved, and the choice is recorded in
//      legacy-import.json so a later "where did my books go" is answerable.
function migrateLegacyData() {
  if (fs.existsSync(dbFile)) return; // Rule 1: never touch a database that exists.
  const found = findLegacyDatabases();
  if (found.length === 0) return;

  for (const item of found) {
    log("Database found outside the data directory: " + describeLegacyDatabase(item));
  }
  if (!isPackaged) {
    log("Dev build: not importing automatically. Copy one of the files above to " + dbFile + " manually if you want it.");
    return;
  }

  const options = found.slice(0, 3);
  const skipLabel = "跳过（使用新的空账簿）";
  let choice = -1;
  try {
    choice = dialog.showMessageBoxSync({
      type: "question",
      title: "发现已有账簿数据",
      message: "当前数据目录里还没有数据库文件。",
      detail:
        "在下列位置发现了已有的 mmh.db（按修改时间从新到旧）：\n\n" +
        options
          .map((item, index) => `${index + 1}. ${item.file}\n    ${Math.round(item.size / 1024)} KB，修改于 ${formatStamp(item.mtime)}`)
          .join("\n\n") +
        "\n\n选中的文件会被【复制】到：\n" +
        dbFile +
        "\n\n原文件保持不动；如果你不确定，请选择跳过，然后再手动确认。",
      buttons: [...options.map((_, index) => `导入第 ${index + 1} 份`), skipLabel],
      defaultId: options.length, // Default to the safe answer, not to an import.
      cancelId: options.length,
      noLink: true,
    });
  } catch (error) {
    log("Legacy import prompt failed: " + (error && error.message ? error.message : error));
    return;
  }
  if (choice < 0 || choice >= options.length) {
    log("User skipped the legacy database import.");
    return;
  }

  const chosen = options[choice];
  try {
    // Re-check right before copying: the server may already have created one,
    // and creating a database is never a reason to overwrite it.
    if (fs.existsSync(dbFile)) {
      log("Aborted legacy import: " + dbFile + " appeared while the prompt was open.");
      return;
    }
    fs.copyFileSync(chosen.file, dbFile);
    // The session secret travels with the database so existing logins keep
    // working. desktop-config.json is deliberately NOT copied: allowLan is a
    // per-install network exposure decision, not book data.
    try {
      const secretFrom = path.join(chosen.dir, "mmh-session-secret");
      const secretTo = path.join(userDataDir, "mmh-session-secret");
      if (fs.existsSync(secretFrom) && !fs.existsSync(secretTo)) {
        fs.copyFileSync(secretFrom, secretTo);
      }
    } catch {
      // Optional companion; the database is what matters.
    }
    try {
      fs.writeFileSync(
        path.join(userDataDir, "legacy-import.json"),
        JSON.stringify(
          {
            importedAt: new Date().toISOString(),
            copiedFrom: chosen.file,
            copiedTo: dbFile,
            bytes: chosen.size,
            sourceModifiedAt: new Date(chosen.mtime).toISOString(),
            candidates: found.map((item) => describeLegacyDatabase(item)),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // An audit trail is nice to have; a failed write must not abort startup.
    }
    log("Imported database on user request: " + chosen.file + " -> " + dbFile + " (" + Math.round(chosen.size / 1024) + " KB)");
  } catch (error) {
    log("Database import failed: " + (error && error.message ? error.message : error));
  }
}

function isPortInUse() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// The standalone server requires MMH_SESSION_SECRET in production. Persist a
// random secret next to the database so sessions survive app restarts.
function ensureSessionSecret() {
  const secretFile = path.join(userDataDir, "mmh-session-secret");
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    const secret = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(secretFile, secret, { encoding: "utf8", mode: 0o600 });
    return secret;
  } catch (error) {
    log("Failed to persist session secret, generating in-memory: " + error.message);
    return crypto.randomBytes(32).toString("base64");
  }
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function runInitSqlite() {
  return new Promise((resolve, reject) => {
    const initScript = path.join(appDir, "scripts", "init-sqlite.cjs");
    if (!fs.existsSync(initScript)) {
      log("init-sqlite.cjs not found, skipping database init");
      resolve();
      return;
    }
    log("Initializing SQLite database at " + dbFile);
    const child = spawn(nodeExe, [initScript], {
      cwd: appDir,
      env: {
        ...process.env,
        ...nodeRuntimeEnv,
        DATABASE_URL: dbUrl(),
        MMH_DATA_DIR: userDataDir,
      },
      windowsHide: true,
    });
    let stderr = "";
    child.stdout.on("data", (d) => log("[init] " + String(d).trim()));
    child.stderr.on("data", (d) => {
      stderr += String(d);
      log("[init] " + String(d).trim());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("SQLite init failed with code " + code + ": " + stderr.trim()));
      }
    });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(nodeExe)) {
      reject(new Error("Bundled Node runtime missing: " + nodeExe));
      return;
    }
    if (!fs.existsSync(path.join(appDir, "server.js"))) {
      reject(new Error("Standalone server missing: " + path.join(appDir, "server.js")));
      return;
    }
    const env = {
      ...process.env,
      ...nodeRuntimeEnv,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: bindHost,
      DATABASE_URL: dbUrl(),
      MMH_DEPLOY_TARGET: "windows",
      // Cross-channel base-path contract: this shell opens MMH at
      // http://127.0.0.1:<port>/ with no path, so no prefix may apply. Pinning
      // it keeps the runtime view identical to the build even when the desktop
      // app is launched from a shell that still carries a fnOS MMH_BASE_PATH.
      MMH_BASE_PATH: "",
      MMH_APP_VERSION: runtimeVersion,
      MMH_DATA_DIR: userDataDir,
      MMH_SESSION_SECRET: ensureSessionSecret(),
    };
    log("Starting server on " + bindHost + ":" + port + " (allowLan=" + desktopConfig.allowLan + ")");
    serverProc = spawn(nodeExe, ["server.js"], {
      cwd: appDir,
      env,
      windowsHide: true,
    });
    serverProc.stdout.on("data", (d) => log("[server] " + String(d).trim()));
    serverProc.stderr.on("data", (d) => log("[server] " + String(d).trim()));
    serverProc.on("error", reject);
    serverProc.on("exit", (code, signal) => {
      log("Server exited code=" + code + " signal=" + signal);
      if (!quitting) {
        // A payload that cannot boot right after an update must not leave the
        // user with a dead app: restore the previous resources\app and retry
        // once (rollback() refuses a second run via the state file).
        if (isPackaged && restorePreviousPayload("server exited")) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showErrorBox(
            "MMH 服务已停止",
            "本地服务异常退出（code=" + code + "），应用将关闭。请重新打开 MMH 重试。",
          );
        }
        app.quit();
      }
    });
    waitForReady(resolve, reject, 45000);
  });
}

function waitForReady(resolve, reject, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const ping = () => {
    if (Date.now() > deadline) {
      reject(new Error("Server did not become ready within " + timeoutMs + "ms"));
      return;
    }
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 1500 },
      (res) => {
        res.resume();
        log("Server ready (HTTP " + res.statusCode + ")");
        resolve();
      },
    );
    req.on("error", () => setTimeout(ping, 400));
    req.on("timeout", () => {
      req.destroy();
    });
  };
  ping();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    title: "MMH",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });
  mainWindow.loadURL("http://127.0.0.1:" + port);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// End the desktop session for real.
//
// The web logout route only clears the four session cookies over HTTP, and
// Chromium keeps cookie mutations in memory before flushing them to
// `Network\Cookies`. When the user logs out and closes the window right away,
// the deletion can be lost: the next launch reads the old cookie from disk and
// goes straight to the overview (reported 2026-10-29 — "点退出登录停在 /login，
// 关窗重开直接进概览"). Clearing the default session here and flushing
// immediately makes the logout survive an app restart.
async function endDesktopSession() {
  const target = electronSession.defaultSession;
  if (!target) return { ok: false };
  await target.clearStorageData({ storages: ["cookies"] });
  await target.flushStorageData();
  log("Desktop session cleared (logout).");
  return { ok: true };
}

// Push an update lifecycle event to the renderer (settings page), if open.
function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mmh:update-status", payload);
  }
}

// ---------------------------------------------------------------- Update window
//
// Downloading used to be invisible: after choosing "下载" in the "发现新版本"
// prompt, the shell fetched the whole installer in the background and the user
// only heard about it again when a second dialog appeared minutes later — no
// progress, no size, no way to stop it.
//
// This window owns that phase: percentage, transferred/total, speed, ETA, a
// "取消下载" button that aborts the transfer through an electron-updater
// CancellationToken, and the restart decision once the file is ready.
//
// Closing the window (X) deliberately does NOT abort the download: it keeps
// running in the background, the taskbar progress bar stays visible, and the
// completion dialog takes over. Only the explicit button cancels, so an
// accidental click can't waste a nearly finished 160 MB transfer.
const UPDATE_WINDOW_WIDTH = 460;
const UPDATE_WINDOW_HEIGHT = 320;

function pushUpdateWindowState(state) {
  updateWindowState = state;
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send("mmh:update-window-state", state);
  }
}

// Taskbar progress (0..1, or -1 to clear). Windows-only in practice, harmless
// elsewhere, and it is the only feedback left once the window is closed.
function setTaskbarProgress(progress) {
  for (const win of [mainWindow, updateWindow]) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.setProgressBar(progress);
    } catch {
      // Ignore: some window managers reject progress bars.
    }
  }
}

function openUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    if (updateWindow.isMinimized()) updateWindow.restore();
    updateWindow.show();
    updateWindow.focus();
    return updateWindow;
  }
  updateWindow = new BrowserWindow({
    width: UPDATE_WINDOW_WIDTH,
    height: UPDATE_WINDOW_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: true,
    autoHideMenuBar: true,
    title: "MMH 更新",
    icon: iconPath,
    backgroundColor: "#ffffff",
    show: false,
    // Keep it tied to the main window so it can never hide behind the app it
    // is updating, but not modal: the app stays usable while downloading.
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: updateWindowPreloadPath,
    },
  });
  if (typeof updateWindow.removeMenu === "function") updateWindow.removeMenu();
  updateWindow.loadFile(updateWindowHtmlPath);
  updateWindow.once("ready-to-show", () => {
    if (!updateWindow || updateWindow.isDestroyed()) return;
    updateWindow.show();
  });
  // A window created mid-download must land on the current screen, not on a
  // blank "preparing" page.
  updateWindow.webContents.on("did-finish-load", () => {
    pushUpdateWindowState(updateWindowState);
  });
  updateWindow.on("closed", () => {
    updateWindow = null;
  });
  return updateWindow;
}

function isCancellation(error) {
  return (
    error instanceof CancellationError ||
    (error && error.name === "CancellationError") ||
    (error && /cancell?ed/i.test(String(error.message || "")))
  );
}

// Installer channel (fallback). Only used when a release cannot be delivered as
// files (new Electron/Chromium, manifest says requiresInstaller): the user is
// told that this version has to be reinstalled, and electron-updater downloads
// the NSIS installer as before.
//
// `downloadUpdate` is called with a CancellationToken so the window's 取消
// button can abort it; a second call while a download is in flight is ignored
// (electron-updater would reuse the same promise anyway).
function startInstallerDownload(version) {
  if (downloadCancellation) {
    openUpdateWindow();
    return;
  }
  downloadVersion = version || "";
  openUpdateWindow();
  pushUpdateWindowState({
    phase: "downloading",
    version: downloadVersion,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
  });
  const token = new CancellationToken();
  downloadCancellation = token;
  autoUpdater
    .downloadUpdate(token)
    .then(() => {
      // The update-downloaded handler owns the success screen.
    })
    .catch((error) => {
      if (isCancellation(error)) {
        log("Update download cancelled by user");
        setTaskbarProgress(-1);
        pushUpdateWindowState({ phase: "cancelled", version: downloadVersion });
        return;
      }
      const message = error && error.message ? error.message : String(error);
      log("Update download failed: " + message);
      setTaskbarProgress(-1);
      pushUpdateWindowState({ phase: "error", version: downloadVersion, message });
    })
    .finally(() => {
      if (downloadCancellation === token) downloadCancellation = null;
    });
}

// File-level channel: download the app payload, verify it and stage it next to
// the running install. Nothing is swapped until the user restarts.
function startAppUpdateDownload(manifest) {
  if (pendingAppUpdate || appUpdateCancel) {
    openUpdateWindow();
    return;
  }
  const version = String(manifest.version);
  const cancelFlag = { cancelled: false };
  appUpdateCancel = cancelFlag;
  downloadVersion = version;
  openUpdateWindow();
  pushUpdateWindowState({
    phase: "downloading",
    version,
    percent: 0,
    transferred: 0,
    total: Number(manifest.size) || 0,
    bytesPerSecond: 0,
  });
  appUpdater
    .stageUpdate({
      manifest,
      resourcesDir: resourcesDir,
      isCancelled: () => cancelFlag.cancelled,
      onProgress: (progress) => {
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
        sendUpdateStatus({ type: "progress", percent });
        pushUpdateWindowState({
          phase: "downloading",
          version,
          percent,
          transferred: progress.transferred || 0,
          total: progress.total || Number(manifest.size) || 0,
          bytesPerSecond: progress.bytesPerSecond || 0,
        });
        setTaskbarProgress(percent / 100);
      },
    })
    .then((result) => {
      if (result.cancelled) {
        log("App update download cancelled by user");
        setTaskbarProgress(-1);
        pushUpdateWindowState({ phase: "cancelled", version });
        return;
      }
      if (!result.ok) {
        log("App update download failed: " + result.error);
        setTaskbarProgress(-1);
        pushUpdateWindowState({ phase: "error", version, message: result.error });
        sendUpdateStatus({ type: "error", message: result.error || "" });
        return;
      }
      pendingAppUpdate = { stageDir: result.stageDir, version };
      log("App update " + version + " staged at " + result.stageDir);
      setTaskbarProgress(-1);
      sendUpdateStatus({ type: "downloaded", version });
      pushUpdateWindowState({ phase: "downloaded", version });
      if (updateWindow && !updateWindow.isDestroyed()) {
        if (updateWindow.isMinimized()) updateWindow.restore();
        updateWindow.show();
        updateWindow.focus();
      }
    })
    .finally(() => {
      if (appUpdateCancel === cancelFlag) appUpdateCancel = null;
    });
}

function cancelUpdateDownload() {
  let cancelled = false;
  if (appUpdateCancel) {
    appUpdateCancel.cancelled = true;
    cancelled = true;
  }
  if (downloadCancellation) {
    downloadCancellation.cancel();
    cancelled = true;
  }
  return cancelled;
}

// Restart into the update.
//
// File-level: the staged payload is swapped into resources\app and the app
// relaunches itself — no installer runs, which is the whole point of the
// channel. Installer channel: electron-updater hands over to NSIS as before.
function installUpdateNow() {
  if (pendingAppUpdate) {
    const staged = pendingAppUpdate;
    const result = appUpdater.commitStaged({
      resourcesDir: resourcesDir,
      stageDir: staged.stageDir,
      fromVersion: runtimeVersion,
      toVersion: staged.version,
      userDataDir: userDataDir,
    });
    if (!result.ok) {
      log("Applying app update failed: " + result.error);
      pushUpdateWindowState({ phase: "error", version: staged.version, message: result.error });
      return;
    }
    log("App update " + staged.version + " applied; relaunching");
    pendingAppUpdate = null;
    quitting = true;
    app.relaunch();
    app.exit(0);
    return;
  }
  log("Restarting to install update " + downloadVersion + " (installer)");
  // Let the current IPC turn finish before the windows are torn down.
  setImmediate(() => autoUpdater.quitAndInstall());
}

// Put the previous resources\app back when the freshly swapped payload cannot
// boot, then relaunch once. Returns true when a relaunch was started.
function restorePreviousPayload(reason) {
  const result = appUpdater.rollback({ resourcesDir, userDataDir, log });
  if (!result.rolledBack) return false;
  log("Restored the previous app payload after " + reason + "; relaunching " + (result.version || ""));
  quitting = true;
  app.relaunch();
  app.exit(0);
  return true;
}

// Old feed fallback: no manifest on the server (not published yet, or the upload
// was forgotten). Reporting "already latest" here would silently strand clients,
// so ask electron-updater instead and route the answer through the installer
// channel — which is exactly what a release without a file-level payload is.
async function checkInstallerFeed(reason) {
  suppressAvailableDialog = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = (result && result.updateInfo && result.updateInfo.version) || "";
    if (version && appUpdater.compareVersions(version, runtimeVersion) > 0) {
      log("Using the installer feed (" + reason + "): " + version);
      return { mode: "installer", version, reason };
    }
    return { mode: "latest", version: runtimeVersion };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/no update|up to date|latest/i.test(message)) return { mode: "latest", version: runtimeVersion };
    return { mode: "unusable", reason: reason + " / " + message };
  } finally {
    suppressAvailableDialog = false;
  }
}

// Decide which channel a release uses. The manifest is the single source of
// truth; when it is missing the installer feed takes over, and when it is older
// than the running payload the answer is simply "no update" (an old feed must
// never trigger a downgrade).
async function checkForAppUpdate() {
  let manifest;
  try {
    manifest = await appUpdater.fetchManifest();
  } catch (error) {
    return checkInstallerFeed(
      "no app manifest: " + (error && error.message ? error.message : error),
    );
  }
  const verdict = appUpdater.evaluateManifest({
    manifest,
    runtimeVersion,
    electronVersion: process.versions.electron,
    appId: appUpdater.APP_ID,
  });
  return { ...verdict, manifest, version: String(manifest.version || "") };
}

function closeUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
}

// Settings page（系统更新）的「下载更新」入口: the click already is the
// confirmation, so this path must not pop the "发现新版本 → 下载/稍后" dialog a
// second time. It re-checks first because the page may have gone stale, then
// hands the transfer to the update window like any other download.
let suppressAvailableDialog = false;

async function downloadUpdateFromPage() {
  if (pendingAppUpdate || appUpdateCancel || downloadCancellation) {
    openUpdateWindow();
    return { ok: true, started: true, resumed: true, version: downloadVersion };
  }
  const verdict = await checkForAppUpdate();
  if (verdict.mode === "latest") return { ok: true, upToDate: true, version: runtimeVersion };
  if (verdict.mode === "files") {
    startAppUpdateDownload(verdict.manifest);
    return { ok: true, started: true, version: verdict.version };
  }
  if (verdict.mode === "installer") {
    suppressAvailableDialog = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = (result && result.updateInfo && result.updateInfo.version) || verdict.version;
      startInstallerDownload(version);
      return { ok: true, started: true, version, requiresInstaller: true };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (/no update|up to date|latest/i.test(message)) return { ok: true, upToDate: true };
      return { ok: false, error: message };
    } finally {
      suppressAvailableDialog = false;
    }
  }
  return { ok: false, error: verdict.reason || "无法获取更新信息" };
}

// Startup / manual check: ask the update feed what is available and route it to
// the channel that can deliver it. File-level updates need no installer; only a
// release that changes the Electron framework asks the user to reinstall.
async function promptForAppUpdate() {
  const verdict = await checkForAppUpdate();
  if (verdict.mode === "unusable") {
    log("App update check skipped: " + verdict.reason);
    return verdict;
  }
  if (verdict.mode === "latest") {
    sendUpdateStatus({ type: "not-available", version: runtimeVersion });
    return verdict;
  }
  log("App update available: " + verdict.version + " (" + verdict.mode + ")");
  sendUpdateStatus({ type: "available", version: verdict.version });
  if (!mainWindow || mainWindow.isDestroyed()) return verdict;

  if (verdict.mode === "installer") {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "发现新版本（需重新安装）",
      message: "MMH " + verdict.version + " 已发布，这个版本必须重新安装客户端。",
      detail:
        "该版本更新了应用运行框架（Electron），无法通过替换文件完成。下载安装包后覆盖安装即可，安装目录和记账数据都会保留。",
      buttons: ["下载安装包", "稍后"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return verdict;
    suppressAvailableDialog = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = (result && result.updateInfo && result.updateInfo.version) || verdict.version;
      startInstallerDownload(version);
    } catch (error) {
      log("Installer download failed to start: " + (error && error.message ? error.message : error));
    } finally {
      suppressAvailableDialog = false;
    }
    return verdict;
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "发现新版本",
    message: "MMH " + verdict.version + " 已发布，是否现在下载？",
    detail: "下载完成后重启应用即可完成更新，不需要重新安装，记账数据不受影响。",
    buttons: ["下载", "稍后"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) startAppUpdateDownload(verdict.manifest);
  return verdict;
}

// Check for updates in the background and prompt the user when a new version
// is available. Downloads and installs via the NSIS helper installer.
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    log("Update available: " + info.version);
    sendUpdateStatus({ type: "available", version: info.version });
    // The settings page's own 「下载更新」 button is already the confirmation.
    if (suppressAvailableDialog) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "发现新版本",
        message: "MMH " + info.version + " 已发布，是否现在下载？",
        detail: "下载完成后重启应用即可完成更新，记账数据不受影响。",
        buttons: ["下载", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        // The download itself is owned by the update window: it shows progress
        // and can be cancelled, instead of transferring silently.
        if (response === 0) startInstallerDownload(info.version);
      });
  });
  autoUpdater.on("update-not-available", (info) => {
    log("No update available (current: " + info.version + ")");
    sendUpdateStatus({ type: "not-available", version: info.version });
  });
  autoUpdater.on("download-progress", (p) => {
    const percent = Math.max(0, Math.min(100, Math.round(p.percent)));
    sendUpdateStatus({ type: "progress", percent });
    pushUpdateWindowState({
      phase: "downloading",
      version: downloadVersion,
      percent,
      transferred: p.transferred || 0,
      total: p.total || 0,
      bytesPerSecond: p.bytesPerSecond || 0,
    });
    setTaskbarProgress(percent / 100);
  });
  autoUpdater.on("update-downloaded", (info) => {
    log("Update downloaded: " + info.version);
    sendUpdateStatus({ type: "downloaded", version: info.version });
    setTaskbarProgress(-1);
    // The window that ran the download also owns the restart decision, so the
    // user is not interrupted by a second modal on top of it.
    if (updateWindow && !updateWindow.isDestroyed()) {
      pushUpdateWindowState({ phase: "downloaded", version: info.version });
      if (updateWindow.isMinimized()) updateWindow.restore();
      updateWindow.show();
      updateWindow.focus();
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "更新已就绪",
        message: "MMH " + info.version + " 已下载完成，重启应用完成更新。",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) installUpdateNow();
      });
  });
  autoUpdater.on("error", (err) => {
    const message = err && err.message ? err.message : String(err);
    log("Auto-update error: " + message);
    sendUpdateStatus({ type: "error", message });
    pushUpdateWindowState({ phase: "error", version: downloadVersion, message });
  });

  // Update window actions (electron/update-preload.cjs).
  ipcMain.handle("mmh:update-cancel", () => ({ ok: cancelUpdateDownload() }));
  ipcMain.handle("mmh:update-install", () => {
    installUpdateNow();
    return { ok: true };
  });
  ipcMain.handle("mmh:update-close", () => {
    closeUpdateWindow();
    return { ok: true };
  });
  ipcMain.handle("mmh:update-state", () => updateWindowState);

  // Settings page actions (electron/preload.cjs → 设置 → 系统更新). The Windows
  // build updates through Electron, never through the git/Docker update API.
  ipcMain.handle("mmh:download-update", () => downloadUpdateFromPage());
  ipcMain.handle("mmh:open-update-window", () => {
    openUpdateWindow();
    return { ok: true };
  });

  // Renderer-initiated update check (settings page "检查更新" button). Answer
  // from the same manifest the startup prompt uses, so the page and the prompt
  // can never disagree about the available version or its channel.
  ipcMain.handle("mmh:check-for-updates", async () => {
    const verdict = await checkForAppUpdate();
    if (verdict.mode === "latest") return { ok: true, upToDate: true, version: runtimeVersion };
    if (verdict.mode === "files" || verdict.mode === "installer") {
      sendUpdateStatus({ type: "available", version: verdict.version });
      return {
        ok: true,
        version: verdict.version,
        requiresInstaller: verdict.mode === "installer",
      };
    }
    return { ok: false, error: verdict.reason || "无法获取更新信息" };
  });
  ipcMain.handle("mmh:get-version", () => runtimeVersion);

  // Delay the check so startup is never blocked by a slow update server.
  setTimeout(() => {
    promptForAppUpdate().catch((error) => {
      log("App update check failed: " + (error && error.message ? error.message : error));
    });
  }, 5000);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    // Logout bridge (electron/preload.cjs → sidebar 用户菜单「退出登录」).
    ipcMain.handle("mmh:end-session", async () => {
      try {
        return await endDesktopSession();
      } catch (error) {
        log("Failed to clear desktop session: " + (error && error.message ? error.message : error));
        return { ok: false };
      }
    });
    // Always record which database this launch is about to use. "数据不见了"
    // reports are unanswerable without it, and it makes an accidental data-dir
    // switch obvious in logs/main.log.
    try {
      const stat = fs.statSync(dbFile);
      log("Using database " + dbFile + " (" + Math.round(stat.size / 1024) + " KB, 修改于 " + formatStamp(stat.mtimeMs) + ")");
    } catch {
      log("No database at " + dbFile + " yet; it will be created empty.");
    }
    migrateLegacyData();
    // Repair an interrupted file-level update before anything else runs: it may
    // have left resources\app renamed away, in which case nothing can start.
    if (isPackaged) {
      const recovery = appUpdater.recoverOnBoot({
        resourcesDir,
        userDataDir,
        runtimeVersion,
        log,
      });
      if (recovery.restored) log("App payload restored, now running " + recovery.version);
      appUpdater.cleanupStale(resourcesDir, null);
    }
    if (await isPortInUse()) {
      throw new Error("Port " + port + " is already in use by another process. Close other MMH instances and retry.");
    }
    await runInitSqlite();
    await startServer();
    // The new payload booted: the previous one is no longer needed.
    if (isPackaged) appUpdater.finalizeBoot({ resourcesDir, userDataDir, log });
    createWindow();
    if (isPackaged) setupAutoUpdater();
  } catch (error) {
    log("Startup failed: " + (error && error.stack ? error.stack : String(error)));
    if (isPackaged && restorePreviousPayload("startup failed")) return;
    dialog.showErrorBox("MMH 启动失败", String((error && error.message) || error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

let storageFlushed = false;

app.on("before-quit", (event) => {
  quitting = true;
  // Cookie/storage mutations (a logout, most importantly) live in Chromium's
  // memory until they are flushed to `Network\Cookies`. Quitting immediately
  // after a logout lets the deleted session cookie come back from disk on the
  // next launch, which is exactly the 2026-10-29 report ("退出登录后关窗重开
  // 直接进概览"). Defer the real quit once, so the flush has time to reach disk.
  if (!storageFlushed && electronSession.defaultSession) {
    event.preventDefault();
    storageFlushed = true;
    try {
      electronSession.defaultSession.flushStorageData();
    } catch {
      // Never block quitting.
    }
    setTimeout(() => app.quit(), 400);
    return;
  }
  if (serverProc && serverProc.pid) {
    try {
      if (process.platform === "win32") {
        // Kill the whole process tree so the standalone server cannot linger
        // as an orphan holding the port after the app exits.
        const { spawnSync } = require("child_process");
        spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        serverProc.kill();
      }
    } catch {
      // ignore
    }
  }
});
