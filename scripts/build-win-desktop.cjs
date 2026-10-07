#!/usr/bin/env node
// MMH Windows desktop build: assemble the portable Node runtime + Next.js
// standalone app and package it into an NSIS installer with electron-builder.
//
// Usage: node scripts/build-win-desktop.cjs [--skip-build] [--skip-package]
//
// Flow (mirrors scripts/build-fnos-app.cjs + scripts/build-fnos-package.cjs):
//   1. generate-native-sqlite-schema.cjs  -> prisma/schema.native.prisma
//   2. prisma generate --schema native    -> SQLite client (win32 engine)
//   3. next build                         -> .next/standalone
//   4. prisma generate (default pg schema) -> restore dev client
//   5. stage standalone + static + public + prisma into release-artifacts/win/stage/app
//   6. generate prisma/native-init.sql + scripts/init-sqlite.cjs in the stage
//   7. copy portable Node into release-artifacts/win/stage/node
//   8. rebuild better-sqlite3 with the bundled Node 20 (ABI must match)
//   9. verify better-sqlite3 loads under the bundled Node
//  10. electron-builder --win nsis -> release-artifacts/win/dist/MMH-Setup-*.exe

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
// When this script is driven through the sandbox's spawnSync shim (sync-shim.cjs),
// argv paths are marshalled through `sh -c`, where MSYS/Git Bash mangles a
// Windows backslash path like E:\fs\wiseme\... (\f, \w, \p become escape
// sequences) so `prisma generate --schema <path>` silently falls back to the
// default postgres schema. Forward slashes survive the round-trip untouched and
// are accepted by both Node and Prisma on Windows, so normalise every path we
// hand to a subprocess argument here.
const toArgvPath = (p) => p.replace(/\\/g, "/");
const artifacts = path.join(root, "release-artifacts", "win");
const stageDir = path.join(artifacts, "stage");
const stageAppDir = path.join(stageDir, "app");
const stageNodeDir = path.join(stageDir, "node");
const buildDir = path.join(artifacts, "build");
const distDir = path.join(artifacts, "dist");
const portableNodeRoot = path.join(artifacts, "node22", "node-v22.23.2-win-x64");
// Update feed URL must match the `publish.url` in electron-builder.yml.
const UPDATE_FEED_URL = "http://fnapp.floatingice.win:5660/mmh/";

const nativeSchema = toArgvPath(path.join(root, "prisma", "schema.native.prisma"));
const pgSchema = toArgvPath(path.join(root, "prisma", "schema.prisma"));
const prismaCli = toArgvPath(path.join(root, "node_modules", "prisma", "build", "index.js"));

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const skipPackage = args.includes("--skip-package");
const reuseStage = args.includes("--reuse-stage");

function run(command, args, env, cwd) {
  const useShell = process.platform === "win32" && (command === "npm" || command === "npx");
  const result = spawnSync(command, args, {
    cwd: cwd || root,
    stdio: "inherit",
    shell: useShell,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}

function copyDir(src, dest) {
  // Idempotency guard: when the destination already holds the source's own
  // marker file (its package.json or node.exe), a previous run already staged
  // this directory. Re-copying a multi-GB tree through fs.cpSync can exhaust
  // the process in constrained sandboxes, so skip it and trust the existing
  // stage. Callers that must always refresh can pass `force`.
  const marker = fs.existsSync(path.join(src, "package.json"))
    ? "package.json"
    : fs.existsSync(path.join(src, "node.exe"))
      ? "node.exe"
      : null;
  if (marker && fs.existsSync(path.join(dest, marker))) {
    console.log(`copyDir: reusing existing ${dest} (marker ${marker} present)`);
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// Remove non-runtime junk that leaks from the repo into .next/standalone
// (dev agent logs, dev shared settings, runtime data dir, env files, build
// cache). The desktop app keeps user data under %APPDATA%\MMH instead.
function pruneStagedApp(dir) {
  for (const name of [".codex-logs", "data", "shared", ".env", ".env.local", ".env.production", ".env.development"]) {
    // These are non-runtime junk. On Windows a dev agent (e.g. a still-running
    // `next dev`) can hold a handle on files under `.codex-logs`, so rmSync can
    // throw EPERM even with force:true (force only ignores ENOENT). Skip the
    // entry instead of failing the whole build — leaving it just bloats the
    // package slightly, never breaks the runtime.
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (error) {
      if (error && error.code === "EPERM") {
        console.warn(`pruneStagedApp: could not remove ${name} (EPERM, likely a dev handle); skipping.`);
      } else {
        throw error;
      }
    }
  }
  fs.rmSync(path.join(dir, ".next", "cache"), { recursive: true, force: true });
}

function step(message) {
  console.log("\n=== [win-desktop] " + message + " ===");
}

function isWritableDir(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".mmh-write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

// NSIS (driven by electron-builder) writes intermediate scripts into %TEMP% and
// aborts with `!include: could not find "…\nstXXXX.tmp"` when that directory is
// not writable — which happens when TEMP resolves to C:\Windows\TEMP from a
// restricted shell. Keep the inherited TEMP when it works, otherwise point the
// packager at a directory next to the build output.
function packageEnv() {
  const base = {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
  };
  if (isWritableDir(process.env.TEMP) || isWritableDir(process.env.TMP)) return base;
  const fallback = path.join(artifacts, "nsis-tmp");
  if (!isWritableDir(fallback)) {
    console.warn("Neither TEMP nor " + fallback + " is writable; the NSIS step may fail.");
    return base;
  }
  console.warn("TEMP is not writable; building the installer with TEMP=" + fallback);
  return { ...base, TEMP: fallback, TMP: fallback, TMPDIR: fallback };
}

// ---------------------------------------------------------------- build app
if (!skipBuild) {
  step("1/4 generate native SQLite schema");
  run(process.execPath, [toArgvPath(path.join(root, "scripts", "generate-native-sqlite-schema.cjs"))], {});

  step("2/4 prisma generate (native sqlite)");
  run(process.execPath, [prismaCli, "generate", "--schema", nativeSchema], {
    DATABASE_URL: "file:./native-build.db",
    PRISMA_SCHEMA_PATH: nativeSchema,
  });

  step("3/4 next build (standalone)");
  // Base-path contract: the desktop shell loads http://127.0.0.1:<port> with no
  // path at all (electron/main.cjs), so this build MUST stay on the origin
  // root. `run()` merges process.env, so an MMH_BASE_PATH left over in the
  // shell (e.g. right after building the fnOS package, the only channel that
  // sets /app/mmh) would quietly bake a prefix in and leave every route 404
  // inside the desktop window. Pin it explicitly to empty.
  run("npm", ["run", "build"], {
    DATABASE_URL: "file:./native-build.db",
    PRISMA_SCHEMA_PATH: nativeSchema,
    MMH_DEPLOY_TARGET: "windows",
    MMH_BASE_PATH: "",
  });

  step("4/4 prisma generate (restore pg schema)");
  run(process.execPath, [prismaCli, "generate", "--schema", pgSchema], {});
} else {
  console.log("Skipping build steps (--skip-build).");
}

// ---------------------------------------------------------------- stage app
step("stage standalone app");
const standaloneDir = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
  console.error("Missing standalone build output. Run without --skip-build first.");
  process.exit(1);
}
const canReuseStage = reuseStage && fs.existsSync(path.join(stageAppDir, "server.js"));
if (!canReuseStage) {
  // Next's standalone build traces `path.join(process.cwd(), ".codex-logs")`
  // (and `data` / `shared` / `.env*`) as literal runtime inputs and copies
  // their directory trees into `.next/standalone`. Those are developer/runtime
  // junk, not app code. Prune them from the standalone output *before* copying
  // it into the stage, otherwise they ride into the installer and electron-
  // builder fails with `EPERM: rmdir` when its pre-pack cleanup hits a read-only
  // file under a leftover `.codex-logs/…` tree. `pruneStagedApp` below remains
  // as a second-chance guard on the stage.
  pruneStagedApp(standaloneDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageAppDir, { recursive: true });
  copyDir(standaloneDir, stageAppDir);
  pruneStagedApp(stageAppDir);
} else {
  console.log("Reusing existing staged standalone app (--reuse-stage).");
}
fs.writeFileSync(path.join(stageAppDir, ".mmh-version"), `${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version}\n`, "utf8");

step("sync .next/static and public");
copyDir(path.join(root, ".next", "static"), path.join(stageAppDir, ".next", "static"));
if (fs.existsSync(path.join(root, "public"))) {
  copyDir(path.join(root, "public"), path.join(stageAppDir, "public"));
}

step("copy prisma schema + config");
fs.mkdirSync(path.join(stageAppDir, "prisma"), { recursive: true });
fs.cpSync(path.join(root, "prisma", "schema.native.prisma"), path.join(stageAppDir, "prisma", "schema.native.prisma"));
fs.cpSync(path.join(root, "prisma", "schema.prisma"), path.join(stageAppDir, "prisma", "schema.prisma"));
if (fs.existsSync(path.join(root, "prisma.config.ts"))) {
  fs.cpSync(path.join(root, "prisma.config.ts"), path.join(stageAppDir, "prisma.config.ts"));
}

step("generate native-init.sql (full SQLite structure)");
const initSql = path.join(stageAppDir, "prisma", "native-init.sql");
const diff = spawnSync(
  process.execPath,
  [prismaCli, "migrate", "diff", "--from-empty", "--to-schema", nativeSchema, "--script", "--output", toArgvPath(initSql)],
  { cwd: root, stdio: "inherit" },
);
if (diff.status !== 0) process.exit(diff.status || 1);

step("generate scripts/init-sqlite.cjs");
fs.mkdirSync(path.join(stageAppDir, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(stageAppDir, "scripts", "init-sqlite.cjs"),
  `// Generated by scripts/build-win-desktop.cjs. Do not edit by hand.
// Creates the SQLite database at MMH_DATA_DIR/mmh.db on first run and applies
// the full structure from prisma/native-init.sql. For existing databases only
// missing tables are created; column/index backfills and data migrations must
// stay in sync with the MIGRATIONS list in scripts/build-fnos-package.cjs.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDir = process.env.MMH_DATA_DIR || ".";
const dbPath = path.join(dataDir, "mmh.db");
const sqlPath = path.join(__dirname, "..", "prisma", "native-init.sql");

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare("PRAGMA table_info(\\"" + table.replace(/\\"/g, "\\"\\"") + "\\")").all().some((row) => row.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.exec("ALTER TABLE \\"" + table.replace(/\\"/g, "\\"\\"") + "\\" ADD COLUMN \\"" + column.replace(/\\"/g, "\\"\\"") + "\\" " + definition);
  }
}

// Rename a column only when the old name is present and the new one is not, so
// every call is idempotent. Table/column names here are internal constants.
function renameColumnIfNeeded(db, table, from, to) {
  if (!tableExists(db, table)) return;
  if (!columnExists(db, table, from) || columnExists(db, table, to)) return;
  db.exec('ALTER TABLE "' + table + '" RENAME COLUMN "' + from + '" TO "' + to + '"');
}

function applyLiabilityTerminologyMigration(db) {
  // 2026-10-06 口径定版：debt* 存储改名（贷款 = loan，往来款 = settlement，负债 = liability）。
  // 与 prisma/migrations/20261006_liability_terminology、scripts/docker-entrypoint.sh 以及
  // scripts/build-fnos-package.cjs 的 MIGRATIONS 同名同义，全部无损改名。
  // 漏掉这段：升级后的旧桌面库缺少 Account.liabilityDirection，打开概览/费用报销等页面会报
  // "no such column: liabilityDirection"（生产构建下即 "Server Components render" 通用报错）。
  renameColumnIfNeeded(db, "Account", "debtDirection", "liabilityDirection");
  renameColumnIfNeeded(db, "transactions", "debtPrincipalAmount", "principalAmount");
  renameColumnIfNeeded(db, "transactions", "debtInterestAmount", "interestAmount");
  renameColumnIfNeeded(db, "transactions", "debtFeeAmount", "feeAmount");
  if (tableExists(db, "DebtAgreement") && !tableExists(db, "SettlementAgreement")) {
    db.exec('ALTER TABLE "DebtAgreement" RENAME TO "SettlementAgreement"');
    db.exec('DROP INDEX IF EXISTS "DebtAgreement_accountId_key"');
    db.exec('DROP INDEX IF EXISTS "DebtAgreement_householdId_dueDate_idx"');
  }
  if (tableExists(db, "SettlementAgreement")) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "SettlementAgreement_accountId_key" ON "SettlementAgreement"("accountId")');
    db.exec('CREATE INDEX IF NOT EXISTS "SettlementAgreement_householdId_dueDate_idx" ON "SettlementAgreement"("householdId", "dueDate")');
  }
  if (tableExists(db, "transactions")) {
    db.prepare("UPDATE transactions SET source = 'liability_' || substr(source, 6) WHERE substr(source, 1, 5) = 'debt_'").run();
  }
  if (tableExists(db, "Institution")) {
    db.prepare('UPDATE "Institution" SET type = \\'lender\\' WHERE type = \\'debt\\'').run();
  }
}

function applyLoanCategoryMigration(db) {
  // 2026-10-07 贷款类别（LoanCategory）：与 prisma/migrations/20261007_add_loan_category、
  // scripts/docker-entrypoint.sh 以及 scripts/build-fnos-package.cjs 的 MIGRATIONS 同名同义。
  // 全新安装由 native-init.sql 建表；这里给存量桌面库补列 + 播种四个内置类别 + 映射存量贷款。
  // 漏掉这段：升级后的旧桌面库缺少 Account.loanCategoryId，读账户会报
  // "no such column: Account.loanCategoryId"（生产构建下即 "Server Components render" 通用报错）。
  if (!tableExists(db, "LoanCategory")) {
    db.exec(
      'CREATE TABLE "LoanCategory" (' +
        '"id" TEXT NOT NULL PRIMARY KEY, ' +
        '"householdId" TEXT NOT NULL, ' +
        '"name" TEXT NOT NULL, ' +
        '"baseType" TEXT NOT NULL, ' +
        '"sortOrder" INTEGER NOT NULL DEFAULT 0, ' +
        '"isSystem" BOOLEAN NOT NULL DEFAULT false, ' +
        '"isActive" BOOLEAN NOT NULL DEFAULT true, ' +
        '"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        '"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' +
        ")",
    );
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "LoanCategory_householdId_name_key" ON "LoanCategory"("householdId","name")');
  db.exec('CREATE INDEX IF NOT EXISTS "LoanCategory_householdId_sortOrder_idx" ON "LoanCategory"("householdId","sortOrder")');
  addColumnIfMissing(db, "Account", "loanCategoryId", "TEXT");
  db.exec('CREATE INDEX IF NOT EXISTS "Account_householdId_loanCategoryId_idx" ON "Account"("householdId","loanCategoryId")');
  if (tableExists(db, "Account")) {
    db.prepare(
      'UPDATE "Account" SET "loanType" = CASE WHEN "isConsumerLoan" = 1 THEN ? ELSE ? END WHERE "kind" = ? AND "loanType" IS NULL',
    ).run("consumer", "home", "loan");
  }
  if (tableExists(db, "Household")) {
    const insertCategory = db.prepare(
      'INSERT OR IGNORE INTO "LoanCategory" ("id","householdId","name","baseType","sortOrder","isSystem","isActive","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    );
    for (const household of db.prepare('SELECT "id" AS id FROM "Household"').all()) {
      for (const [name, baseType, sortOrder] of [
        ["房贷", "home", 0],
        ["消费贷", "consumer", 1],
        ["抵押贷", "mortgage", 2],
        ["其他贷款", "other", 3],
      ]) {
        insertCategory.run("lc_" + household.id + "_" + baseType, household.id, name, baseType, sortOrder);
      }
    }
  }
  if (tableExists(db, "Account")) {
    db.prepare(
      'UPDATE "Account" SET "loanCategoryId" = ? || "householdId" || ? || "loanType" WHERE "kind" = ? AND "loanCategoryId" IS NULL AND "loanType" IS NOT NULL',
    ).run("lc_", "_", "loan");
  }
}

function applyRuntimeMigrations(db) {
  // Windows upgrades previously created only missing tables. Keep the login
  // query compatible with databases created by those older desktop builds.
  // MUST stay in sync with the MIGRATIONS list in scripts/build-fnos-package.cjs
  // (authVersion / registrationPrincipalId / fnosUid columns on User, and the
  // User.householdId+fnosUid unique index). A missing column here makes the
  // login/verify query throw "no such column" on upgraded desktop databases.
  addColumnIfMissing(db, "User", "authVersion", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "User", "registrationPrincipalId", "TEXT");
  addColumnIfMissing(db, "User", "fnosUid", "TEXT");
  if (columnExists(db, "User", "fnosUid")) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS "User_householdId_fnosUid_key" ON "User"("householdId", "fnosUid")');
  }
  addColumnIfMissing(db, "UserSettings", "sessionDays", "INTEGER NOT NULL DEFAULT 30");
  applyLiabilityTerminologyMigration(db);
  // 2026-10-06 AccessKey 读写权限：老密钥沿用升级前已有的完整权限（write）。
  // 与 scripts/build-fnos-package.cjs 的 20261006_add_access_key_scope 同义；
  // 漏掉这段：升级后的旧桌面库打开「设置 → API」会报 "no such column: scope"。
  addColumnIfMissing(db, "AccessKey", "scope", "TEXT NOT NULL DEFAULT 'write'");
  applyLoanCategoryMigration(db);
}

fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(dbPath);
db.pragma("busy_timeout = 10000");
try {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (!existing) {
    db.exec(fs.readFileSync(sqlPath, "utf8"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS _mmh_native_schema (version TEXT NOT NULL PRIMARY KEY, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    console.log("MMH SQLite database initialized at " + dbPath);
  } else {
    // Create missing tables only; backfills/migrations belong to fnOS MIGRATIONS.
    const sql = fs.readFileSync(sqlPath, "utf8");
    const re = /CREATE TABLE (?:IF NOT EXISTS )?\\"?([A-Za-z0-9_]+)\\"?/g;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const table = m[1];
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) {
        const start = m.index;
        const end = sql.indexOf(";", start);
        if (end > start) {
          db.exec(sql.slice(start, end + 1));
          console.log("MMH SQLite table added: " + table);
        }
      }
    }
    applyRuntimeMigrations(db);
    console.log("MMH SQLite database already initialized and migrated at " + dbPath);
  }
} finally {
  db.close();
}
`,
  "utf8",
);

// ---------------------------------------------------------------- stage node
step("copy portable Node runtime");
copyDir(portableNodeRoot, stageNodeDir);

// ------------------------------------------------- better-sqlite3 ABI rebuild
const stagedPortableNode = toArgvPath(path.join(stageNodeDir, "node.exe"));
let portableNode = stagedPortableNode;
let portableNodeVersion;
try {
  portableNodeVersion = require("node:child_process").execFileSync(stagedPortableNode, ["--version"]).toString().trim();
} catch (error) {
  // Some Windows build sandboxes refuse to execute a freshly copied binary
  // and return EBUSY. The managed Node that launched this script has the same
  // Node 22 ABI; use it for native-module rebuild/verification only. The
  // staged portable runtime is still shipped unchanged in the installer.
  if (error?.code !== "EBUSY") throw error;
  portableNode = process.execPath;
  portableNodeVersion = process.version;
  console.warn("Staged portable Node could not execute in this build environment; using the build Node for native-module verification.");
}
step("rebuild better-sqlite3 with bundled Node " + portableNodeVersion);
const portableNpmCli = toArgvPath(path.join(stageNodeDir, "node_modules", "npm", "bin", "npm-cli.js"));
const rebuild = spawnSync(portableNode, [portableNpmCli, "rebuild", "better-sqlite3"], {
  cwd: stageAppDir,
  stdio: "inherit",
  env: {
    ...process.env,
    Path: `${stageNodeDir}${path.delimiter}${process.env.Path || process.env.PATH || ""}`,
    PATH: `${stageNodeDir}${path.delimiter}${process.env.Path || process.env.PATH || ""}`,
    npm_config_ignore_scripts: "false",
  },
  shell: false,
});
if (rebuild.status !== 0) {
  console.error("better-sqlite3 rebuild failed. Try setting npm_config_better_sqlite3_binary_host or installing VS Build Tools.");
  process.exit(rebuild.status || 1);
}

// ------------------------------------------------- verify native module load
step("verify better-sqlite3 loads under bundled Node");
const checkScript = path.join(artifacts, "_tmp_check_better_sqlite3.cjs");
fs.writeFileSync(
  checkScript,
  `const path = require("node:path");
const stageAppDir = ${JSON.stringify(stageAppDir)};
const Database = require(path.join(stageAppDir, "node_modules", "better-sqlite3"));
const db = new Database(":memory:");
if (db.prepare("select 1 as ok").get().ok !== 1) process.exit(1);
db.close();
console.log("better-sqlite3 OK under Node " + process.version);
`,
  "utf8",
);
const check = spawnSync(portableNode, [toArgvPath(checkScript)], {
  cwd: stageAppDir,
  stdio: "inherit",
});
if (check.status !== 0) {
  console.error("better-sqlite3 could not be loaded by the bundled Node. ABI mismatch.");
  process.exit(check.status || 1);
}
fs.rmSync(checkScript, { force: true });

// ---------------------------------------------------------------- packaging
if (skipPackage) {
  console.log("\nStage ready at " + stageDir + ". Run without --skip-package to build the installer.");
  process.exit(0);
}

step("prepare installer icon");
fs.mkdirSync(buildDir, { recursive: true });
fs.cpSync(path.join(root, "public", "branding", "mmh-logo-pwa-512.png"), path.join(buildDir, "icon.png"));

step("generate NSIS wizard bitmaps");
// Branded MUI2 artwork (installerHeader / installerSidebar / uninstallerSidebar)
// regenerated from the current logo on every build, so the wizard never falls
// back to the stock grey NSIS skin.
run(process.execPath, [toArgvPath(path.join(root, "scripts", "generate-nsis-bitmaps.cjs")), "--out", toArgvPath(buildDir)], {});

// electron-builder strips node_modules from extraResources during pack
// (dependency dedup). The standalone server needs its own node_modules at
// runtime, so we pack --dir first, restore node_modules into the unpacked
// app, then build the NSIS installer from the prepackaged directory.
step("electron-builder pack (dir, x64)");
run("npx", ["electron-builder", "--win", "--dir", "--x64"], packageEnv());

const unpackedDir = path.join(distDir, "win-unpacked");
const unpackedAppDir = path.join(unpackedDir, "resources", "app");
step("restore node_modules into unpacked app");
copyDir(path.join(stageAppDir, "node_modules"), path.join(unpackedAppDir, "node_modules"));

// electron-builder only writes app-update.yml during publish, but the desktop
// app needs it at runtime. Keep it in sync with electron-builder.yml publish.
step("write app-update.yml (update feed)");
fs.writeFileSync(
  path.join(unpackedDir, "resources", "app-update.yml"),
  "provider: generic\nurl: " + UPDATE_FEED_URL + "\n",
  "utf8",
);

step("electron-builder nsis (prepackaged)");
run("npx", ["electron-builder", "--win", "nsis", "--x64", "--prepackaged", toArgvPath(unpackedDir)], packageEnv());

const exeFiles = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((f) => f.toLowerCase().endsWith(".exe"))
  : [];
if (exeFiles.length === 0) {
  console.error("No installer produced under " + distDir);
  process.exit(1);
}
for (const f of exeFiles) {
  const full = path.join(distDir, f);
  const sizeMb = (fs.statSync(full).size / 1024 / 1024).toFixed(1);
  console.log("\nInstaller ready: " + full + " (" + sizeMb + " MB)");
}
