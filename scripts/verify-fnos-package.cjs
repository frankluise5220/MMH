#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const verifyVersion = normalizeFnosVersion(process.env.FNOS_PACKAGE_VERSION || pkg.version || "0.1.0");
const verifyTarget = normalizeFnosTarget(process.env.FNOS_TARGET_ARCH || process.env.FNOS_TARGET || "x86");
const fnosPublicFiles = new Set([
  "apple-touch-icon.png",
  "favicon.ico",
  "sw.js",
  "branding/mmh-logo-pageflip.png",
  "branding/mmh-logo-pageflip.square.png",
  "branding/mmh-logo-pageflip-192.png",
  "branding/mmh-logo-pageflip-512.png",
]);

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function normalizeFnosTarget(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["", "x86", "x86-64", "x64", "amd64"].includes(raw)) {
    return {
      id: "x86",
      manifestArch: "x86_64",
      manifestPlatform: "x86",
      assetSuffix: "x86_64",
      stageDirName: "mmh-fpk",
      builtFpkName: fnosFpkAssetName("x86_64"),
    };
  }
  if (["arm", "arm64", "aarch64"].includes(raw)) {
    return {
      id: "arm64",
      manifestArch: "aarch64",
      manifestPlatform: "arm",
      assetSuffix: "arm64",
      stageDirName: "mmh-arm64-fpk",
      builtFpkName: fnosFpkAssetName("arm64"),
    };
  }
  failures.push(`FNOS_TARGET_ARCH must be x86 or arm64, got ${value || "(empty)"}.`);
  return {
    id: "x86",
    manifestArch: "x86_64",
    manifestPlatform: "x86",
    assetSuffix: "x86_64",
    stageDirName: "mmh-fpk",
    builtFpkName: fnosFpkAssetName("x86_64"),
  };
}

function normalizeFnosVersion(value) {
  const raw = String(value || "").trim();
  if (!raw) return "0.1.0";
  const normalized = raw
    .replace(/^refs\/tags\//, "")
    .replace(/^v(?=\d)/, "")
    .replace(/-fnos(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    failures.push(`FNOS_PACKAGE_VERSION must use 0.1.x format, got ${normalized}.`);
    return "0.1.0";
  }
  return normalized;
}

function fnosFpkAssetName(assetSuffix) {
  return `mmh-fnos-v${verifyVersion}-${assetSuffix}.fpk`;
}

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`Missing ${path.relative(root, file)}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function readTarEntry(archive, entry) {
  if (!fs.existsSync(archive)) return "";
  const result = spawnSync("tar", ["-xOf", archive, entry], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    failures.push(`Could not read ${entry} from ${path.relative(root, archive)}.\n${result.stderr || result.stdout || result.error?.message}`);
    return "";
  }
  return result.stdout;
}

function normalizeTarName(name) {
  return name.replace(/^\.\//, "");
}

function listTarEntries(archive) {
  if (!fs.existsSync(archive)) return [];
  const result = spawnSync("tar", ["-tzf", archive], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    failures.push(`Could not list ${path.relative(root, archive)}.\n${result.stderr || result.stdout || result.error?.message}`);
    return [];
  }
  return result.stdout.split(/\r?\n/).filter(Boolean).map(normalizeTarName);
}

function tarHasEntry(archive, entry) {
  return listTarEntries(archive).some((name) => name === entry);
}

function listFilesRelative(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (current, base) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = base ? `${base}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(dir, "");
  return files.sort();
}

function expectFnosPublicFiles(files, label) {
  for (const requiredFile of fnosPublicFiles) {
    expect(files.includes(requiredFile), `${label} must include ${requiredFile}.`);
  }
  for (const file of files) {
    expect(fnosPublicFiles.has(file), `${label} must not include unused public asset ${file}.`);
  }
}

function listFpkAppEntries(archive) {
  if (!fs.existsSync(archive)) return [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-fnos-fpk-"));
  try {
    const extract = spawnSync("tar", ["-xzf", archive, "-C", tmpDir, "app.tgz"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      maxBuffer: 1024 * 1024,
    });
    if (extract.status !== 0) {
      failures.push(`Could not extract app.tgz from ${path.relative(root, archive)}.\n${extract.stderr || extract.stdout || extract.error?.message}`);
      return [];
    }
    return listTarEntries(path.join(tmpDir, "app.tgz"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function pngSize(file) {
  if (!fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function expectPngSize(file, size) {
  const dimensions = pngSize(file);
  expect(
    dimensions?.width === size && dimensions?.height === size,
    `${path.relative(root, file)} must be a ${size}x${size} PNG.`,
  );
}

const buildScript = read(path.join(root, "scripts", "build-fnos-package.cjs"));
const appBuildScript = read(path.join(root, "scripts", "build-fnos-app.cjs"));
const schemaScript = read(path.join(root, "scripts", "generate-native-sqlite-schema.cjs"));
const fnosReleaseWorkflow = read(path.join(root, ".github", "workflows", "fnos-release.yml"));
const fnosStageWorkflow = read(path.join(root, ".github", "workflows", "fnos-stage.yml"));
const prismaConfig = read(path.join(root, "prisma.config.ts"));
const dbClient = read(path.join(root, "src", "lib", "db", "prisma.ts"));
const systemUpdateRoute = read(path.join(root, "src", "app", "api", "v1", "settings", "system-update", "route.ts"));
const systemUpdatePage = read(path.join(root, "src", "app", "(sidebar)", "settings", "system-update", "page.tsx"));
const authVerifyRoute = read(path.join(root, "src", "app", "api", "v1", "auth", "verify", "route.ts"));
const backupSource = read(path.join(root, "src", "lib", "server", "backup.ts"));
const repositoryExample = read(path.join(root, "deploy", "fnos", "repository", "apps.example.json"));
const repositoryApiApps = read(path.join(root, "deploy", "fnos", "repository", "api", "apps"));
const fnosReadme = read(path.join(root, "deploy", "fnos", "README.md"));
const fnosPackagePlan = read(path.join(root, "docs", "fnos-package-plan.md"));
const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const stageDir = path.join(root, "release-artifacts", "fnos", verifyTarget.stageDirName);
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const nativeSchemaBackfillCalls = buildScript.match(/\n\s+applyMissingSchemaObjectsFromInitSql\(db, sqlPath\);/g) || [];

expect(/provider = "sqlite"/.test(schemaScript), "Native schema generator must switch datasource provider to sqlite.");
expect(/@db\\\./.test(schemaScript), "Native schema generator must strip PostgreSQL native column annotations.");
expect(/PRISMA_SCHEMA_PATH/.test(prismaConfig), "Prisma config must allow selecting the native schema.");
expect(/PrismaBetterSqlite3/.test(dbClient), "Database client must support the SQLite adapter.");
expect(/connectionString\.startsWith\("file:"\)/.test(dbClient), "Database client must route file: URLs to SQLite.");
expect(/FNOS_NODE_TARBALL/.test(buildScript), "fnOS package build must require an explicit Linux Node runtime input.");
expect(/FNOS_TARGET_ARCH/.test(buildScript), "fnOS package build must accept FNOS_TARGET_ARCH for multi-architecture releases.");
expect(/normalizeFnosTarget/.test(buildScript), "fnOS package build must normalize x86 and arm64 targets.");
expect(/normalizeFnosVersion/.test(buildScript), "fnOS package build must normalize Release tags into package versions.");
expect(buildScript.includes("^0\\.1\\.\\d+$"), "fnOS package build must enforce the unified 0.1.x version format.");
expect(/os_min_version=\$\{osMinVersion\}/.test(buildScript), "fnOS manifest must include os_min_version for official submission.");
expect(/changelog=\$\{changelog\}/.test(buildScript), "fnOS manifest must include a changelog for official submission.");
expect(/mmhReleaseNotes/.test(buildScript), "fnOS package build must copy release notes into the runtime package.json.");
expect(!/path\.join\(stageDir,\s*"wizard",\s*"uninstall"\)/.test(buildScript), "fnOS package must not include an uninstall wizard; FN soft-store updates cannot complete when uninstall requires UI input.");
expect(/backupLifecycle\("upgrade"\)/.test(buildScript), "fnOS package must create cmd/upgrade_init to back up app data before upgrades.");
expect(/backupLifecycle\("uninstall"\)/.test(buildScript), "fnOS package must create cmd/uninstall_init to back up app data before uninstall/reinstall flows.");
expect(/upgrade-backups/.test(buildScript) && /sha256sum/.test(buildScript), "fnOS backup lifecycle must copy appdata to an upgrade backup directory and record the SQLite checksum when available.");
expect(/data_root\/upgrade-backups/.test(buildScript), "fnOS backup lifecycle must fall back to an app-owned upgrade backup directory when sibling appdata backups are not writable.");
expect(/cp -a "\$data_root\/data"/.test(buildScript), "fnOS backup lifecycle must avoid recursively copying appdata into itself when using the app-owned backup fallback.");
expect(/upgrade_callback/.test(buildScript), "fnOS package must include upgrade_callback for overlay upgrades.");
expect(/const MIGRATIONS = \[/.test(buildScript), "fnOS SQLite init must include an explicit runtime migration list for existing databases.");
expect(/function splitSqlStatements\(sql\)/.test(buildScript) && /function applyMissingSchemaObjectsFromInitSql\(db, sqlPath\)/.test(buildScript), "fnOS SQLite init must parse native-init.sql to backfill newly added tables for existing databases.");
expect(/createTableColumnDefinitionsFromStatement/.test(buildScript) && /SQLite schema column added from native-init.sql/.test(buildScript), "fnOS SQLite init must backfill safe newly added columns from native-init.sql for existing databases.");
expect(/canAddColumnFromCreateTableDefinition/.test(buildScript) && /SQLite schema column skipped from native-init.sql because it cannot be safely added/.test(buildScript), "fnOS SQLite column backfill must skip unsafe column transforms instead of guessing destructive migrations.");
expect(/CREATE INDEX IF NOT EXISTS/.test(buildScript) && /createIndexStatementIfMissing/.test(buildScript), "fnOS SQLite schema backfill must make native-init.sql indexes idempotent for existing databases.");
expect(/indexColumnsExist/.test(buildScript) && /SQLite schema index skipped from native-init.sql/.test(buildScript), "fnOS SQLite schema backfill must skip incompatible indexes instead of failing existing databases.");
expect(/20260812_account_note/.test(buildScript) && /addColumnIfMissing\(db, "Account", "note", "TEXT"\)/.test(buildScript), "fnOS SQLite migrations must add Account.note to existing databases without rebuilding tables.");
expect(/20260812_user_session_days/.test(buildScript) && /addColumnIfMissing\(db, "UserSettings", "sessionDays", "INTEGER NOT NULL DEFAULT 30"\)/.test(buildScript), "fnOS SQLite migrations must add UserSettings.sessionDays to existing databases before restore writes user settings.");
expect(/20260811_stock_domain/.test(buildScript) && /createStockDomainTables\(db\)/.test(buildScript), "fnOS SQLite migrations must create stock core tables for existing databases.");
expect(/stock_transactions/.test(buildScript) && /entry_business_links_stockTransactionId_idx/.test(buildScript), "fnOS SQLite stock migration must include stock transactions and business-link stock relation.");
expect(/20260812_stock_reference_tables/.test(buildScript) && /createStockReferenceTables\(db\)/.test(buildScript), "fnOS SQLite migrations must create stock reference tables for existing databases.");
expect(/stock_market_fee_rules/.test(buildScript) && /stock_brokerage_catalog/.test(buildScript), "fnOS SQLite migrations must include stock market fee rules and brokerage catalog tables.");
expect(/20260813_zz_unify_statement_learning_rules/.test(buildScript), "fnOS SQLite statement-rule migration version must match the finalized Prisma migration directory.");
expect(/20260814_fix_property_cash_entry_fk/.test(buildScript) && /rebuildPropertyTransactionsCashEntryFk/.test(buildScript), "fnOS SQLite migrations must rebuild property_transactions when cashEntryId still references TxRecord.");
expect(/applyRuntimeMigrations\(db\)/.test(buildScript), "fnOS SQLite init must run runtime migrations for both fresh and existing databases.");
expect(nativeSchemaBackfillCalls.length >= 2, "fnOS SQLite init must backfill missing native-init.sql schema objects for both fresh and existing databases.");
expect(/applyRuntimeMigrations\(db\);\n\s+applyMissingSchemaObjectsFromInitSql\(db, sqlPath\);/.test(buildScript), "fnOS SQLite init must run schema-object backfill after explicit runtime migrations.");
expect(/SQLite database already initialized and migrated/.test(buildScript), "fnOS SQLite init must report that existing databases were migrated.");
expect(/buildRestoredCategoryBatches/.test(backupSource), "Backup restore must normalize category rows before writing them.");
expect(/record\.parentId === record\.id/.test(backupSource) && /!recordIds\.has\(record\.parentId \?\? ""\)/.test(backupSource), "Backup restore must drop self or missing category parent links before createMany.");
expect(/restoredCategoryNameById/.test(backupSource) && /categoryNameById/.test(backupSource), "Backup restore must keep restored category names aligned for transactions and statement rules.");
expect(/覆盖升级/.test(fnosReadme) && /upgrade_init/.test(fnosReadme), "fnOS README must document direct same-app overlay upgrades.");
expect(!/appcenter-cli uninstall/.test(fnosReadme), "fnOS README must not describe uninstall/install as the normal update path.");
expect(/覆盖升级/.test(fnosPackagePlan) && /appname=mmh/.test(fnosPackagePlan), "fnOS package plan must keep same-app overlay upgrade as the normal update path.");
expect(/process\.platform === "linux"/.test(buildScript), "fnOS release builds must be guarded to Linux/fnOS.");
expect(/resolve_data_dest/.test(buildScript), "fnOS start script must resolve a persistent fnOS data directory.");
expect(/TRIM_PKGVAR\/data/.test(buildScript), "fnOS start script must prefer TRIM_PKGVAR/data when TRIM_DATADEST is unavailable.");
expect(/@appdata\/"\$appname"/.test(buildScript), "fnOS start script fallback must use the fnOS appdata directory.");
expect(!/TRIM_DATADEST:-\$APP_DEST\/data/.test(buildScript), "fnOS start script must not fall back to the app install directory for SQLite data.");
expect(/DATABASE_URL="file:\$DATA_DEST\/mmh\.db"/.test(buildScript), "fnOS start script must store SQLite data under the resolved persistent data directory.");
expect(/SELECT name FROM sqlite_master WHERE type = 'table'/.test(buildScript), "fnOS SQLite init must check for existing user tables before applying the initial schema.");
expect(/if \(!existing\)/.test(buildScript), "fnOS SQLite init must skip schema creation when an existing database is present.");
expect(/export MMH_DEPLOY_TARGET=fnos/.test(buildScript), "fnOS start script must mark the deployment target as fnos.");
expect(/manifestPlatform/.test(buildScript) && /manifestArch/.test(buildScript), "fnOS manifest must be generated from the target architecture.");
expect(/assetSuffix/.test(buildScript), "fnOS package outputs must include architecture-specific asset names.");
expect(/fnos-v\$\{version\}-\$\{target\.assetSuffix\}/.test(buildScript), "fnOS release asset names must include fnOS, package version, and architecture.");
expect(!/`\$\{appName\}-\$\{target\.assetSuffix\}\.fpk`/.test(buildScript), "fnOS release must not publish unversioned architecture-only .fpk aliases.");
expect(!/legacyAlias/.test(buildScript), "fnOS release must not publish a third legacy mmh.fpk alias.");
expect(!/wizard_system_password/.test(buildScript), "fnOS install/config wizard must not ask for a separate system password.");
expect(/MMH_SYSTEM_PASSWORD/.test(buildScript), "fnOS start script must export MMH_SYSTEM_PASSWORD.");
expect(/mmh-system-password\.txt/.test(buildScript), "fnOS start script must persist generated system passwords in app data.");
expect(/install_callback/.test(buildScript) && /write_env_file/.test(buildScript), "fnOS lifecycle callbacks must persist wizard settings.");
expect(/verifySensitiveOperationPassword/.test(authVerifyRoute) && /getCurrentUser/.test(authVerifyRoute) && /isAdmin/.test(authVerifyRoute), "Sensitive operation verification must require the current admin user and check that user's own password.");
expect(!/process\.env\.(POSTGRES_PASSWORD|MMH_SYSTEM_PASSWORD)/.test(authVerifyRoute), "Sensitive operation verification must not rely on deployment database passwords.");
expect(/FNOS_MANUAL_FPK/.test(buildScript), "fnOS package build should keep an explicit manual test FPK mode.");
expect(/schema\.native\.prisma/.test(appBuildScript), "fnOS app build must generate and build against the SQLite schema.");
expect(/MMH_DEPLOY_TARGET/.test(systemUpdateRoute), "System update API must detect fnOS by MMH_DEPLOY_TARGET.");
expect(/isFnos/.test(systemUpdateRoute), "System update API must return an explicit isFnos flag.");
expect(/remoteVersion/.test(systemUpdateRoute), "System update API must return the remote app version for update display.");
expect(/飞牛版请通过飞牛应用中心更新 MMH 应用包/.test(systemUpdateRoute), "System update API must reject in-app updates for fnOS.");
expect(/fnosManaged \? "版本信息"/.test(systemUpdatePage), "System update page must label fnOS package details as version information.");
expect(/GitHub 项目主页/.test(systemUpdatePage) && /githubProjectUrl/.test(systemUpdatePage), "System update page must expose the GitHub project link for fnOS users.");
expect(/可更新版本/.test(systemUpdatePage) && /availableVersionText/.test(systemUpdatePage), "System update page must show the available app version beside the update commit.");
expect(/对应架构的新 FPK/.test(systemUpdatePage) && /飞牛应用中心/.test(systemUpdatePage), "System update page must guide fnOS users to update with the architecture-matched FPK.");
expect(!/docker-project/.test(buildScript), "fnOS package build must not declare Docker resources.");
expect(/better-sqlite3/.test(buildScript), "fnOS package build must explicitly include the SQLite native runtime dependency.");
expect(/copyFnosPublicAssets/.test(buildScript), "fnOS package build must copy only whitelisted runtime public assets.");
expect(!/copyDir\(publicDir/.test(buildScript), "fnOS package build must not copy the whole public directory.");
expect(/release:\s*\n\s*types:\s*\[published\]/.test(fnosReleaseWorkflow), "fnOS workflow should run when a GitHub Release is published.");
expect(/npm ci/.test(fnosReleaseWorkflow), "fnOS workflow should install Linux native dependencies.");
expect(/FNOS_NODE_TARBALL/.test(fnosReleaseWorkflow), "fnOS workflow should provide a Linux Node runtime tarball.");
expect(/npm run build:fnos:app/.test(fnosReleaseWorkflow), "fnOS workflow should build the Linux SQLite standalone app.");
expect(/npm run build:fnos/.test(fnosReleaseWorkflow), "fnOS workflow should build the formal .fpk package.");
expect(!/existing-fpk/.test(fnosReleaseWorkflow), "fnOS workflow must rebuild release packages instead of skipping when an old .fpk asset already exists.");
expect(/overwrite_files:\s*true/.test(fnosReleaseWorkflow), "fnOS workflow must overwrite existing Release .fpk assets with the newly built package.");
expect(/Verify built fnOS FPK/.test(fnosReleaseWorkflow) && /npm run check:fnos/.test(fnosReleaseWorkflow), "fnOS workflow must verify the built .fpk before upload.");
expect(/release-artifacts\/fnos\/\*\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow should upload .fpk files.");
expect(/target_arch/.test(fnosReleaseWorkflow) && /arm64/.test(fnosReleaseWorkflow), "fnOS release workflow must build both x86 and arm64 packages.");
expect(/linux-\$\{FNPACK_ARCH\}/.test(fnosReleaseWorkflow), "fnOS release workflow must download fnpack for the current runner architecture.");
expect(/linux-\$\{NODE_ARCH\}/.test(fnosReleaseWorkflow), "fnOS release workflow must download the Node runtime for the package architecture.");
expect(/target_arch/.test(fnosStageWorkflow) && /arm64/.test(fnosStageWorkflow), "fnOS stage workflow must build both x86 and arm64 package sources.");
expect(!/path:\s*release-artifacts\/fnos\/\*-fpk-source\.tgz/.test(fnosReleaseWorkflow), "fnOS release workflow must not upload stage-only .tgz files.");
expect(/fnpack was not found/.test(fnosReleaseWorkflow), "fnOS workflow should fail clearly when fnpack is unavailable.");
expect(!/mmh-native\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow must not publish a second mmh-native.fpk package.");
expect(!/0\.1\.0-fnos/.test(fnosReleaseWorkflow), "fnOS release workflow must not default to the old 0.1.0-fnos package version.");
expect(!/0\.1\.0-fnos/.test(fnosStageWorkflow), "fnOS stage workflow must not default to the old 0.1.0-fnos package version.");
expect(/default:\s*""/.test(fnosReleaseWorkflow), "fnOS release workflow should let package.json own the default package version.");
expect(/default:\s*""/.test(fnosStageWorkflow), "fnOS stage workflow should let package.json own the default package version.");
expect(/"platform"\s*:\s*"x86"/.test(repositoryExample), "fnOS repository example must keep x86 as the legacy default platform.");
expect(/"platforms"\s*:\s*\[\s*"x86"\s*,\s*"arm"\s*\]/.test(repositoryExample), "fnOS repository example must list x86 and arm platforms.");
expect(/"download_urls"/.test(repositoryExample) && /"x86_64"/.test(repositoryExample) && /"arm64"/.test(repositoryExample), "fnOS repository example must include exactly the x86_64 and arm64 download_urls.");
expect(!/"x86"\s*:/.test(repositoryExample), "fnOS repository example must not include a third x86 alias download URL.");
expect(/"platform"\s*:\s*"x86"/.test(repositoryApiApps), "fnOS repository api/apps must keep x86 as the legacy default platform.");
expect(/"platforms"\s*:\s*\[\s*"x86"\s*,\s*"arm"\s*\]/.test(repositoryApiApps), "fnOS repository api/apps must list x86 and arm platforms.");
expect(/"download_urls"/.test(repositoryApiApps) && /"x86_64"/.test(repositoryApiApps) && /"arm64"/.test(repositoryApiApps), "fnOS repository api/apps must include exactly the x86_64 and arm64 download_urls.");
expect(!/"x86"\s*:/.test(repositoryApiApps), "fnOS repository api/apps must not include a third x86 alias download URL.");

if (fs.existsSync(stageDir)) {
  const stageManifest = read(path.join(stageDir, "manifest"));
  expect(new RegExp(`arch\\s*=\\s*${verifyTarget.manifestArch}`).test(stageManifest), `fnOS ${verifyTarget.id} stage manifest must declare arch=${verifyTarget.manifestArch}.`);
  expect(new RegExp(`platform\\s*=\\s*${verifyTarget.manifestPlatform}`).test(stageManifest), `fnOS ${verifyTarget.id} stage manifest must declare platform=${verifyTarget.manifestPlatform}.`);
  for (const envFile of [".env", ".env.local", ".env.production", ".env.development"]) {
    expect(!fs.existsSync(path.join(stageDir, "app", "server", envFile)), `fnOS stage must not include ${envFile}.`);
  }
  expectPngSize(path.join(stageDir, "ICON.PNG"), 64);
  expectPngSize(path.join(stageDir, "ICON_256.PNG"), 256);
  if (fs.existsSync(path.join(stageDir, "app"))) {
    expectPngSize(path.join(stageDir, "app", "ui", "images", "icon_64.png"), 64);
    expectPngSize(path.join(stageDir, "app", "ui", "images", "icon_256.png"), 256);
  }
  const publicDir = path.join(stageDir, "app", "server", "public");
  if (fs.existsSync(publicDir)) expectFnosPublicFiles(listFilesRelative(publicDir), "fnOS stage public");
}

const builtFpk = path.join(root, "release-artifacts", "fnos", verifyTarget.builtFpkName);
if (process.env.FNOS_VERIFY_BUILT_FPK === "1") {
  expect(fs.existsSync(builtFpk), `Built fnOS ${verifyTarget.id} .fpk must exist before upload.`);
  const manifest = readTarEntry(builtFpk, "manifest");
  const mainScript = readTarEntry(builtFpk, "cmd/main");
  expect(/version\s*=/.test(manifest), "Built fnOS .fpk manifest must include a version.");
  expect(new RegExp(`arch\\s*=\\s*${verifyTarget.manifestArch}`).test(manifest), `Built fnOS .fpk manifest must declare arch=${verifyTarget.manifestArch}.`);
  expect(new RegExp(`platform\\s*=\\s*${verifyTarget.manifestPlatform}`).test(manifest), `Built fnOS .fpk manifest must declare platform=${verifyTarget.manifestPlatform}.`);
  expect(!tarHasEntry(builtFpk, "wizard/uninstall"), "Built fnOS .fpk must not include wizard/uninstall; soft-store updates need non-interactive uninstall.");
  expect(tarHasEntry(builtFpk, "cmd/upgrade_init"), "Built fnOS .fpk must include cmd/upgrade_init to back up app data before upgrades.");
  expect(tarHasEntry(builtFpk, "cmd/upgrade_callback"), "Built fnOS .fpk must include cmd/upgrade_callback for overlay upgrades.");
  expect(tarHasEntry(builtFpk, "cmd/uninstall_init"), "Built fnOS .fpk must include cmd/uninstall_init to back up app data before uninstall/reinstall flows.");
  const upgradeInitScript = readTarEntry(builtFpk, "cmd/upgrade_init");
  const uninstallInitScript = readTarEntry(builtFpk, "cmd/uninstall_init");
  expect(/upgrade-backups/.test(upgradeInitScript) && /data\/mmh\.db/.test(upgradeInitScript), "Built fnOS upgrade_init must back up persistent app data when SQLite data exists.");
  expect(/upgrade-backups/.test(uninstallInitScript) && /data\/mmh\.db/.test(uninstallInitScript), "Built fnOS uninstall_init must back up persistent app data when SQLite data exists.");
  expect(/resolve_data_dest/.test(mainScript), "Built fnOS .fpk cmd/main must resolve the persistent fnOS data directory.");
  expect(/TRIM_PKGVAR\/data/.test(mainScript), "Built fnOS .fpk cmd/main must prefer TRIM_PKGVAR/data.");
  expect(!/TRIM_DATADEST:-\$APP_DEST\/data/.test(mainScript), "Built fnOS .fpk cmd/main must not fall back to the app install directory for SQLite data.");
  expect(/DATABASE_URL="file:\$DATA_DEST\/mmh\.db"/.test(mainScript), "Built fnOS .fpk cmd/main must store SQLite data under DATA_DEST.");
  expect(/MMH_SYSTEM_PASSWORD/.test(mainScript), "Built fnOS .fpk cmd/main must export MMH_SYSTEM_PASSWORD.");
  expect(/mmh-system-password\.txt/.test(mainScript), "Built fnOS .fpk cmd/main must persist generated system passwords.");
  const appEntries = listFpkAppEntries(builtFpk);
  const publicFiles = appEntries
    .filter((entry) => entry.startsWith("server/public/") && !entry.endsWith("/"))
    .filter((entry) => entry !== "server/public/branding")
    .map((entry) => entry.slice("server/public/".length))
    .sort();
  expectFnosPublicFiles(publicFiles, "Built fnOS .fpk public");
}

if (fs.existsSync(nativeSchema)) {
  const validate = spawnSync(process.execPath, [prismaCli, "validate", "--schema", nativeSchema], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(validate.status === 0, `Native Prisma schema should validate.\n${validate.stderr || validate.stdout || validate.error?.message}`);
}

if (failures.length > 0) {
  console.error("fnOS package verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("fnOS package verification passed.");
