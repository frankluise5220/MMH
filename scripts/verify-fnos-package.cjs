#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`Missing ${path.relative(root, file)}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
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
const prismaConfig = read(path.join(root, "prisma.config.ts"));
const dbClient = read(path.join(root, "src", "lib", "db", "prisma.ts"));
const systemUpdateRoute = read(path.join(root, "src", "app", "api", "v1", "settings", "system-update", "route.ts"));
const systemUpdatePage = read(path.join(root, "src", "app", "(sidebar)", "settings", "system-update", "page.tsx"));
const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const stageDir = path.join(root, "release-artifacts", "fnos", "mmh-fpk");
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

expect(/provider = "sqlite"/.test(schemaScript), "Native schema generator must switch datasource provider to sqlite.");
expect(/@db\\\./.test(schemaScript), "Native schema generator must strip PostgreSQL native column annotations.");
expect(/PRISMA_SCHEMA_PATH/.test(prismaConfig), "Prisma config must allow selecting the native schema.");
expect(/PrismaBetterSqlite3/.test(dbClient), "Database client must support the SQLite adapter.");
expect(/connectionString\.startsWith\("file:"\)/.test(dbClient), "Database client must route file: URLs to SQLite.");
expect(/FNOS_NODE_TARBALL/.test(buildScript), "fnOS package build must require an explicit Linux Node runtime input.");
expect(/normalizeFnosVersion/.test(buildScript), "fnOS package build must normalize Release tags into package versions.");
expect(/os_min_version=\$\{osMinVersion\}/.test(buildScript), "fnOS manifest must include os_min_version for official submission.");
expect(/changelog=\$\{changelog\}/.test(buildScript), "fnOS manifest must include a changelog for official submission.");
expect(/process\.platform === "linux"/.test(buildScript), "fnOS release builds must be guarded to Linux/fnOS.");
expect(/resolve_data_dest/.test(buildScript), "fnOS start script must resolve a persistent fnOS data directory.");
expect(/TRIM_PKGVAR\/data/.test(buildScript), "fnOS start script must prefer TRIM_PKGVAR/data when TRIM_DATADEST is unavailable.");
expect(/@appdata\/"\$appname"/.test(buildScript), "fnOS start script fallback must use the fnOS appdata directory.");
expect(!/TRIM_DATADEST:-\$APP_DEST\/data/.test(buildScript), "fnOS start script must not fall back to the app install directory for SQLite data.");
expect(/DATABASE_URL="file:\$DATA_DEST\/mmh\.db"/.test(buildScript), "fnOS start script must store SQLite data under the resolved persistent data directory.");
expect(/SELECT name FROM sqlite_master WHERE type = 'table'/.test(buildScript), "fnOS SQLite init must check for existing user tables before applying the initial schema.");
expect(/if \(!existing\)/.test(buildScript), "fnOS SQLite init must skip schema creation when an existing database is present.");
expect(/export MMH_DEPLOY_TARGET=fnos/.test(buildScript), "fnOS start script must mark the deployment target as fnos.");
expect(/FNOS_MANUAL_FPK/.test(buildScript), "fnOS package build should keep an explicit manual test FPK mode.");
expect(/schema\.native\.prisma/.test(appBuildScript), "fnOS app build must generate and build against the SQLite schema.");
expect(/MMH_DEPLOY_TARGET/.test(systemUpdateRoute), "System update API must detect fnOS by MMH_DEPLOY_TARGET.");
expect(/isFnos/.test(systemUpdateRoute), "System update API must return an explicit isFnos flag.");
expect(/飞牛版请通过飞牛应用中心更新 MMH 应用包/.test(systemUpdateRoute), "System update API must reject in-app updates for fnOS.");
expect(/软件更新（飞牛应用包）/.test(systemUpdatePage), "System update page must label fnOS updates as app-package updates.");
expect(/mmh\.fpk/.test(systemUpdatePage) && /飞牛应用中心/.test(systemUpdatePage), "System update page must guide fnOS users to update with mmh.fpk.");
expect(!/docker-project/.test(buildScript), "fnOS package build must not declare Docker resources.");
expect(/better-sqlite3/.test(buildScript), "fnOS package build must explicitly include the SQLite native runtime dependency.");
expect(/release:\s*\n\s*types:\s*\[published\]/.test(fnosReleaseWorkflow), "fnOS workflow should run when a GitHub Release is published.");
expect(/npm ci/.test(fnosReleaseWorkflow), "fnOS workflow should install Linux native dependencies.");
expect(/FNOS_NODE_TARBALL/.test(fnosReleaseWorkflow), "fnOS workflow should provide a Linux Node runtime tarball.");
expect(/npm run build:fnos:app/.test(fnosReleaseWorkflow), "fnOS workflow should build the Linux SQLite standalone app.");
expect(/npm run build:fnos/.test(fnosReleaseWorkflow), "fnOS workflow should build the formal .fpk package.");
expect(/release-artifacts\/fnos\/\*\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow should upload .fpk files.");
expect(!/path:\s*release-artifacts\/fnos\/\*-fpk-source\.tgz/.test(fnosReleaseWorkflow), "fnOS release workflow must not upload stage-only .tgz files.");
expect(/fnpack was not found/.test(fnosReleaseWorkflow), "fnOS workflow should fail clearly when fnpack is unavailable.");
expect(/mmh\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow should detect existing mmh.fpk assets.");
expect(!/mmh-native\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow must not publish a second mmh-native.fpk package.");

if (fs.existsSync(stageDir)) {
  for (const envFile of [".env", ".env.local", ".env.production", ".env.development"]) {
    expect(!fs.existsSync(path.join(stageDir, "app", "server", envFile)), `fnOS stage must not include ${envFile}.`);
  }
  expectPngSize(path.join(stageDir, "ICON.PNG"), 64);
  expectPngSize(path.join(stageDir, "ICON_256.PNG"), 256);
  if (fs.existsSync(path.join(stageDir, "app"))) {
    expectPngSize(path.join(stageDir, "app", "ui", "images", "icon_64.png"), 64);
    expectPngSize(path.join(stageDir, "app", "ui", "images", "icon_256.png"), 256);
  }
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
