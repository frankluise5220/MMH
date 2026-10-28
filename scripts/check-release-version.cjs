#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const storeChangelog = require("./store-changelog.cjs");

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

function parseVersion(version) {
  const match = /^0\.1\.(\d+)$/.exec(String(version || "").trim());
  if (!match) return null;
  return Number(match[1]);
}

function compareVersions(left, right) {
  const leftPatch = parseVersion(left);
  const rightPatch = parseVersion(right);
  if (leftPatch === null || rightPatch === null) return 0;
  return leftPatch - rightPatch;
}

function getFndepotRelease(payload, version) {
  return payload.apps?.mmh?.releases?.[version];
}

const pkg = readJson("package.json");
const version = String(pkg.version || "").trim();
const releaseNotes = String(pkg.mmhReleaseNotes || "").trim();
const manifestChangelog = String(pkg.mmhFnosManifestChangelog || "").trim();
const downloadUrls = fnosDownloadUrls(version);

expect(/^0\.1\.\d+$/.test(version), `package.json version must use 0.1.x format, got ${version || "(empty)"}.`);
expect(releaseNotes.length > 0, "package.json must include non-empty mmhReleaseNotes for release/version display.");
expect(manifestChangelog.length > 0, "package.json must include non-empty mmhFnosManifestChangelog for fnOS App Center version notes.");
expect(manifestChangelog.length <= 600, "package.json mmhFnosManifestChangelog must stay short (<= 600 chars); full notes belong in mmhReleaseNotes.");
expect(!/##|\*\*|-\s/.test(manifestChangelog), "package.json mmhFnosManifestChangelog must be plain text without Markdown markers.");
expect(new RegExp(`完整说明见 GitHub Release v${version.replace(/\./g, "\\.")}$`).test(manifestChangelog), "package.json mmhFnosManifestChangelog must end with the matching GitHub Release reference.");

expect(!/fn-appstores-client-2\.5\.2-x86\.fpk/.test(releaseNotes), "mmhReleaseNotes must not revive the retired FN 软仓客户端 2.5.2 x86 link.");
expect(!/名称自定义/.test(releaseNotes), "mmhReleaseNotes must not revive the retired 名称自定义 dedicated-source phrasing.");
expect(!/fn-appstores-client-2\.8\.4-x86\.fpk/.test(releaseNotes), "mmhReleaseNotes must not revive the retired FN 软仓客户端 2.8.4 x86 link (HTTP 404).");
expect(!/fn-appstores-client-2\.9\.2-all\.fpk/.test(releaseNotes), "mmhReleaseNotes must not revive the retired FN 软仓客户端 2.9.2 all.fpk link (superseded by 2.9.5).");
expect(/fn-appstores-client-2\.9\.5-all\.fpk/.test(releaseNotes), "mmhReleaseNotes must keep the FN 软仓客户端 2.9.5 all.fpk link.");
expect(/fnapp\.floatingice\.win:5660\//.test(releaseNotes), "mmhReleaseNotes dedicated source URL must keep the trailing slash.");

// mmhReleaseNotesI18n 是**可选**的界面语言译文载体：应用内「本版说明」按界面语言取
// ——面板正文 = 各渠道共用的 mmhFnosManifestChangelog（不是 Release 正文
// mmhReleaseNotes），取不到就回落中文（见 .skill/mmh-release/references/update-notes-surfaces.md §2.6）。
// 没有译文时必须**整个字段省略**——空对象、空字符串或非法语言键都会让应用端出现
// 「该语言下说明为空」的假象，所以这里是硬断言。
const releaseNotesI18n = pkg.mmhReleaseNotesI18n;
const releaseNotesI18nKeys = ["zh-CN", "en-US", "ja-JP"];
if (releaseNotesI18n !== undefined) {
  const isPlainObject = releaseNotesI18n !== null && typeof releaseNotesI18n === "object" && !Array.isArray(releaseNotesI18n);
  expect(isPlainObject, "package.json mmhReleaseNotesI18n must be an object keyed by zh-CN / en-US / ja-JP, or be omitted entirely.");
  if (isPlainObject) {
    const keys = Object.keys(releaseNotesI18n);
    expect(keys.length > 0, "package.json mmhReleaseNotesI18n must be omitted entirely when there is no translation; an empty object is not allowed.");
    // zh-CN 是本字段的正典语言：应用内先按界面语言取，取不到回落 zh-CN
    // （共享的 mmhFnosManifestChangelog 是单行纯文本，只作旧包的最后兜底）。
    // 只写 en-US 会让中文界面退回那一行挤成一团的文本，所以这里挡住。
    expect(keys.includes("zh-CN"), "package.json mmhReleaseNotesI18n must include zh-CN: it is the canonical in-app 本版说明 body and the fallback for every other UI language.");
    for (const key of keys) {
      expect(releaseNotesI18nKeys.includes(key), `package.json mmhReleaseNotesI18n has unsupported language key ${key}; only zh-CN / en-US / ja-JP are allowed.`);
      const value = releaseNotesI18n[key];
      expect(
        typeof value === "string" && value.trim().length > 0,
        `package.json mmhReleaseNotesI18n.${key} must be a non-empty release-notes string; omit the key instead of leaving it empty.`,
      );
      // 这个字段只喂应用内面板，面板已经不再显示 GitHub Release 正文：
      // 塞正文的固定块 = 2026-10-15「应用内变成发布公告」的回归；
      // 塞「打包与部署」= 2026-10-16 用户明确的否定（本版说明不是 Release 全文，
      // 用户关心的是能用上什么，不是哪个渠道重新打包了）。
      expect(
        !/安装 \/ 更新说明|手机端使用建议|打包与部署/.test(value),
        `package.json mmhReleaseNotesI18n.${key} must stay the in-app 本版说明 body: no GitHub Release body blocks (安装 / 更新说明, 手机端使用建议) and no 打包与部署 group.`,
      );
    }
  }
}


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
  expect(app.version === version, `${file} version must match package.json.`);
  expect(app.platform === "x86", `${file} platform must keep x86 as the legacy default platform.`);
  expect(Array.isArray(app.platforms), `${file} platforms must list supported fnOS architectures.`);
  expect(app.platforms?.includes("x86"), `${file} platforms must include x86.`);
  expect(app.platforms?.includes("arm"), `${file} platforms must include arm.`);
  expect(app.download_url === downloadUrls.x86_64, `${file} download_url must point to the x86_64 FPK for v${version}.`);
  expect(!("x86" in (app.download_urls || {})), `${file} download_urls must not publish a third x86 alias URL.`);
  expect(app.download_urls?.x86_64 === downloadUrls.x86_64, `${file} download_urls.x86_64 must use the unified v${version} Release tag.`);
  expect(app.download_urls?.arm64 === downloadUrls.arm64, `${file} download_urls.arm64 must use the unified v${version} Release tag.`);
  expect(app.changelog === manifestChangelog, `${file} changelog must match package.json mmhFnosManifestChangelog.`);
  expect(app.type === "原生", `${file} type must be 原生 for the FN soft-store native filter.`);
  expect(/^\d{4}-\d{2}-\d{2}$/.test(app.updated_at || ""), `${file} updated_at must use YYYY-MM-DD for the FN soft-store new-apps sort.`);
  expect(Array.isArray(app.screenshots) && app.screenshots.length > 0, `${file} screenshots must list at least one preview image.`);
}

// FN 软仓「应用介绍」= `desc` / `description`（2026-10-16 用户决定「换成长清单逐条一行」）。
// 客户端（fn-appstores-client 前端 JS）按 **HTML** 渲染 `desc`，所以逐条换行只能用 `<br>`；
// 而同一个客户端又会把 `desc` 去标签后按**真实 `\n`** 拆行，行数 ≥ 2 就渲染一个与「应用介绍」
// 重复的「更新内容」面板 —— 所以 `desc` 里一个真实换行都不能有。
// —— 因此 `desc` 里**一个真实换行都不能有**。这两条互为表里，少一条就把旧的重复故障带回来。
const storeUpdateBlock = storeChangelog.softstoreUpdateBlock(version);
const storeDescPrefix = `${storeUpdateBlock}${storeChangelog.HTML_SEPARATOR}${storeChangelog.HTML_SEPARATOR}${storeChangelog.INTRO_MARKER}`;
const mmhManualApps = (payload) =>
  (Array.isArray(payload) ? payload : []).filter((item) => item.id === "mmh").map((item) => item._manual);
for (const target of [
  { file: "deploy/fnos/repository/apps.example.json", field: "description", getApps: (payload) => payload.apps ?? [] },
  { file: "deploy/fnos/repository/api/apps", field: "desc", getApps: (payload) => payload.data ?? [] },
  { file: "fn-appstores.json", field: "desc", getApps: mmhManualApps },
  { file: "deploy/fnos/selfhosted-source/data/fn-appstores.json", field: "desc", getApps: mmhManualApps },
]) {
  // `deploy/fnos/selfhosted-source/` is gitignored (it is the VPS seed copy), so this
  // file does not exist in a CI checkout. Reading it unconditionally crashed the
  // `release: published` backfill with ENOENT and silently cost 0.1.74 its FnDepot
  // metadata; skip absent optional targets instead of failing the whole gate.
  if (!fs.existsSync(path.join(root, target.file))) continue;
  for (const app of target.getApps(readJson(target.file)).filter(Boolean)) {
    const desc = typeof app[target.field] === "string" ? app[target.field] : "";
    expect(
      desc.startsWith(storeDescPrefix),
      `${target.file} ${target.field} must carry the per-item 【本版更新】 block derived from package.json mmhReleaseNotesI18n["zh-CN"] (run npm run sync:store-desc).`,
    );
    expect(
      !/[\r\n]/.test(desc),
      `${target.file} ${target.field} must not contain real newlines: fn-appstores-client splits desc by \\n and would then render a duplicated 「更新内容」 panel.`,
    );
  }
}

const fndepotFnpack = readJson("deploy/fnos/repository/fnpack.json");
const fndepotApp = fndepotFnpack.apps?.mmh;
expect(fndepotApp, "deploy/fnos/repository/fnpack.json must contain the mmh app entry under apps for FnDepot.");
if (fndepotApp) {
  const releaseVersions = Object.keys(fndepotApp.releases || {})
    .filter((releaseVersion) => parseVersion(releaseVersion) !== null)
    .sort(compareVersions);
  expect(releaseVersions.length <= 5, "deploy/fnos/repository/fnpack.json must keep at most the latest 5 release versions.");
  expect(releaseVersions.every((releaseVersion, index, list) => index === 0 || compareVersions(list[index - 1], releaseVersion) < 0), "deploy/fnos/repository/fnpack.json release versions must stay in ascending version order.");
  const fndepotRelease = fndepotApp.releases?.[version];
  // 当前版本的条目允许「不存在」：未发布的版本不该出现在源里，条目由
  // release: published 的 sync workflow 创建（见 scripts/sync-fndepot-source.cjs）。
  // 但一旦存在，就必须是完整、正确、可下载的条目。
  if (fndepotRelease) {
    // 2026-10-16 用户决定「FnDepot 也改成分行」：FnDepot「更新内容」不再是单行的
    // mmhFnosManifestChangelog，而是从 mmhReleaseNotesI18n["zh-CN"] 派生的逐条一行文本
    // （与软件内「本版说明」同一份清单，只做 `\n` 分隔的形态适配）。没有该正典时仍退回单行。
    const expectedFndepotChangelog = storeChangelog.hasDerivedNotes()
      ? storeChangelog.fndepotChangelog(version)
      : manifestChangelog;
    expect(
      fndepotRelease.changelog === expectedFndepotChangelog,
      "deploy/fnos/repository/fnpack.json releases changelog must equal the per-item changelog derived from package.json mmhReleaseNotesI18n[\"zh-CN\"] (release: published 的 fnos-fndepot-sync.yml 会写入；本地可跑 node scripts/sync-fndepot-source.cjs --version <ver>).",
    );
    expect(fndepotRelease.packages?.x86?.download_url === downloadUrls.x86_64, "deploy/fnos/repository/fnpack.json releases x86 download_url must point to the x86_64 FPK for v${version}.");
    expect(fndepotRelease.packages?.arm?.download_url === downloadUrls.arm64, "deploy/fnos/repository/fnpack.json releases arm download_url must point to the arm64 FPK for v${version}.");
  }

  // 1) 源里出现的每个版本条目都必须"真的发布过"。
  //    fnos-fndepot-sync.yml 只对 GitHub 上已 published 的 Release 回填 sha256/size，
  //    所以「只有 download_url、没有 sha256/size」= 该版本在源里可见却永远下不动
  //    （FnDepot 下载前做 Range 探测，会报「Range 探测返回 HTTP 404」）。
  //    未发布的版本不应进源，因此这里对**所有**条目一律要求 sha256/size。
  //    2) changelog 必须归属自己的版本。
  //    历史事故 cd5bab17 把 0.1.65~0.1.68 四条 changelog 全量替换成了 0.1.69 的文案，
  //    而旧断言只校验当前版本条目，于是整批错误一路绿灯进了发布源。
  for (const releaseVersion of releaseVersions) {
    const release = fndepotApp.releases[releaseVersion];
    for (const arch of ["x86", "arm"]) {
      const branch = release.packages?.[arch];
      expect(branch, `deploy/fnos/repository/fnpack.json ${releaseVersion}/${arch} must exist.`);
      if (!branch) continue;
      expect(
        typeof branch.sha256 === "string" && /^[0-9a-f]{64}$/.test(branch.sha256),
        `deploy/fnos/repository/fnpack.json ${releaseVersion}/${arch} must carry sha256: 该版本在源里但没有已发布的 Release（死链），请删除条目，或先发布再回填。`,
      );
      expect(
        Number.isInteger(branch.size) && branch.size > 0,
        `deploy/fnos/repository/fnpack.json ${releaseVersion}/${arch} must carry size: 该版本在源里但没有已发布的 Release（死链），请删除条目，或先发布再回填。`,
      );
    }
    expect(
      typeof release.changelog === "string" && release.changelog.includes(`GitHub Release v${releaseVersion}`),
      `deploy/fnos/repository/fnpack.json ${releaseVersion} changelog must reference its own release (GitHub Release v${releaseVersion}); 不要把当前版本的说明复制到历史版本上，实际内容：${release.changelog || "(empty)"}`,
    );
  }
}

const legacyAppstore = readJson("fn-appstores.json");
const legacyApp = Array.isArray(legacyAppstore) ? legacyAppstore.find((app) => app.id === "mmh")?._manual : null;
expect(legacyApp, "fn-appstores.json must contain the mmh _manual app entry.");
if (legacyApp) {
  expect(legacyApp.version === version, "fn-appstores.json _manual version must match package.json.");
  expect(legacyApp.platform === "x86", "fn-appstores.json _manual platform must keep x86 as the default platform.");
  expect(Array.isArray(legacyApp.platforms), "fn-appstores.json _manual platforms must list supported fnOS architectures.");
  expect(legacyApp.platforms?.includes("x86"), "fn-appstores.json _manual platforms must include x86.");
  expect(legacyApp.platforms?.includes("arm"), "fn-appstores.json _manual platforms must include arm.");
  expect(legacyApp.download_url === downloadUrls.x86_64, "fn-appstores.json _manual download_url must point to the x86_64 FPK.");
  expect(!("x86" in (legacyApp.download_urls || {})), "fn-appstores.json _manual download_urls must not publish a third x86 alias URL.");
  expect(legacyApp.download_urls?.x86_64 === downloadUrls.x86_64, "fn-appstores.json _manual download_urls.x86_64 must use the unified Release tag.");
  expect(legacyApp.download_urls?.arm64 === downloadUrls.arm64, "fn-appstores.json _manual download_urls.arm64 must use the unified Release tag.");
  expect(legacyApp.changelog === manifestChangelog, "fn-appstores.json _manual changelog must match package.json mmhFnosManifestChangelog.");
}

const dockerWorkflow = read(".github/workflows/docker-build.yml");
expect(/tags:\s*\n\s*-\s*"v\*"/.test(dockerWorkflow), "Docker workflow must run on v* tag pushes so release images can be published from the release tag.");
expect(/npm run check:docker/.test(dockerWorkflow), "Docker workflow must run check:docker before publishing images.");
// Tag ownership moved on 2026-10-27: a v* tag push builds sha-<commit>
// snapshots only, and `latest` / the package version tag are written by the
// `release: published` build. v0.1.78 leaked `latest` from the tag push ~27h
// before publication, and a Docker user upgraded to a commit whose schema had
// no HouseholdPreference.detailWindowYears (P2022 ColumnNotFound afterwards).
expect(/release:\s*\n\s*types:\s*\[published\]/.test(dockerWorkflow), "Docker workflow must also run on `release: published`, which is the only event allowed to write the public image tags.");
expect(/type=raw,value=latest,enable=\$\{\{\s*github\.event_name == 'release'\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish latest only from the `release: published` build, never from a tag push (a draft may be tagged for days before the user confirms it).");
expect(/type=semver,pattern=\{\{version\}\},enable=\$\{\{\s*github\.event_name == 'release'\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish the package version tag only from the `release: published` build.");
expect(/type=raw,value=main,enable=\$\{\{\s*github\.event_name == 'push' &&\s*endsWith\(github\.ref,\s*'\/heads\/main'\)\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish main snapshots without moving latest.");
expect(!/type=raw,value=latest,enable=\$\{\{\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(dockerWorkflow), "Docker workflow must not go back to publishing latest on tag pushes.");

for (const file of [".github/workflows/fnos-release.yml", ".github/workflows/fnos-stage.yml"]) {
  const workflow = read(file);
  expect(!/0\.1\.0-fnos/.test(workflow), `${file} must not default to the old 0.1.0-fnos version.`);
  expect(/default:\s*""/.test(workflow), `${file} manual package_version should default to blank so package.json owns the version.`);
}

for (const file of [".github/workflows/synology-release.yml", ".github/workflows/synology-stage.yml"]) {
  const workflow = read(file);
  expect(!/0\.1\.0-synology/.test(workflow), `${file} must not default to an old Synology package version.`);
  expect(/default:\s*""/.test(workflow), `${file} manual package_version should default to blank so package.json owns the version.`);
}

const synologyReleaseWorkflow = read(".github/workflows/synology-release.yml");
expect(/release-artifacts\/synology\/\*\.spk/.test(synologyReleaseWorkflow), "Synology release workflow must upload SPK assets.");
expect(/target_arch/.test(synologyReleaseWorkflow) && /arm64/.test(synologyReleaseWorkflow), "Synology release workflow must build both x86_64 and arm64 packages.");

expect(/org\.opencontainers\.image\.version=\$\{APP_VERSION\}/.test(read("Dockerfile")), "Dockerfile must label images with APP_VERSION.");
expect(/org\.opencontainers\.image\.version=\$\{APP_VERSION\}/.test(read("Dockerfile.updater")), "Dockerfile.updater must label images with APP_VERSION.");

if (failures.length > 0) {
  console.error("Release version check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release version check passed for ${version}.`);
