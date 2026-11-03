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
const installerNsh = fs.readFileSync(path.join(root, "electron", "installer.nsh"), "utf8");
const electronPreload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const sidebarClient = fs.readFileSync(path.join(root, "src", "components", "layout", "SidebarClient.tsx"), "utf8");

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
  /renameWithRetry\(appDir, backupDir/.test(appUpdater) &&
    /renameWithRetry\(stageDir, appDir/.test(appUpdater) &&
    /async function commitStaged\(/.test(appUpdater) &&
    /function rollback\(/.test(appUpdater) &&
    /function recoverOnBoot\(/.test(appUpdater),
  "The file-level updater must swap resources/app by directory rename (retrying a busy directory) and be able to roll back / recover an interrupted swap.",
);
expect(
  /app\.relaunch\(\)/.test(electronMain) &&
    /await appUpdater\.commitStaged\(/.test(electronMain) &&
    /restorePreviousPayload\(/.test(electronMain),
  "Electron must apply the staged payload and relaunch (no installer) and restore the previous payload when it cannot boot.",
);

// 2026-10-31 实测事故（0.1.79，Windows）：下载结束后点「立即重启」，报
//   ebusy:resource busy or locked, rename 'D:\MMH\resources\app' '...app.old-0.1.78-...'
// resources\app 是本地 Next.js 服务的 cwd，better_sqlite3.node 也映射在它里面，
// 只要服务还活着 Windows 就不允许重命名该目录。所以「先停服务、再换目录」是
// 硬顺序，不是优化：缺了它，文件级更新在任何 Windows 机器上都不可能成功。
expect(
  /async function stopServerForUpdate\(/.test(electronMain) &&
    /await stopServerForUpdate\(\)/.test(electronMain) &&
    /await waitForServerExit\(/.test(electronMain) &&
    /\btaskkill\b/.test(electronMain) &&
    /BUSY_CODES/.test(appUpdater),
  "installUpdateNow must stop the bundled server (kill the tree, wait for exit and port release) BEFORE renaming resources/app, and the rename must retry a busy directory.",
);
expect(
  /if \(quitting \|\| serverStopping\) return;/.test(electronMain) &&
    /function restartServerAfterStop\(/.test(electronMain),
  "A deliberate stop for the swap must not be reported as a server crash, and a refused swap must bring the local server back.",
);
expect(
  /mmh-app-latest\.json/.test(buildScript) && /sha512/.test(buildScript) && /requiresInstaller,/.test(buildScript),
  "build-win-desktop.cjs must emit the app payload zip + mmh-app-latest.json manifest (sha512) for the file-level update channel.",
);
// 清单默认必须是文件级（requiresInstaller=false），只有显式设置
// MMH_REQUIRES_INSTALLER=1 才切成整包安装。理由：换目录的代码跑在【已安装那个
// 版本的 asar 里】，坏掉的壳只能被 NSIS 安装包换掉 —— 0.1.79 就是这样。
expect(
  /const requiresInstaller = [^;]*MMH_REQUIRES_INSTALLER/.test(buildScript),
  "mmh-app-latest.json must default to the file-level channel and only force the installer channel via MMH_REQUIRES_INSTALLER (the escape hatch for a shell whose own swap is broken, e.g. 0.1.79).",
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

// 2026-11-03 隐藏更新源窗口（Ctrl+Shift+U）：公开发表前先把包放到测试机能下载的
// 目录（群晖共享），把本机更新源指过去装一遍，确认能启动再传公开更新源。页面与
// preload 同样要显式打包，否则按快捷键只会弹一个空白窗。
expect(
  /electron\/updater-feed\.html/.test(builderYml) && /electron\/updater-feed-preload\.cjs/.test(builderYml),
  "electron-builder.yml files must include electron/updater-feed.html + electron/updater-feed-preload.cjs (the hidden update-source dialog).",
);
expect(
  /before-input-event/.test(electronMain) &&
    /openUpdaterFeedWindow\(\)/.test(electronMain) &&
    /"mmh:updater-feed-set"/.test(electronMain),
  "Ctrl+Shift+U must open the hidden update-source dialog and save through the mmh:updater-feed-set IPC.",
);
expect(
  /fetchManifest\(\{\s*url:\s*updaterManifestUrl\(\)\s*\}\)/.test(electronMain),
  "The manifest lookup must use the hidden update source, not the hard-coded dl.floatingice.win manifest.",
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

// 2026-11-02/03 桌面版 0.1.81 升级缺列事故：bond_transactions.instrumentKind 与
// WealthProduct.productType 同批发布，补列脚本只写了后者，前者漏掉 —— 升级后的
// 桌面库一打开债券 / 逆回购 / 定时任务就报 "no such column: instrumentKind"。
// 新列必须同时出现在 schema.native.prisma（全新安装建列）和 applyRuntimeMigrations（补存量库）。
for (const [table, column, type] of [
  ["bond_transactions", "instrumentKind", "TEXT NOT NULL DEFAULT 'bond'"],
  ["WealthProduct", "productType", "TEXT NOT NULL DEFAULT 'wealth'"],
]) {
  expect(
    buildScript.includes(`addColumnIfMissing(db, "${table}", "${column}", "${type}")`),
    `Windows SQLite init must backfill ${table}.${column} for existing databases (bond/repo/bond-task pages select it).`,
  );
}

// 新表只靠「按 native-init.sql 建缺失表」兜底，所以它必须出现在原生 schema 里。
const nativeSchema = fs.readFileSync(path.join(root, "prisma", "schema.native.prisma"), "utf8");
expect(
  /model RepoProductCustom\s*\{/.test(nativeSchema),
  "prisma/schema.native.prisma must define RepoProductCustom so an upgraded desktop database gets the table created from native-init.sql.",
);

// cookie / localStorage / 磁盘缓存挂在 sessionData 上，不挂在 userData 上。
// 只重定向 userData 时，用户会重新在 C:\Users\...\AppData\Roaming\MMH 里看到
// 一整套 Chromium 配置目录（Network\Cookies、Local Storage、Cache）。
expect(
  /app\.setPath\("sessionData", userDataDir\)/.test(electronMain),
  "Electron must redirect sessionData as well, so cookies and the Chromium profile live in the data directory instead of C:\\Users\\...\\AppData.",
);

// 2026-10-28 数据事故：自动导入旧库时静默覆盖了当前库，用户看到「账簿被换掉了」。
// 现在只允许「当前目录没有库 + 用户明确选择」这一条路径；已存在的库永不改写。
expect(
  /function legacyDataCandidates\(/.test(electronMain) &&
    /function findLegacyDatabases\(/.test(electronMain) &&
    /Programs", "MMH", "data"/.test(electronMain) &&
    /MMH-data-backup/.test(electronMain),
  "Electron must still be able to discover an mmh.db in a previous install directory / uninstall stash (to offer it to the user).",
);
expect(
  /function migrateLegacyData\(\) \{\s*\n\s*if \(fs\.existsSync\(dbFile\)\) return;/.test(electronMain),
  "Legacy import must never touch an existing mmh.db: return as soon as the file exists (2026-10-28 silent-overwrite incident).",
);
expect(
  /if \(!isPackaged\) \{[\s\S]{0,200}?not importing automatically[\s\S]{0,80}?return;/.test(electronMain),
  "Legacy import must not run automatically in dev/CI builds.",
);
expect(
  /dialog\.showMessageBoxSync\(\{[\s\S]{0,1200}?buttons: \[\.\.\.options\.map/.test(electronMain) &&
    /defaultId: options\.length/.test(electronMain),
  "Legacy import must ask the user (dialog listing the candidates) and default to skipping, never copy silently.",
);
expect(
  !/currentSize >= 64 \* 1024\) return;/.test(electronMain) &&
    !/findBestLegacyDatabase\(/.test(electronMain) &&
    !/\.bak-"\s*\+\s*Date\.now\(\)/.test(electronMain),
  "The old silent path (size-threshold overwrite / largest-db wins / .bak-then-overwrite) must stay removed.",
);

// 2026-10-28 数据丢失事故（真实账簿被卸载器删除）：数据目录是 <installDir>\data，
// 用户明确要求「永远不要动 data 目录下的数据」。旧的保护逻辑用
// Rename "$INSTDIR\data" "$TEMP\MMH-data-backup"（D 盘 -> C 盘），NSIS 的 Rename
// 底层 MoveFile 不能跨卷移动目录，静默失败后 `RMDir /r $INSTDIR` 把库一起删了。
expect(
  !/^[ \t]*Rename\s+"\$INSTDIR\\data"\s+"\$TEMP/m.test(installerNsh),
  'Uninstaller must never move <installDir>\\data with Rename: the target $TEMP is on another volume, MoveFile cannot move a directory across volumes, the rename fails silently and the following RMDir /r $INSTDIR deletes the database. (2026-10-28 incident)',
);
expect(
  /!macro customRemoveFiles/.test(installerNsh) && /StrCmp \$R8 "data" mmhRemoveNext/.test(installerNsh),
  "electron-builder's file cleanup must be replaced by customRemoveFiles, which skips the data directory (upgrades and manual uninstalls both use it).",
);
expect(
  /!macro customInstall[\s\S]{0,1200}?MMH-data-safe/.test(installerNsh) &&
    /MMH-data-safe[\s\S]{0,400}?robocopy/.test(installerNsh),
  "The installer must copy <installDir>\\data to a TEMP stash before electron-builder runs the OLD uninstaller (which still deletes it) and restore it after installation.",
);
expect(
  /IfFileExists "D:\\MMH\\data\\\*\.\*"/.test(installerNsh) &&
    /IfFileExists "\$LOCALAPPDATA\\Programs\\MMH\\data\\\*\.\*"/.test(installerNsh),
  "The pre-install data stash must not depend on the registry InstallLocation alone: on 0.1.78/0.1.79 that value is empty, which would silently skip the backup and let the old uninstaller delete the database.",
);
expect(
  !/RMDir \/r "\$INSTDIR"/.test(installerNsh),
  "No recursive delete of $INSTDIR anywhere in the NSIS customization: it would take the data directory with it.",
);

// 2026-10-29「点退出登录 → 停在 /login → 关窗重开直接进概览」：Web 登出接口只把
// cookie 从 Chromium 内存里删掉，没落盘就被关掉进程，下次启动又从 Network\Cookies
// 恢复旧会话。主进程必须清 + flush，并把退出延后到 flush 之后。
expect(
  /ipcMain\.handle\("mmh:end-session"/.test(electronMain) &&
    /clearStorageData\(\{ storages: \["cookies"\] \}\)/.test(electronMain) &&
    /flushStorageData\(\)/.test(electronMain),
  "Electron must clear and flush session cookies on logout (mmh:end-session) so a logout survives an app restart.",
);
expect(
  /event\.preventDefault\(\)[\s\S]{0,400}?flushStorageData\(\)[\s\S]{0,200}?app\.quit\(\)/.test(electronMain),
  "before-quit must defer the quit once and flush the cookie store, otherwise the deleted session cookie is restored from disk on restart.",
);
expect(
  /clearSession: \(\) => ipcRenderer\.invoke\("mmh:end-session"\)/.test(electronPreload),
  "The preload bridge must expose clearSession() for the desktop logout path.",
);
expect(
  /getDesktopBridge\(\)[\s\S]{0,300}?clearSession\(\)/.test(sidebarClient),
  "The sidebar logout handler must ask the desktop shell to clear the persisted session before redirecting to /login.",
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

// 上面的白名单只能钉住「已经写下来的列」。真正拦住 0.1.81 那类事故的是打包前的升级路径
// 门禁：它用上一个发布版本的真实结构跑一遍升级，再按当前 schema 逐表逐列断言。删掉这一步
// 就等于回到「漏列只能等用户升级后才发现」的老路。
expect(
  buildScript.includes('require("./lib/win-upgrade-sim.cjs")') &&
    buildScript.includes("verify upgrade path from previous release") &&
    buildScript.includes("upgradeSim.simulateUpgrade({"),
  "build-win-desktop.cjs must keep the pre-package upgrade path gate (scripts/lib/win-upgrade-sim.cjs): the whitelist above cannot catch a new column that was never registered.",
);

if (failures.length > 0) {
  console.error("Windows desktop verification failed:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}

console.log("Windows desktop verification passed.");
