#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function findMmhApp(payload, key) {
  const apps = Array.isArray(key ? payload[key] : payload.data) ? (key ? payload[key] : payload.data) : [];
  return apps.find((app) => app.id === "mmh");
}

function fnosDownloadUrls(version) {
  const base = `https://github.com/frankluise5220/MMH/releases/download/v${version}`;
  return {
    x86: `${base}/mmh.fpk`,
    x86_64: `${base}/mmh-x86_64.fpk`,
    arm64: `${base}/mmh-arm64.fpk`,
  };
}

const pkg = readJson("package.json");
const version = String(pkg.version || "").trim();
const releaseNotes = String(pkg.mmhReleaseNotes || "").trim();

expect(/^0\.1\.\d+$/.test(version), `package.json version must use 0.1.x format, got ${version || "(empty)"}.`);
expect(releaseNotes.length > 0, "package.json must include non-empty mmhReleaseNotes for release/version display.");

const lock = readJson("package-lock.json");
expect(lock.version === version, "package-lock.json top-level version must match package.json.");
expect(lock.packages?.[""]?.version === version, "package-lock.json root package version must match package.json.");

for (const [file, key] of [
  ["deploy/fnos/repository/apps.example.json", "apps"],
  ["deploy/fnos/repository/api/apps", undefined],
]) {
  const app = findMmhApp(readJson(file), key);
  expect(app, `${file} must contain the mmh app entry.`);
  if (!app) continue;
  const downloadUrls = fnosDownloadUrls(version);
  expect(app.version === version, `${file} version must match package.json.`);
  expect(app.platform === "x86", `${file} platform must keep x86 as the legacy default platform.`);
  expect(Array.isArray(app.platforms), `${file} platforms must list supported fnOS architectures.`);
  expect(app.platforms?.includes("x86"), `${file} platforms must include x86.`);
  expect(app.platforms?.includes("arm"), `${file} platforms must include arm.`);
  expect(app.download_url === downloadUrls.x86, `${file} download_url must keep the x86 legacy mmh.fpk URL for v${version}.`);
  expect(app.download_urls?.x86 === downloadUrls.x86, `${file} download_urls.x86 must use the unified v${version} Release tag.`);
  expect(app.download_urls?.x86_64 === downloadUrls.x86_64, `${file} download_urls.x86_64 must use the unified v${version} Release tag.`);
  expect(app.download_urls?.arm64 === downloadUrls.arm64, `${file} download_urls.arm64 must use the unified v${version} Release tag.`);
  expect(app.changelog === releaseNotes, `${file} changelog must match package.json mmhReleaseNotes.`);
}

const dockerWorkflow = read(".github/workflows/docker-build.yml");
expect(/ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/mmh:\$\{\{\s*steps\.package\.outputs\.version\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish the app image with the package version tag.");
expect(/ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/mmh-updater:\$\{\{\s*steps\.package\.outputs\.version\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish the updater image with the package version tag.");

for (const file of [".github/workflows/fnos-release.yml", ".github/workflows/fnos-stage.yml"]) {
  const workflow = read(file);
  expect(!/0\.1\.0-fnos/.test(workflow), `${file} must not default to the old 0.1.0-fnos version.`);
  expect(/default:\s*""/.test(workflow), `${file} manual package_version should default to blank so package.json owns the version.`);
}

expect(/org\.opencontainers\.image\.version=\$\{APP_VERSION\}/.test(read("Dockerfile")), "Dockerfile must label images with APP_VERSION.");
expect(/org\.opencontainers\.image\.version=\$\{APP_VERSION\}/.test(read("Dockerfile.updater")), "Dockerfile.updater must label images with APP_VERSION.");

if (failures.length > 0) {
  console.error("Release version check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release version check passed for ${version}.`);
