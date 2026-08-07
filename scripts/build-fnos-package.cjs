#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = process.env.FNOS_PACKAGE_VERSION || pkg.version || "0.1.0";
const appName = "mmh";
const outDir = path.join(root, "release-artifacts", "fnos");
const stageDir = path.join(outDir, `${appName}-fpk`);
const stageOnly = process.argv.includes("--stage-only");
const nodeTarball = process.env.FNOS_NODE_TARBALL || "";
const isLinux = process.platform === "linux";
const manualFpk = process.env.FNOS_MANUAL_FPK === "1";

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function write(file, content, mode) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content.replace(/\r\n/g, "\n"), "utf8");
  if (mode) fs.chmodSync(file, mode);
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writeSolidPng(file, size) {
  mkdirp(path.dirname(file));
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + size * 4);
  row[0] = 0;
  for (let offset = 1; offset < row.length; offset += 4) {
    row[offset] = 0x1d;
    row[offset + 1] = 0x23;
    row[offset + 2] = 0x30;
    row[offset + 3] = 0xff;
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  fs.writeFileSync(file, Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function copyIcon(src, dest, size) {
  if (fs.existsSync(src)) {
    copyFile(src, dest);
    return;
  }
  writeSolidPng(dest, size);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
  });
}

function hasCommand(command) {
  const probe = process.platform === "win32"
    ? run("where.exe", [command])
    : run("sh", ["-lc", `command -v ${command}`]);
  return probe.status === 0;
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function requirePath(target, message) {
  if (!fs.existsSync(target)) {
    throw new Error(message);
  }
}

function hashFileMd5(file) {
  const crypto = require("node:crypto");
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

const copiedRuntimePackages = new Set();
let standaloneAppDir = null;
const excludedRuntimePackages = new Set([
  "@electric-sql/pglite",
  "@electric-sql/pglite-socket",
  "@electric-sql/pglite-tools",
  "@hono/node-server",
  "chart.js",
  "mysql2",
  "node-abi",
  "prebuild-install",
  "postgres",
]);

function copyRuntimeDependency(name) {
  return copyDir(path.join(root, "node_modules", name), path.join(stageDir, "app", "server", "node_modules", name));
}

function copyRuntimeDependencyClosure(name) {
  if (excludedRuntimePackages.has(name)) return;
  if (copiedRuntimePackages.has(name)) return;
  copiedRuntimePackages.add(name);
  if (!copyRuntimeDependency(name)) return;

  const packageJson = path.join(root, "node_modules", name, "package.json");
  if (!fs.existsSync(packageJson)) return;

  const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  const dependencies = manifest.dependencies || {};
  for (const dependencyName of Object.keys(dependencies)) {
    copyRuntimeDependencyClosure(dependencyName);
  }
}

function materializeStandaloneSymlinks(baseDir) {
  if (!fs.existsSync(baseDir)) return;
  for (const name of fs.readdirSync(baseDir)) {
    const item = path.join(baseDir, name);
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(item);
      const absoluteTarget = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.resolve(path.dirname(item), linkTarget);
      const relativeFromStandaloneModules = path.relative(path.join(standaloneAppDir || standaloneDir, "node_modules"), absoluteTarget);
      const localTarget = path.join(stageDir, "app", "server", "node_modules", relativeFromStandaloneModules);
      fs.rmSync(item, { force: true });
      if (fs.existsSync(localTarget)) {
        const targetStat = fs.lstatSync(localTarget);
        if (targetStat.isDirectory()) {
          copyDir(localTarget, item);
        } else {
          copyFile(localTarget, item);
        }
      }
      continue;
    }
    if (stat.isDirectory()) {
      materializeStandaloneSymlinks(item);
    }
  }
}

function removeRuntimeDependency(name) {
  fs.rmSync(path.join(stageDir, "app", "server", "node_modules", ...name.split("/")), {
    recursive: true,
    force: true,
  });
}

function findStandaloneAppDir(baseDir) {
  const directServer = path.join(baseDir, "server.js");
  if (fs.existsSync(directServer)) return baseDir;

  const queue = [baseDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") continue;
      const child = path.join(current, entry.name);
      if (fs.existsSync(path.join(child, "server.js"))) return child;
      queue.push(child);
    }
  }
  return baseDir;
}

fs.rmSync(stageDir, { recursive: true, force: true });
for (const dir of [
  "app/bin",
  "app/data",
  "app/server",
  "app/ui/images",
  "cmd",
  "config",
  "wizard",
]) {
  mkdirp(path.join(stageDir, dir));
}

const generatedSchema = run(process.execPath, [path.join(root, "scripts", "generate-native-sqlite-schema.cjs")], {
  stdio: "inherit",
});
if (generatedSchema.status !== 0) process.exit(generatedSchema.status || 1);

write(path.join(stageDir, "manifest"), `
appname=${appName}
version=${version}
desc=一套本地部署、致力于化繁为简的家庭账务管理系统。
display_name=MMH
arch=x86_64
platform=x86
source=thirdparty
maintainer=frankluise5220
maintainer_url=https://github.com/frankluise5220/MMH
distributor=frankluise5220
distributor_url=https://github.com/frankluise5220/MMH
helpurl=https://github.com/frankluise5220/MMH
desktop_uidir=ui
desktop_applaunchname=mmh.Application
service_port=7777
checkport=true
`);

write(path.join(stageDir, "config", "privilege"), JSON.stringify({
  defaults: { "run-as": "package" },
  username: "mmh",
  groupname: "mmh",
}, null, 2));

write(path.join(stageDir, "config", "resource"), JSON.stringify({
  "data-share": {
    shares: [
      {
        name: "mmh",
        permission: {
          rw: ["mmh"],
        },
      },
      {
        name: "mmh/data",
        permission: {
          rw: ["mmh"],
        },
      },
    ],
  },
}, null, 2));

write(path.join(stageDir, "wizard", "install"), JSON.stringify([], null, 2));
write(path.join(stageDir, "app", "ui", "config"), JSON.stringify({
  ".url": {
    "mmh.Application": {
      title: "MMH",
      icon: "images/icon_{0}.png",
      type: "url",
      protocol: "http",
      port: "{port}",
      url: "/",
      allUsers: false,
    },
  },
}, null, 2));

const markIcon = path.join(root, "public", "branding", "mmh-logo-final.square.png");
copyIcon(markIcon, path.join(stageDir, "ICON.PNG"), 64);
copyIcon(markIcon, path.join(stageDir, "ICON_256.PNG"), 256);
copyIcon(markIcon, path.join(stageDir, "app", "ui", "images", "icon_64.png"), 64);
copyIcon(markIcon, path.join(stageDir, "app", "ui", "images", "icon_256.png"), 256);

write(path.join(stageDir, "cmd", "main"), `#!/bin/bash

APP_DEST="\${TRIM_APPDEST:-}"
if [ -z "$APP_DEST" ]; then
  APP_DEST="$(cd "$(dirname "$0")/.." && pwd)"
fi

DATA_DEST="\${TRIM_DATADEST:-$APP_DEST/data}"
SERVER_DIR="$APP_DEST/server"
NODE_BIN="$APP_DEST/bin/node"
PID_FILE="$DATA_DEST/mmh.pid"
LOG_FILE="$DATA_DEST/mmh.log"

start_app () {
  mkdir -p "$DATA_DEST"
  if [ ! -x "$NODE_BIN" ]; then
    echo "Bundled Linux Node runtime is missing: $NODE_BIN" >&2
    exit 1
  fi
  if [ ! -f "$SERVER_DIR/server.js" ]; then
    echo "Next standalone server is missing: $SERVER_DIR/server.js" >&2
    exit 1
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    exit 0
  fi
  export NODE_ENV=production
  export HOSTNAME=0.0.0.0
  export PORT="\${PORT:-7777}"
  export MMH_DEPLOY_TARGET=fnos
  export DATABASE_URL="file:$DATA_DEST/mmh.db"
  export PRISMA_SCHEMA_PATH="$SERVER_DIR/prisma/schema.native.prisma"
  (cd "$SERVER_DIR" && "$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs") >>"$LOG_FILE" 2>&1 || exit 1
  nohup "$NODE_BIN" "$SERVER_DIR/server.js" >>"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
}

stop_app () {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
}

status_app () {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    exit 0
  fi
  exit 3
}

case "\${1:-status}" in
start)
  start_app
  ;;
stop)
  stop_app
  ;;
status)
  status_app
  ;;
*)
  exit 1
  ;;
esac
`, 0o755);

const lifecycle = `#!/bin/bash

exit 0
`;
for (const name of [
  "install_init",
  "install_callback",
  "upgrade_init",
  "upgrade_callback",
  "uninstall_init",
  "uninstall_callback",
  "config_init",
  "config_callback",
]) {
  write(path.join(stageDir, "cmd", name), lifecycle, 0o755);
}

const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");

if (fs.existsSync(standaloneDir)) {
  standaloneAppDir = findStandaloneAppDir(standaloneDir);
  copyDir(standaloneAppDir, path.join(stageDir, "app", "server"));
  copyDir(staticDir, path.join(stageDir, "app", "server", ".next", "static"));
  copyDir(publicDir, path.join(stageDir, "app", "server", "public"));
  copyDir(path.join(root, "prisma"), path.join(stageDir, "app", "server", "prisma"));
  copyFile(path.join(root, "prisma.config.ts"), path.join(stageDir, "app", "server", "prisma.config.ts"));
  const initSql = path.join(stageDir, "app", "server", "prisma", "native-init.sql");
  const diff = run(commandName("npx"), [
    "prisma",
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    path.join(root, "prisma", "schema.native.prisma"),
    "--script",
    "--output",
    initSql,
  ], { stdio: "inherit" });
  if (diff.status !== 0) process.exit(diff.status || 1);
  write(path.join(stageDir, "app", "server", "scripts", "init-sqlite.cjs"), `const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function databasePathFromUrl(value) {
  if (!value || !value.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a SQLite file: URL.");
  }
  const rawPath = value.slice("file:".length);
  return path.resolve(decodeURIComponent(rawPath));
}

const dbPath = databasePathFromUrl(process.env.DATABASE_URL);
const sqlPath = path.join(__dirname, "..", "prisma", "native-init.sql");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
try {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (!existing) {
    db.exec(fs.readFileSync(sqlPath, "utf8"));
    db.exec("CREATE TABLE IF NOT EXISTS _mmh_native_schema (version TEXT NOT NULL PRIMARY KEY, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    db.prepare("INSERT OR IGNORE INTO _mmh_native_schema (version) VALUES (?)").run("0.1.0");
    console.log(\`SQLite database initialized at \${dbPath}\`);
  } else {
    console.log(\`SQLite database already initialized at \${dbPath}\`);
  }
} finally {
  db.close();
}
`);
  for (const dependency of [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
    "bindings",
  ]) {
    copyRuntimeDependencyClosure(dependency);
  }
  for (const envFile of [".env", ".env.local", ".env.production", ".env.development"]) {
    fs.rmSync(path.join(stageDir, "app", "server", envFile), { force: true });
  }
  materializeStandaloneSymlinks(path.join(stageDir, "app", "server", ".next", "node_modules"));
  for (const dependency of [
    "@img",
    "detect-libc",
    "node-abi",
    "prebuild-install",
    "semver",
    "sharp",
  ]) {
    removeRuntimeDependency(dependency);
  }
}

if (nodeTarball) {
  requirePath(nodeTarball, `FNOS_NODE_TARBALL does not exist: ${nodeTarball}`);
  const extract = run("tar", ["-xzf", nodeTarball, "-C", path.join(stageDir, "app", "bin"), "--strip-components=1"]);
  if (extract.status !== 0) {
    console.error(extract.stderr || extract.stdout || "Failed to extract FNOS_NODE_TARBALL.");
    process.exit(extract.status || 1);
  }
}

const hasNode = fs.existsSync(path.join(stageDir, "app", "bin", "bin", "node"));
if (hasNode) {
  fs.renameSync(path.join(stageDir, "app", "bin", "bin", "node"), path.join(stageDir, "app", "bin", "node"));
  for (const entry of fs.readdirSync(path.join(stageDir, "app", "bin"))) {
    if (entry === "node") continue;
    fs.rmSync(path.join(stageDir, "app", "bin", entry), { recursive: true, force: true });
  }
}

console.log(`FNOS SQLite FPK source staged: ${path.relative(root, stageDir)}`);

if (stageOnly) {
  const archive = path.join(outDir, `${appName}-${version}-fpk-source.tgz`);
  const tar = run("tar", ["-czf", archive, "-C", stageDir, "."]);
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.stdout || "tar failed");
    process.exit(tar.status || 1);
  }
  console.log(`FNOS SQLite stage-only archive: ${path.relative(root, archive)}`);
  process.exit(0);
}

try {
  if (!isLinux) {
    throw new Error("fnOS release packages must be built on Linux/fnOS so native Node modules match the target platform.");
  }
  requirePath(path.join(stageDir, "app", "server", "server.js"), "Run the fnOS standalone build before packaging: npm run build:fnos:app");
  requirePath(path.join(stageDir, "app", "bin", "node"), "Provide a Linux x64 Node runtime tarball via FNOS_NODE_TARBALL before building mmh.fpk.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (manualFpk) {
  const appArchive = path.join(stageDir, "app.tgz");
  fs.rmSync(appArchive, { force: true });
  const appTar = run("tar", ["-czf", appArchive, "-C", path.join(stageDir, "app"), "."]);
  if (appTar.status !== 0) {
    console.error(appTar.stderr || appTar.stdout || "app.tgz packaging failed");
    process.exit(appTar.status || 1);
  }
  fs.rmSync(path.join(stageDir, "app"), { recursive: true, force: true });
  fs.appendFileSync(path.join(stageDir, "manifest"), `checksum=${hashFileMd5(appArchive)}\n`, "utf8");
  const fpkPath = path.join(outDir, `${appName}.fpk`);
  const versionedFpkPath = path.join(outDir, `${appName}-${version}.fpk`);
  const fpkTar = run("tar", ["-cf", fpkPath, "-C", stageDir, "."]);
  if (fpkTar.status !== 0) {
    console.error(fpkTar.stderr || fpkTar.stdout || "manual .fpk packaging failed");
    process.exit(fpkTar.status || 1);
  }
  copyFile(fpkPath, versionedFpkPath);
  console.log(`FNOS manual test FPK built: ${path.relative(root, fpkPath)}`);
  process.exit(0);
}

if (!hasCommand("fnpack")) {
  console.error("fnpack was not found. Build the release .fpk on a fnOS packaging environment.");
  process.exit(1);
}

const build = run("fnpack", ["build"], { cwd: stageDir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);

const produced = path.join(stageDir, `${appName}.fpk`);
if (!fs.existsSync(produced)) {
  console.error(`fnpack completed but did not produce ${appName}.fpk.`);
  process.exit(1);
}

copyFile(produced, path.join(outDir, `${appName}.fpk`));
copyFile(produced, path.join(outDir, `${appName}-${version}.fpk`));
console.log(`FNOS SQLite FPK built: ${path.relative(root, path.join(outDir, `${appName}.fpk`))}`);
