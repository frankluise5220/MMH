#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rawVersion = process.env.SYNOLOGY_PACKAGE_VERSION || process.env.SYNOPKG_PACKAGE_VERSION || pkg.version || "0.1.0";
const verifyVersion = normalizeVersion(rawVersion);
const verifyTarget = normalizeTarget(process.env.SYNOLOGY_TARGET_ARCH || process.env.SYNOPKG_TARGET_ARCH || "x86_64");

function normalizeVersion(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^refs\/tags\//, "")
    .replace(/^v(?=\d)/, "")
    .replace(/-synology(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    fail(`SYNOLOGY_PACKAGE_VERSION must use 0.1.x format, got ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function normalizeTarget(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["", "x86", "x86-64", "x64", "amd64"].includes(raw)) {
    return {
      id: "x86_64",
      assetSuffix: "x86_64",
      infoArch: "x86_64",
      stageDirName: "mmh-spk",
      nodeArch: "x64",
    };
  }
  if (["arm", "arm64", "aarch64", "armv8"].includes(raw)) {
    return {
      id: "arm64",
      assetSuffix: "arm64",
      infoArch: "aarch64",
      stageDirName: "mmh-arm64-spk",
      nodeArch: "arm64",
    };
  }
  fail(`SYNOLOGY_TARGET_ARCH must be x86_64 or arm64, got ${value || "(empty)"}.`);
}

function fail(message) {
  console.error(`Synology package check failed: ${message}`);
  process.exit(1);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
  });
}

function spkAssetName() {
  return `mmh-synology-v${verifyVersion}-${verifyTarget.assetSuffix}.spk`;
}

function tarList(file) {
  const result = run("tar", ["-tzf", file]);
  expect(result.status === 0, `Unable to inspect tar archive ${path.relative(root, file)}.`);
  return (result.stdout || "").split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, ""));
}

function tarHas(entries, entry) {
  return entries.includes(entry) || entries.includes(`./${entry}`);
}

function verifySourceFiles() {
  const packageJson = read(path.join(root, "package.json"));
  const appBuildScript = read(path.join(root, "scripts", "build-synology-app.cjs"));
  const packageScript = read(path.join(root, "scripts", "build-synology-package.cjs"));
  const releaseWorkflow = read(path.join(root, ".github", "workflows", "synology-release.yml"));

  expect(/build:synology:app/.test(packageJson), "package.json must expose build:synology:app.");
  expect(/build:synology/.test(packageJson), "package.json must expose build:synology.");
  expect(/check:synology/.test(packageJson), "package.json must expose check:synology.");
  expect(/MMH_DEPLOY_TARGET:\s*"synology"/.test(appBuildScript), "Synology app build must mark the deployment target.");
  expect(/MMH_DEPLOY_TARGET=synology/.test(packageScript), "Synology start script must mark runtime deployment as synology.");
  expect(/DATABASE_URL="file:\$DATA_DIR\/mmh\.db"/.test(packageScript), "Synology start script must store SQLite data under the package data directory.");
  expect(/package="\$\{appName\}"/.test(packageScript) && /const appName = "mmh"/.test(packageScript), "Synology INFO must keep the stable package id mmh.");
  expect(/\$\{appName\}-synology-v\$\{version\}-\$\{target\.assetSuffix\}\.spk/.test(packageScript), "Synology SPK asset names must include version and architecture.");
  expect(/release-artifacts\/synology\/\*\.spk/.test(releaseWorkflow), "Synology release workflow must upload SPK assets.");
  expect(/target_arch/.test(releaseWorkflow) && /arm64/.test(releaseWorkflow), "Synology release workflow must build x86_64 and arm64 packages.");
}

function verifyStagedSource() {
  const stageDir = path.join(root, "release-artifacts", "synology", verifyTarget.stageDirName);
  if (!fs.existsSync(stageDir)) return;
  const info = read(path.join(stageDir, "INFO"));
  const startScript = read(path.join(stageDir, "scripts", "start-stop-status"));
  expect(new RegExp(`version="${verifyVersion}"`).test(info), "Staged INFO must contain the package version.");
  expect(new RegExp(`arch="${verifyTarget.infoArch}"`).test(info), "Staged INFO must contain the target architecture.");
  expect(/MMH_DEPLOY_TARGET=synology/.test(startScript), "Staged start-stop-status must mark runtime deployment as synology.");
  expect(fs.existsSync(path.join(stageDir, "package", "app", "server", "server.js")), "Staged package must contain the Next standalone server.");
  expect(fs.existsSync(path.join(stageDir, "package", "app", "bin", "node")), `Staged package must contain a Linux ${verifyTarget.nodeArch} Node runtime.`);
}

function verifyBuiltSpk() {
  const spkPath = path.join(root, "release-artifacts", "synology", spkAssetName());
  expect(fs.existsSync(spkPath), `Built Synology ${verifyTarget.id} SPK must exist before upload.`);
  const entries = tarList(spkPath);
  for (const required of [
    "INFO",
    "PACKAGE_ICON.PNG",
    "PACKAGE_ICON_256.PNG",
    "conf/privilege",
    "scripts/start-stop-status",
    "scripts/preupgrade",
    "scripts/postupgrade",
    "package.tgz",
  ]) {
    expect(tarHas(entries, required), `Built SPK must contain ${required}.`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-synology-spk-"));
  try {
    const extract = run("tar", ["-xzf", spkPath, "-C", tmpDir, "package.tgz"]);
    expect(extract.status === 0, "Unable to extract package.tgz from built SPK.");
    const packageEntries = tarList(path.join(tmpDir, "package.tgz"));
    for (const required of [
      "app/bin/node",
      "app/server/server.js",
      "app/server/scripts/init-sqlite.cjs",
      "app/server/prisma/schema.native.prisma",
    ]) {
      expect(tarHas(packageEntries, required), `Built package.tgz must contain ${required}.`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

verifySourceFiles();
verifyStagedSource();
if (process.env.SYNOLOGY_VERIFY_BUILT_SPK === "1") verifyBuiltSpk();
console.log(`Synology package checks passed for ${verifyTarget.id}.`);
