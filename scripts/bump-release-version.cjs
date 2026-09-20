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

function compareVersions(left, right) {
  return parseVersion(left) - parseVersion(right);
}

function nextVersion(current) {
  const patch = parseVersion(current);
  return `0.1.${patch + 1}`;
}

function todayDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fnosFpkAssetName(version, assetSuffix) {
  return `mmh-fnos-v${version}-${assetSuffix}.fpk`;
}

function fnosVpsX86Url(version) {
  return `http://fnapp.floatingice.win/apps/mmh-${version}.fpk`;
}

function fnosDownloadUrls(version) {
  const base = `https://github.com/frankluise5220/MMH/releases/download/v${version}`;
  return {
    x86_64: fnosVpsX86Url(version),
    arm64: `${base}/${fnosFpkAssetName(version, "arm64")}`,
  };
}

function fnosFndepotPackages(version) {
  const urls = fnosDownloadUrls(version);
  return {
    x86: {
      download_url: urls.x86_64,
    },
    arm: {
      download_url: urls.arm64,
    },
  };
}

function pruneReleaseHistory(releases, keepCount = 5) {
  const ordered = Object.entries(releases || {})
    .filter(([version]) => versionPattern.test(version))
    .sort(([left], [right]) => compareVersions(left, right));
  return Object.fromEntries(ordered.slice(-keepCount));
}

function updatePackageJson(version) {
  const file = path.join(root, "package.json");
  const pkg = readJson(file);
  pkg.version = version;
  // Force every release to write a fresh short App Center changelog. An empty
  // value makes the built-fpk verify fail instead of silently shipping the
  // previous release's one-line manifest summary.
  pkg.mmhFnosManifestChangelog = "";
  writeJson(file, pkg);
}

function updatePackageLock(version) {
  const file = path.join(root, "package-lock.json");
  const lock = readJson(file);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeJson(file, lock);
}

function updateFnosRepositoryJson(version, file, rootKey, manifestChangelog) {
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
    app.changelog = manifestChangelog;
    app.type = "原生";
    app.updated_at = todayDate();
    if (!Array.isArray(app.screenshots) || app.screenshots.length === 0) {
      app.screenshots = [
        "http://fnapp.floatingice.win/previews/mmh/1.PNG",
        "http://fnapp.floatingice.win/previews/mmh/2.PNG",
      ];
    }
  }
  writeJson(fullPath, payload);
}

function updateFndepotFnpackJson(version, manifestChangelog) {
  const file = path.join(root, "deploy", "fnos", "repository", "fnpack.json");
  const payload = readJson(file);
  const app = payload.apps?.mmh;
  if (!app) return;
  app.platform = ["x86", "arm"];
  if (typeof app.icon_url === "string") {
    app.icon_url = app.icon_url.replace(/([?&]v=)[^&]+/, `$1${version}`);
  }
  const releases = app.releases && typeof app.releases === "object" ? app.releases : {};
  const current = releases[version] && typeof releases[version] === "object" ? releases[version] : {};
  releases[version] = {
    ...current,
    changelog: manifestChangelog,
    os_min_version: current.os_min_version || "0.9.0",
    packages: fnosFndepotPackages(version),
  };
  app.releases = pruneReleaseHistory(releases);
  writeJson(file, payload);
}

function updateLegacyFnosAppstore(version, manifestChangelog) {
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
    app._manual.changelog = manifestChangelog;
  }
  writeJson(file, payload);
}

const pkg = readJson(path.join(root, "package.json"));
const version = nextVersion(pkg.version);
const manifestChangelog = "";

updatePackageJson(version);
updatePackageLock(version);
updateFnosRepositoryJson(version, path.join("deploy", "fnos", "repository", "apps.example.json"), "apps", manifestChangelog);
updateFnosRepositoryJson(version, path.join("deploy", "fnos", "repository", "api", "apps"), undefined, manifestChangelog);
updateFndepotFnpackJson(version, manifestChangelog);
updateLegacyFnosAppstore(version, manifestChangelog);

console.log(`MMH release version bumped to ${version}.`);
