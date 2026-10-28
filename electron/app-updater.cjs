// MMH Windows desktop — file-level application update.
//
// Why this exists (2026-10-28, user requirement): updating through the NSIS
// installer means the app downloads a ~50 MB installer, then *runs an installer*
// after the restart. The user asked for "no install step after restart — just
// restart", and that is possible here because the whole Next.js runtime is
// `resources\app` (extraResources, NOT inside the asar): server.js + .next +
// node_modules + the SQLite bootstrap. Replacing that directory and relaunching
// Electron is the entire update.
//
// What it deliberately does NOT cover: MMH.exe itself (Electron/Chromium). A
// release that needs a new Electron version cannot be delivered as files, so the
// manifest marks it `requiresInstaller` and the caller falls back to the NSIS
// channel with an explicit "该版本必须重新安装" prompt.
//
// Invariants (do not break them):
//   * Nothing is destroyed until a verified extraction exists on disk. Every
//     failure path leaves the running install untouched.
//   * No file is ever deleted until the new payload has booted once. The old
//     `app` directory is renamed (not removed) to `app.old-<from>-<ts>`, and is
//     restored if the server fails to start after the swap.
//   * The runtime version lives in `resources\app\.mmh-version`, not in
//     `app.getVersion()` — the asar keeps the version of the shell that shipped
//     the installer, which stops matching once only the payload is replaced.

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const MANIFEST_URL = "https://dl.floatingice.win/mmh-app-latest.json";
const APP_ID = "com.mmh.desktop";
const STATE_FILE = "app-update-state.json";
const BACKUP_PREFIX = "app.old-";
const STAGE_PREFIX = ".app-new-";
// Below this the file cannot be a real book-keeping database (the schema alone
// is far larger); used when deciding whether a current database is empty.
const MIN_USEFUL_DB_BYTES = 64 * 1024;

function readRuntimeVersion(appDir, fallback) {
  try {
    const value = fs.readFileSync(path.join(appDir, ".mmh-version"), "utf8").trim();
    if (/^\d+\.\d+\.\d+/.test(value)) return value.split(/\s+/)[0];
  } catch {
    // Older payloads have no .mmh-version; fall back to the shell version.
  }
  return fallback;
}

function compareVersions(a, b) {
  const parse = (v) => String(v || "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function readState(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(userDataDir, state) {
  const file = path.join(userDataDir, STATE_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // The state file only guards rollback; a failed write must not abort.
  }
}

function clearState(userDataDir) {
  try {
    fs.rmSync(path.join(userDataDir, STATE_FILE), { force: true });
  } catch {
    // ignore
  }
}

function request(url, { timeoutMs = 15000, headers } = {}) {
  const client = url.startsWith("http://") ? http : https;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), { timeoutMs, headers }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode + " for " + url));
        return;
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("timeout for " + url)));
    req.on("error", reject);
  });
}

async function fetchManifest(options = {}) {
  const url = options.url || MANIFEST_URL;
  const res = await request(url, { timeoutMs: options.timeoutMs || 8000 });
  let body = "";
  await new Promise((resolve, reject) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        res.destroy();
        reject(new Error("manifest too large"));
      }
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
  const manifest = JSON.parse(body);
  if (!manifest || typeof manifest !== "object" || !manifest.version) {
    throw new Error("manifest has no version");
  }
  return manifest;
}

/**
 * Decide how a manifest should be applied.
 * @returns {{ mode: "files" | "installer" | "latest" | "unusable", reason?: string }}
 */
function evaluateManifest({ manifest, runtimeVersion, electronVersion, appId }) {
  if (!manifest || !manifest.version) return { mode: "unusable", reason: "no version" };
  const target = String(manifest.version);
  if (manifest.appId && appId && manifest.appId !== appId) {
    return { mode: "unusable", reason: "appId mismatch" };
  }
  if (compareVersions(target, runtimeVersion) <= 0) return { mode: "latest" };
  // A new Electron/Chromium cannot be delivered by replacing resources\app.
  if (manifest.requiresInstaller) return { mode: "installer", reason: "requiresInstaller" };
  if (manifest.electron && electronVersion && manifest.electron !== electronVersion) {
    return { mode: "installer", reason: "electron " + manifest.electron + " != " + electronVersion };
  }
  if (!manifest.url || !manifest.sha512) {
    return { mode: "installer", reason: "manifest without url/sha512" };
  }
  return { mode: "files" };
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked leftover only wastes disk space; never fail the update over it.
  }
}

async function downloadToFile(url, destFile, { onProgress, isCancelled, timeoutMs = 30000 }) {
  const res = await request(url, { timeoutMs });
  const total = Number(res.headers["content-length"] || 0);
  let transferred = 0;
  let lastReport = 0;
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destFile);
    res.on("data", (chunk) => {
      transferred += chunk.length;
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        const elapsed = Math.max(1, now - startedAt) / 1000;
        if (typeof onProgress === "function") {
          onProgress({
            transferred,
            total,
            percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
            bytesPerSecond: Math.round(transferred / elapsed),
          });
        }
      }
      if (typeof isCancelled === "function" && isCancelled()) {
        res.destroy();
        out.destroy();
        reject(Object.assign(new Error("cancelled"), { cancelled: true }));
        return;
      }
      out.write(chunk);
    });
    res.on("end", () => out.end(resolve));
    res.on("error", (error) => {
      out.destroy();
      reject(error);
    });
    out.on("error", reject);
  });
  return { transferred, total };
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: stderr.trim() }));
  });
}

/**
 * Extract a zip with the always-present Windows tooling.
 * `tar.exe` (bsdtar, Windows 10 1803+) is used first because it is fast and
 * handles dotfiles; PowerShell's Expand-Archive is the fallback.
 */
async function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = await run("tar", ["-xf", zipFile, "-C", destDir]);
  if (tar.ok) return { ok: true };
  const ps = await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath " +
      JSON.stringify(zipFile) +
      " -DestinationPath " +
      JSON.stringify(destDir) +
      " -Force",
  ]);
  if (ps.ok) return { ok: true };
  return { ok: false, error: (tar.output || "") + " " + (ps.output || "") };
}

/** Remove leftover staging dirs / archives from an interrupted update. */
function cleanupStale(resourcesDir, keepStageDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(resourcesDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    const full = path.join(resourcesDir, name);
    if (keepStageDir && path.resolve(full) === path.resolve(keepStageDir)) continue;
    removeDir(full);
  }
}

function listBackups(resourcesDir) {
  try {
    return fs
      .readdirSync(resourcesDir)
      .filter((name) => name.startsWith(BACKUP_PREFIX))
      .map((name) => path.join(resourcesDir, name));
  } catch {
    return [];
  }
}

/**
 * Download + verify + extract into `resources\.app-new-<version>`.
 * Returns the staging directory; nothing outside it is touched.
 */
async function stageUpdate({ manifest, resourcesDir, onProgress, isCancelled }) {
  const version = String(manifest.version);
  const stageDir = path.join(resourcesDir, STAGE_PREFIX + version);
  const zipFile = stageDir + ".zip";
  try {
    // Download first, verify second, touch the staging dir last: a retry that
    // fails verification must leave an already staged payload intact instead of
    // turning a good update into "更新包已丢失".
    removeDir(zipFile);
    await downloadToFile(manifest.url, zipFile, { onProgress, isCancelled });
    const digest = await sha512File(zipFile);
    const expected = String(manifest.sha512 || "").toLowerCase();
    if (expected && digest.toLowerCase() !== expected) {
      removeDir(zipFile);
      return { ok: false, error: "下载文件校验失败（sha512 不匹配）" };
    }
    removeDir(stageDir);
    const extracted = await extractZip(zipFile, stageDir);
    if (!extracted.ok) {
      removeDir(stageDir);
      removeDir(zipFile);
      return { ok: false, error: "解压失败：" + (extracted.error || "").slice(0, 300) };
    }
    // The payload must at least look like the app, otherwise a bad zip would
    // brick the install the moment we swap directories.
    if (!fs.existsSync(path.join(stageDir, "server.js"))) {
      removeDir(stageDir);
      removeDir(zipFile);
      return { ok: false, error: "更新包内容不完整（缺少 server.js）" };
    }
    const stagedVersion = readRuntimeVersion(stageDir, "");
    if (stagedVersion && compareVersions(stagedVersion, version) !== 0) {
      removeDir(stageDir);
      removeDir(zipFile);
      return { ok: false, error: "更新包版本不匹配（" + stagedVersion + "）" };
    }
    removeDir(zipFile);
    return { ok: true, stageDir, version };
  } catch (error) {
    removeDir(stageDir);
    removeDir(zipFile);
    if (error && error.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Swap the staged payload in. Both steps are directory renames on the same
 * volume, so there is no window where a half-copied `app` exists: either the old
 * directory or the new one is in place.
 */
function commitStaged({ resourcesDir, stageDir, fromVersion, toVersion, userDataDir }) {
  const appDir = path.join(resourcesDir, "app");
  const backupDir = path.join(resourcesDir, BACKUP_PREFIX + fromVersion + "-" + Date.now());
  if (!fs.existsSync(path.join(stageDir, "server.js"))) {
    return { ok: false, error: "更新包已丢失，请重新下载" };
  }
  try {
    fs.renameSync(appDir, backupDir);
  } catch (error) {
    return { ok: false, error: "无法替换安装文件：" + (error.message || error) };
  }
  try {
    fs.renameSync(stageDir, appDir);
  } catch (error) {
    try {
      fs.renameSync(backupDir, appDir);
    } catch {
      // Nothing more we can do in-process; recoverOnBoot handles a missing app.
    }
    return { ok: false, error: "无法启用新版本：" + (error.message || error) };
  }
  writeState(userDataDir, {
    phase: "applied",
    fromVersion,
    toVersion,
    backupDir,
    at: new Date().toISOString(),
  });
  return { ok: true, backupDir };
}

/**
 * Startup repair, run before the server is spawned.
 *
 * `restored` means the previous swap was incomplete and the old payload is back
 * in place; the caller should still start normally.
 */
function recoverOnBoot({ resourcesDir, userDataDir, runtimeVersion, log }) {
  const appDir = path.join(resourcesDir, "app");
  const state = readState(userDataDir);
  cleanupStale(resourcesDir, null);

  // Crash between the two renames, or a half-finished manual move: without
  // `app` nothing can start, so put the newest backup back.
  if (!fs.existsSync(path.join(appDir, "server.js"))) {
    const backups = listBackups(resourcesDir).sort();
    const newest = backups[backups.length - 1];
    if (newest && fs.existsSync(path.join(newest, "server.js"))) {
      try {
        removeDir(appDir);
        fs.renameSync(newest, appDir);
        log("Recovered app payload from " + newest);
        return { restored: true, version: readRuntimeVersion(appDir, runtimeVersion) };
      } catch (error) {
        log("App payload recovery failed: " + (error.message || error));
      }
    }
    return { restored: false };
  }

  if (state && state.phase === "applied") {
    if (state.toVersion && compareVersions(runtimeVersion, state.toVersion) >= 0) {
      // The new payload is in place but has not booted yet: keep the backup
      // until the server is ready (finalizeBoot deletes it).
      log("Update " + state.toVersion + " staged in place, waiting for a clean boot");
    } else {
      // The swap never took effect; do not keep a stale pending state around.
      log("Discarding stale update state (running " + runtimeVersion + ")");
      clearState(userDataDir);
    }
  }
  return { restored: false };
}

/** Server booted: the new payload works, drop the previous one. */
function finalizeBoot({ resourcesDir, userDataDir, log }) {
  const state = readState(userDataDir);
  for (const backup of listBackups(resourcesDir)) {
    removeDir(backup);
  }
  if (state) {
    log("Update to " + (state.toVersion || "?") + " booted; previous payload removed");
    clearState(userDataDir);
  }
}

/** Server failed to boot right after a swap: put the previous payload back. */
function rollback({ resourcesDir, userDataDir, log }) {
  const state = readState(userDataDir);
  if (!state || state.phase !== "applied" || !state.backupDir) return { rolledBack: false };
  if (!fs.existsSync(path.join(state.backupDir, "server.js"))) return { rolledBack: false };
  const appDir = path.join(resourcesDir, "app");
  try {
    removeDir(appDir);
    fs.renameSync(state.backupDir, appDir);
    writeState(userDataDir, { ...state, phase: "rolledBack", at: new Date().toISOString() });
    log("Rolled back to the previous payload after a failed start");
    return { rolledBack: true, version: readRuntimeVersion(appDir, state.fromVersion) };
  } catch (error) {
    log("Rollback failed: " + (error.message || error));
    return { rolledBack: false, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  MANIFEST_URL,
  APP_ID,
  MIN_USEFUL_DB_BYTES,
  compareVersions,
  readRuntimeVersion,
  readState,
  fetchManifest,
  evaluateManifest,
  stageUpdate,
  commitStaged,
  recoverOnBoot,
  finalizeBoot,
  rollback,
  cleanupStale,
};
