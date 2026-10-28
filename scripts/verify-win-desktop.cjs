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

// 应用内「本版说明」（设置 → 系统更新）读运行时 package.json 的 mmhFnosManifestChangelog
// —— 各渠道共用的那份「新版本更新说明」，不是 GitHub Release 正文（mmhReleaseNotes）。
// 桌面版 stage 会被 --reuse-stage 复用，其中的 package.json 来自更早的 next build，所以
// 打包时必须用仓库里的值重新注入一遍，否则桌面版会带着旧版本 / 空说明发出去。
expect(
  /applyRuntimeReleaseNotes\(\);/.test(buildScript) &&
    /runtimePkg\.mmhFnosManifestChangelog = changelog/.test(buildScript) &&
    /runtimePkg\.mmhReleaseNotes = notes/.test(buildScript) &&
    /delete runtimePkg\.mmhReleaseNotesI18n/.test(buildScript),
  "Windows desktop build must re-inject the shared mmhFnosManifestChangelog and mmhReleaseNotes (plus the optional mmhReleaseNotesI18n) from the repo package.json into the staged runtime package.json.",
);

// 2026-10-23 在线更新源定稿：更新源是自建下载站 https://dl.floatingice.win/，
// GitHub Release 只放安装包给手动下载。客户端读该站点根目录的 latest.yml，
// 下载同目录的 exe / <exe>.blockmap 做差分升级。
// 历史坑：generic 源一旦指向 FN 软仓（fnapp.floatingice.win:5660/mmh），
// 那里只有 .fpk 没有 latest.yml，自动更新恒 404。
const builderYml = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
expect(
  /provider:\s*generic/.test(builderYml) &&
    /url:\s*https:\/\/dl\.floatingice\.win/.test(builderYml),
  "electron-builder.yml publish must be the generic provider pointing at https://dl.floatingice.win/ (the Windows update feed).",
);
expect(
  /provider:\s*"generic"/.test(buildScript) &&
    /url:\s*"https:\/\/dl\.floatingice\.win\/"/.test(buildScript),
  "build-win-desktop.cjs must write app-update.yml pointing at https://dl.floatingice.win/.",
);
expect(
  !/fnapp\.floatingice\.win:5660\/mmh/.test(builderYml) &&
    !/fnapp\.floatingice\.win:5660\/mmh/.test(buildScript),
  "The retired generic update feed (fnapp.floatingice.win:5660/mmh) must not be reintroduced as the Windows update source.",
);

// 2026-10-28 文件级更新（用户要求：重启后不再跑安装程序）。
// 「下载 → 重启」必须只替换 resources\app；安装器只保留给必须换 Electron 的版本。
const appUpdater = fs.readFileSync(path.join(root, "electron", "app-updater.cjs"), "utf8");
expect(
  /electron\/app-updater\.cjs/.test(builderYml),
  "electron-builder.yml files must include electron/app-updater.cjs, otherwise the packaged app cannot require the file-level updater.",
);
expect(
  /renameSync\(appDir, backupDir\)/.test(appUpdater) &&
    /renameSync\(stageDir, appDir\)/.test(appUpdater) &&
    /function rollback\(/.test(appUpdater) &&
    /function recoverOnBoot\(/.test(appUpdater),
  "The file-level updater must swap resources/app by directory rename and be able to roll back / recover an interrupted swap.",
);
expect(
  /app\.relaunch\(\)/.test(electronMain) &&
    /commitStaged\(/.test(electronMain) &&
    /restorePreviousPayload\(/.test(electronMain),
  "Electron must apply the staged payload and relaunch (no installer) and restore the previous payload when it cannot boot.",
);
expect(
  /requiresInstaller: false/.test(buildScript) &&
    /mmh-app-latest\.json/.test(buildScript) &&
    /sha512/.test(buildScript),
  "build-win-desktop.cjs must emit the app payload zip + mmh-app-latest.json manifest (sha512) for the file-level update channel.",
);
// 2026-10-28 实测事故：PATH 里 Git Bash 的 GNU tar 排在前面时，`tar -a -c -f x.zip`
// 不认 zip，只吐一个未压缩的 tar 却仍叫 .zip（93.7 MB payload -> 96.8 MB，且
// Expand-Archive 打不开）。必须用 System32 的 bsdtar，并校验 PK 头。
expect(
  /path\.join\(process\.env\.SystemRoot, "System32", "tar\.exe"\)/.test(buildScript) &&
    /0x50/.test(buildScript) &&
    /0x4b/.test(buildScript),
  "build-win-desktop.cjs must pack the payload with System32 bsdtar and reject a non-PK archive (GNU tar writes a plain tar named .zip).",
);
expect(
  /requiresInstaller/.test(appUpdater) && /必须重新安装客户端/.test(electronMain),
  "A release that cannot be delivered as files must fall back to the installer channel and say it requires reinstalling.",
);
expect(
  /function checkInstallerFeed\(/.test(electronMain) && /no app manifest/.test(electronMain),
  "A missing app manifest must fall back to the installer feed; reporting 'already latest' would strand every client while the feed does have a new version.",
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

// 2026-10-28 下载过程必须有窗口：选「下载」后原来是静默传输整个安装包，用户既看不到
// 进度也没法中断，只能等第二个对话框。窗口 = 静态页面 + 独立 preload +
// CancellationToken，任何一环没打包进 asar，桌面版就退回「点完下载就没反应」。
const updatePreload = fs.readFileSync(path.join(root, "electron", "update-preload.cjs"), "utf8");

expect(
  /electron\/update-window\.html/.test(builderYml) && /electron\/update-preload\.cjs/.test(builderYml),
  "electron-builder.yml files must include electron/update-window.html + electron/update-preload.cjs (the download window).",
);
expect(
  /function startInstallerDownload\(/.test(electronMain) &&
    /autoUpdater\s*\.\s*downloadUpdate\(token\)/.test(electronMain),
  "The installer fallback must call autoUpdater.downloadUpdate(token) so the update window can abort the transfer.",
);
expect(
  !/autoUpdater\.downloadUpdate\(\)/.test(electronMain),
  "Never call autoUpdater.downloadUpdate() without a token: the update window could not cancel the download.",
);
expect(
  /loadFile\(updateWindowHtmlPath\)/.test(electronMain) &&
    /preload:\s*updateWindowPreloadPath/.test(electronMain) &&
    /sandbox:\s*true/.test(electronMain) &&
    /mmh:update-window-state/.test(electronMain) &&
    /mmh:update-window-state/.test(updatePreload),
  "The update window must loadFile(updateWindowHtmlPath) with its own sandboxed preload and receive mmh:update-window-state.",
);
expect(
  /mmh:update-cancel/.test(electronMain) &&
    /mmh:update-cancel/.test(updatePreload) &&
    /mmh:update-install/.test(electronMain) &&
    /mmh:update-install/.test(updatePreload) &&
    /quitAndInstall/.test(electronMain),
  "The update window must be able to cancel the download and restart into the installer (mmh:update-cancel / mmh:update-install).",
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

// 2026-10-13 User.registrationEmail：这一列不只影响 MMH 会员标签，它进了
// /api/v1/auth/password-status 的登录账号查询。旧桌面库缺列时整条查询抛
// "no such column"，接口降级成 users: []，登录页既不列账号也没有「新建账簿」入口，
// 只显示「当前账簿没有本地账号」（2026-10-25 用户反馈安装 Windows 版无法新建账簿）。
expect(
  /addColumnIfMissing\(db, "User", "registrationEmail", "TEXT"\)/.test(buildScript),
  "Windows SQLite init must backfill User.registrationEmail for existing databases (login accounts query selects it).",
);

// 2026-10-26/27 HouseholdPreference 新列：household-preferences.ts 全列 findUnique，
// 缺列会让首屏/侧边栏抛 "no such column"，用户看到的是「账簿没了 / 首页空了」。
for (const [column, type] of [
  ["detailWindowYears", "INTEGER NOT NULL DEFAULT 5"],
  ["accountUsageSortEnabled", "BOOLEAN NOT NULL DEFAULT 1"],
]) {
  expect(
    buildScript.includes(`addColumnIfMissing(db, "HouseholdPreference", "${column}", "${type}")`),
    `Windows SQLite init must backfill HouseholdPreference.${column} for existing databases (first-screen/sidebar query reads every column).`,
  );
}

// cookie / localStorage / 磁盘缓存挂在 sessionData 上，不挂在 userData 上。
// 只重定向 userData 时，用户会重新在 C:\Users\...\AppData\Roaming\MMH 里看到
// 一整套 Chromium 配置目录（Network\Cookies、Local Storage、Cache）。
expect(
  /app\.setPath\("sessionData", userDataDir\)/.test(electronMain),
  "Electron must redirect sessionData as well, so cookies and the Chromium profile live in the data directory instead of C:\\Users\\...\\AppData.",
);

// 2026-10-28 数据目录切换（安装目录变了）后必须能把旧库找回来：只认 %APPDATA%\MMH
// 会让换目录安装的用户得到一个空库，旧账簿还在旧安装目录里但看不见。
expect(
  /function findBestLegacyDatabase\(/.test(electronMain) &&
    /function legacyDataCandidates\(/.test(electronMain) &&
    /Programs", "MMH", "data"/.test(electronMain) &&
    /MMH-data-backup/.test(electronMain) &&
    /\.bak-/.test(electronMain),
  "Electron must discover an existing mmh.db in the previous install directory / uninstall stash and import it (keeping a .bak of the current file).",
);

// 登录账号查询还会 select 这些列，任何一列缺失都会让登录页整体降级成空账号列表。
for (const [table, column, type] of [
  ["User", "authVersion", "INTEGER NOT NULL DEFAULT 1"],
  ["User", "registrationPrincipalId", "TEXT"],
  ["User", "fnosUid", "TEXT"],
  ["UserSettings", "sessionDays", "INTEGER NOT NULL DEFAULT 30"],
]) {
  expect(
    buildScript.includes(`addColumnIfMissing(db, "${table}", "${column}", "${type}")`),
    `Windows SQLite init must backfill ${table}.${column} for existing databases (login page reads it).`,
  );
}

if (failures.length > 0) {
  console.error("Windows desktop verification failed:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}

console.log("Windows desktop verification passed.");
