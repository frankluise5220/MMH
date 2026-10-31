#!/usr/bin/env node

// Windows 文件级更新的「换目录」行为验证（真实 fs + 真实子进程，不模拟）。
//
// 2026-10-31 用户实测 0.1.79：下载条跑完后点「立即重启」，弹
//   ebusy: resource busy or locked, rename 'D:\MMH\resources\app' -> '...app.old-0.1.78-...'
// 原因不是权限，而是 resources\app 被本地 Next.js 服务占用（该服务的 cwd 就是
// 这个目录，better_sqlite3.node 也映射在它里面）。所以这里验证三件事：
//   1. 占用在几百毫秒内消失（服务被杀之后）时，commitStaged 靠重试能成功换目录；
//   2. 占用一直存在时，commitStaged 必须【放弃且不动现场】，不能半途把 app 挪走；
//   3. 换到一半中断（app 不在、备份还在）时，recoverOnBoot 能把旧 payload 复位。
//
// 第 2 条只在 Windows 上有意义：POSIX 允许重命名一个「仍是别人 cwd」的目录，
// Windows 不允许 —— 这正是这个 bug 的平台性。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const appUpdater = require(path.join(__dirname, "..", "electron", "app-updater.cjs"));

const isWindows = process.platform === "win32";
const failures = [];
const cleanups = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A throwaway <root>\resources\{app,.app-new-<v>} install, like the real one. */
function makeInstall({ fromVersion = "0.1.78", toVersion = "0.1.79", staged = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-swap-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const app = path.join(resources, "app");
  fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(app, "server.js"), "// old payload");
  fs.writeFileSync(path.join(app, ".mmh-version"), fromVersion + "\n");
  fs.writeFileSync(path.join(app, "node_modules", "better_sqlite3.node"), "old-mapped-binary");
  const stage = path.join(resources, ".app-new-" + toVersion);
  if (staged) {
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "server.js"), "// new payload");
    fs.writeFileSync(path.join(stage, ".mmh-version"), toVersion + "\n");
  }
  return { root, resources, app, stage, userData: path.join(root, "data") };
}

/**
 * A live process that looks like the bundled server from the filesystem's point
 * of view: its working directory is `dir` (EBUSY on the parent rename) and it
 * keeps a file below `dir` open (EPERM).
 */
function holdLikeTheServer(dir, holdMs) {
  const script =
    "const fs=require('fs');" +
    "const fd=fs.openSync(process.argv[1],'r');" +
    "setTimeout(()=>{fs.closeSync(fd)}, " +
    holdMs +
    ");";
  const child = spawn(process.execPath, ["-e", script, path.join(dir, "node_modules", "better_sqlite3.node")], {
    cwd: dir,
    stdio: "ignore",
    windowsHide: true,
  });
  cleanups.push(() => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  });
  return child;
}

function backups(resources) {
  return fs
    .readdirSync(resources)
    .filter((name) => name.startsWith("app.old-"))
    .map((name) => path.join(resources, name));
}

async function caseTransientLock() {
  const install = makeInstall();
  const logs = [];
  const child = holdLikeTheServer(install.app, 700);
  await sleep(400); // the holder is definitely inside the directory by now

  const result = await appUpdater.commitStaged({
    resourcesDir: install.resources,
    stageDir: install.stage,
    fromVersion: "0.1.78",
    toVersion: "0.1.79",
    userDataDir: install.userData,
    log: (line) => logs.push(line),
  });
  expect(result.ok, "commitStaged must wait out a lock that is released within a few hundred ms, got: " + result.error);
  expect(
    fs.readFileSync(path.join(install.app, "server.js"), "utf8") === "// new payload",
    "the new payload must be in place after a successful swap",
  );
  expect(
    fs.readFileSync(path.join(install.app, ".mmh-version"), "utf8").trim() === "0.1.79",
    "the runtime version must come from the swapped-in payload",
  );
  const kept = backups(install.resources);
  expect(kept.length === 1, "the previous payload must be kept as app.old-* until it boots, found " + kept.length);
  if (kept.length === 1) {
    expect(
      fs.readFileSync(path.join(kept[0], "server.js"), "utf8") === "// old payload",
      "the backup must contain the previous payload",
    );
  }
  const state = appUpdater.readState(install.userData);
  expect(state && state.phase === "applied", "the swap must leave phase=applied so a failed boot can roll back");
  if (isWindows) {
    expect(logs.some((line) => /EBUSY|EPERM|EACCES/.test(line)), "a locked rename must be retried and logged (got: " + logs.join(" | ") + ")");
  }

  // Booting the new payload drops the backup and the pending state.
  appUpdater.finalizeBoot({ resourcesDir: install.resources, userDataDir: install.userData, log: () => {} });
  expect(backups(install.resources).length === 0, "finalizeBoot must delete the previous payload once the new one booted");
  expect(appUpdater.readState(install.userData) === null, "finalizeBoot must clear the pending update state");

  child.kill();
}

async function casePermanentLock() {
  if (!isWindows) {
    console.log("Skipping the permanent-lock case: renaming a live process's cwd is allowed on " + process.platform + ".");
    return;
  }
  const install = makeInstall();
  holdLikeTheServer(install.app, 8000);
  await sleep(400);

  const result = await appUpdater.commitStaged({
    resourcesDir: install.resources,
    stageDir: install.stage,
    fromVersion: "0.1.78",
    toVersion: "0.1.79",
    userDataDir: install.userData,
    retry: { attempts: 3, baseDelayMs: 50 },
  });
  expect(!result.ok, "commitStaged must refuse to swap while the directory is still busy");
  expect(
    /无法替换安装文件/.test(String(result.error)) && /EBUSY|EPERM|EACCES/.test(String(result.error)),
    "a refused swap must name the busy code so the user can act on it, got: " + result.error,
  );
  expect(
    fs.readFileSync(path.join(install.app, "server.js"), "utf8") === "// old payload",
    "a refused swap must leave the running install untouched",
  );
  expect(backups(install.resources).length === 0, "a refused swap must not leave the app renamed away");
  expect(appUpdater.readState(install.userData) === null, "a refused swap must not record update state");
}

async function caseMissingPayload() {
  const install = makeInstall({ staged: false });
  const result = await appUpdater.commitStaged({
    resourcesDir: install.resources,
    stageDir: install.stage,
    fromVersion: "0.1.78",
    toVersion: "0.1.79",
    userDataDir: install.userData,
  });
  expect(!result.ok && /更新包/.test(String(result.error)), "a missing staged payload must be reported, not swapped in");
  expect(
    fs.readFileSync(path.join(install.app, "server.js"), "utf8") === "// old payload",
    "a missing staged payload must leave the running install untouched",
  );
}

async function caseInterruptedSwap() {
  const install = makeInstall();
  // Half-finished swap: the old payload was renamed away, the new one never
  // arrived (crash / power loss between the two renames).
  const backup = path.join(install.resources, "app.old-0.1.78-1234");
  fs.renameSync(install.app, backup);

  const recovery = appUpdater.recoverOnBoot({
    resourcesDir: install.resources,
    userDataDir: install.userData,
    runtimeVersion: "0.1.78",
    log: () => {},
  });
  expect(recovery.restored, "recoverOnBoot must report the restore of an interrupted swap");
  expect(
    fs.readFileSync(path.join(install.app, "server.js"), "utf8") === "// old payload",
    "recoverOnBoot must put the previous payload back when app is missing",
  );
  expect(backups(install.resources).length === 0, "the restored backup must not be left behind a second time");
}

(async () => {
  await caseTransientLock();
  await casePermanentLock();
  await caseMissingPayload();
  await caseInterruptedSwap();
})()
  .catch((error) => {
    failures.push("unhandled error: " + (error && error.stack ? error.stack : error));
  })
  .finally(() => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
    if (failures.length > 0) {
      console.error("App-updater swap verification failed:");
      for (const failure of failures) console.error(" - " + failure);
      process.exit(1);
    }
    console.log("App-updater swap verification passed.");
  });
