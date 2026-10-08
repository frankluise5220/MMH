#!/usr/bin/env node

// Windows 桌面端（SQLite）升级路径的静态断言。
//
// 桌面端不是靠 `prisma migrate deploy`，而是由 scripts/build-win-desktop.cjs 生成
// scripts/init-sqlite.cjs：全新安装整份执行 native-init.sql，存量库只「建缺失的表」+
// 跑 applyRuntimeMigrations 里的列回填与数据迁移。所以任何新列/新主数据只要忘了写进
// 这段模板，升级后的旧库就会缺列，页面直接报 "no such column: xxx"
// （生产构建下表现为 "Server Components render" 通用报错）。
//
// 这些断言只做文本校验（不跑 better-sqlite3），保证在任何 Node 版本下都能执行；
// 行为验证见 scripts/verify-win-sqlite-runtime.cjs（需要匹配 ABI 的 Node）。

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];
const buildScript = fs.readFileSync(path.join(root, "scripts", "build-win-desktop.cjs"), "utf8");
const electronMain = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");

// Cross-channel base-path contract: only the fnOS gateway package carries a
// prefix (/app/mmh). Every other channel is served from the ORIGIN ROOT, and
// Windows is the strictest case because the Electron shell hard-codes
// http://127.0.0.1:<port>/ with no path at all. Next inlines basePath at build
// time, so a value left over in the shell (the desktop builder's run() merges
// process.env) would ship an installer whose every route 404s inside the window.
// Fixing that at the source is the point: no layer ever "repairs" a URL, every
// URL leaves exactly once through withBasePath() (src/lib/base-path.ts).
expect(
  /MMH_BASE_PATH:\s*""/.test(buildScript),
  'Windows desktop build must pin MMH_BASE_PATH: "" instead of inheriting the shell environment.',
);
expect(
  /MMH_BASE_PATH:\s*""/.test(electronMain),
  'Electron must spawn the server with MMH_BASE_PATH: "" so runtime matches the root-served build.',
);
expect(
  /loadURL\("http:\/\/127\.0\.0\.1:" \+ port\)/.test(electronMain),
  "Electron must open the window at the bare origin root (http://127.0.0.1:<port>); any entry path there would demand a matching basePath build.",
);

// 2026-10-07 在线更新源修正：electron-updater 必须走 GitHub Release feed。
// 曾经的 generic 源 http://fnapp.floatingice.win:5660/mmh/ 是 FN 软仓服务端，
// 只承载 fnOS .fpk，不承载 Windows latest.yml，导致自动更新从未生效（404）。
const builderYml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
expect(
  /provider:\s*github/.test(builderYml) &&
    /owner:\s*frankluise5220/.test(builderYml) &&
    /repo:\s*MMH/.test(builderYml),
  "electron-builder.yml publish must use the GitHub provider (frankluise5220/MMH), not the retired generic FN soft-store feed.",
);
expect(
  /provider:\s*"github"/.test(buildScript) &&
    /owner:\s*"frankluise5220"/.test(buildScript) &&
    /repo:\s*"MMH"/.test(buildScript),
  "build-win-desktop.cjs must write app-update.yml pointing at the GitHub provider feed.",
);
expect(
  !/fnapp\.floatingice\.win:5660\/mmh/.test(builderYml) &&
    !/fnapp\.floatingice\.win:5660\/mmh/.test(buildScript),
  "The retired generic update feed (fnapp.floatingice.win:5660/mmh) must not be reintroduced as the Windows update source.",
);

// 2026-10-07 手动"检查更新"入口：preload 桥必须被打包，且 main.cjs 在
// 沙箱下挂载它（contextIsolation + preload），否则设置页的更新按钮静默失效。
expect(
  /electron\/preload\.cjs/.test(builderYml),
  "electron-builder.yml files must include electron/preload.cjs so the update bridge ships in the asar.",
);
expect(
  /preload:\s*preloadPath/.test(electronMain) &&
    /contextIsolation:\s*true/.test(electronMain) &&
    /sandbox:\s*true/.test(electronMain),
  "Electron must mount the sandboxed preload bridge (preload: preloadPath) with contextIsolation + sandbox enabled.",
);
expect(
  /mmh:check-for-updates/.test(electronMain) &&
    /mmh:get-version/.test(electronMain) &&
    /mmh:update-status/.test(electronMain),
  "Electron must expose mmh:check-for-updates / mmh:get-version / mmh:update-status IPC for the settings update button.",
);

function expect(condition, message) {
  if (!condition) failures.push(message);
}

expect(
  /function applyRuntimeMigrations\(db\)/.test(buildScript) &&
    /applyRuntimeMigrations\(db\);/.test(buildScript),
  "Windows SQLite init must define and call applyRuntimeMigrations for existing databases.",
);

// 2026-10-06 负债口径改名：漏掉会让升级后的旧桌面库缺 Account.liabilityDirection。
expect(
  /function applyLiabilityTerminologyMigration\(db\)/.test(buildScript) &&
    /renameColumnIfNeeded\(db, "Account", "debtDirection", "liabilityDirection"\)/.test(buildScript) &&
    /renameColumnIfNeeded\(db, "transactions", "debtPrincipalAmount", "principalAmount"\)/.test(buildScript),
  "Windows SQLite init must rename debt* storage to liability semantics on upgraded databases.",
);

// 2026-10-06 AccessKey 读写权限：漏掉会让「设置 → API」读不到 scope 列。
expect(
  /addColumnIfMissing\(db, "AccessKey", "scope", "TEXT NOT NULL DEFAULT 'write'"\)/.test(buildScript),
  "Windows SQLite init must backfill AccessKey.scope for existing databases (old keys keep write access).",
);

// 2026-10-07 贷款类别：列 + 四个内置类别播种 + 存量贷款映射，三件事缺一不可。
expect(
  /function applyLoanCategoryMigration\(db\)/.test(buildScript) &&
    /addColumnIfMissing\(db, "Account", "loanCategoryId", "TEXT"\)/.test(buildScript),
  "Windows SQLite init must backfill Account.loanCategoryId for existing databases.",
);
expect(
  /INSERT OR IGNORE INTO "LoanCategory"/.test(buildScript) &&
    /"lc_" \+ household\.id \+ "_" \+ baseType/.test(buildScript) &&
    /\["房贷", "home", 0\]/.test(buildScript) &&
    /\["其他贷款", "other", 3\]/.test(buildScript),
  "Windows SQLite init must seed the four built-in loan categories with deterministic lc_<householdId>_<baseType> ids.",
);
expect(
  /UPDATE "Account" SET "loanCategoryId" = \? \|\| "householdId" \|\| \? \|\| "loanType"/.test(buildScript),
  "Windows SQLite init must map existing loan accounts onto their built-in category.",
);
expect(
  /applyLoanCategoryMigration\(db\);/.test(buildScript),
  "Windows SQLite init must call applyLoanCategoryMigration from applyRuntimeMigrations.",
);

if (failures.length > 0) {
  console.error("Windows desktop verification failed:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}

console.log("Windows desktop verification passed.");
