#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const versionPattern = /^0\.1\.(\d+)$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseVersion(version) {
  const match = versionPattern.exec(String(version || "").trim());
  if (!match) {
    throw new Error(`Release version must use 0.1.x format, got ${version || "(empty)"}.`);
  }
  return Number(match[1]);
}

function nextVersion(current) {
  const patch = parseVersion(current);
  return `0.1.${patch + 1}`;
}

function getReleaseNotes(pkg) {
  return String(pkg.mmhReleaseNotes || "").trim();
}

function fnosDownloadUrls(version) {
  const base = `https://github.com/frankluise5220/MMH/releases/download/v${version}`;
  return {
    x86_64: `${base}/mmh-x86_64.fpk`,
    arm64: `${base}/mmh-arm64.fpk`,
  };
}

function updatePackageJson(version) {
  const file = path.join(root, "package.json");
  const pkg = readJson(file);
  pkg.version = version;
  writeJson(file, pkg);
}

function updatePackageLock(version) {
  const file = path.join(root, "package-lock.json");
  const lock = readJson(file);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeJson(file, lock);
}

function updateFnosRepositoryJson(version, file, rootKey, releaseNotes) {
  const fullPath = path.join(root, file);
  const payload = readJson(fullPath);
  const apps = Array.isArray(rootKey ? payload[rootKey] : payload.data)
    ? (rootKey ? payload[rootKey] : payload.data)
    : [];
  for (const app of apps) {
    if (app.id !== "mmh") continue;
    app.version = version;
    app.platform = "x86";
    app.platforms = ["x86", "arm"];
    app.download_url = fnosDownloadUrls(version).x86_64;
    app.download_urls = fnosDownloadUrls(version);
    if (typeof app.icon === "string") {
      app.icon = app.icon.replace(/([?&]v=)[^&]+/, `$1${version}`);
    }
    if (releaseNotes) {
      app.changelog = releaseNotes;
    }
  }
  writeJson(fullPath, payload);
}

function updateLegacyFnosAppstore(version, releaseNotes) {
  const file = path.join(root, "fn-appstores.json");
  const payload = readJson(file);
  for (const app of Array.isArray(payload) ? payload : []) {
    if (app.id !== "mmh" || !app._manual) continue;
    app._manual.version = version;
    app._manual.platform = "x86";
    app._manual.platforms = ["x86", "arm"];
    app._manual.download_url = fnosDownloadUrls(version).x86_64;
    app._manual.download_urls = fnosDownloadUrls(version);
    if (typeof app._manual.icon === "string") {
      app._manual.icon = app._manual.icon.replace(/([?&]v=)[^&]+/, `$1${version}`);
    }
    if (releaseNotes) {
      app._manual.changelog = releaseNotes;
    }
  }
  writeJson(file, payload);
}

const pkg = readJson(path.join(root, "package.json"));
const version = nextVersion(pkg.version);
const releaseNotes = getReleaseNotes(pkg);

updatePackageJson(version);
updatePackageLock(version);
updateFnosRepositoryJson(version, path.join("deploy", "fnos", "repository", "apps.example.json"), "apps", releaseNotes);
updateFnosRepositoryJson(version, path.join("deploy", "fnos", "repository", "api", "apps"), undefined, releaseNotes);
updateLegacyFnosAppstore(version, releaseNotes);

console.log(`MMH release version bumped to ${version}.`);
