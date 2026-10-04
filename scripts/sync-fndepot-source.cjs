#!/usr/bin/env node
/**
 * FnDepot 外部源 V2（fnpack.json）刷新工具
 *
 * 作用：
 *   1) 为「本次发布」的版本建立/更新 release 条目（--version / VERSION 显式给出时）；
 *      未发布的版本不该出现在源里，所以条目由 `release: published` 触发本脚本创建，
 *      而不是由 `npm run release:version` 在 bump 时写入。
 *   2) 读取现有源文件，向 GitHub Releases API 查询每个版本 FPK 的真实
 *      size / sha256 / 发布时间，补齐 FnDepot V2 规范要求的
 *      packages.<arch>.sha256、packages.<arch>.size、releases.<ver>.updated_at，
 *      并从 api/apps 补齐 preview_urls；对查不到 Release 的死链版本给出警告。
 *   3) 只保留最近 5 个版本（与仓库约定一致）。
 *
 * 用法：
 *   node sync-fndepot-source.cjs --input deploy/fnos/repository/fnpack.json \
 *                                --output ../FnDepot/fnpack.json \
 *                                --repo frankluise5220/MMH \
 *                                [--version 0.1.69] [--drop 0.1.61] [--check]
 *
 * --check 只校验不写文件（用于发布前检查），也不建立条目。
 * 不传 --version / VERSION 时退化为「只刷新已有条目」的旧行为。
 * 默认不改变任何 download_url，仅补字段；--drop 显式剔除指定版本。
 */

const fs = require("node:fs");
const path = require("node:path");

const FIXED_CATEGORIES = [
  "影音娱乐", "系统工具", "编程开发", "AI赋能", "生活服务",
  "智能智控", "教育学习", "游戏地带", "硬件驱动",
];
const ARCH_KEYS = ["all", "x86", "arm"];
const PLATFORM_KEYS = ["all", "x86", "arm"];
const ASSET_SUFFIX = { x86: "x86_64", arm: "arm64" };
const REPO_ROOT = path.resolve(__dirname, "..");
const KEEP_RELEASE_COUNT = 5;

function readPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  } catch (error) {
    console.warn(`[warn] 读取 package.json 失败：${error.message}`);
    return {};
  }
}

// 与 scripts/bump-release-version.cjs 的 fnosDownloadUrls() 保持同一套地址约定。
function fnosPackages(repo, version) {
  return {
    x86: { download_url: `http://fnapp.floatingice.win/apps/mmh-${version}.fpk` },
    arm: {
      download_url: `https://github.com/${repo}/releases/download/v${version}/mmh-fnos-v${version}-arm64.fpk`,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function toShanghaiIso(utcString) {
  const ts = Date.parse(utcString);
  if (Number.isNaN(ts)) return null;
  const shifted = new Date(ts + 8 * 3600 * 1000);
  return `${shifted.toISOString().replace(/\.\d{3}Z$/, "")}+08:00`;
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchRelease(repo, version) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "mmh-fndepot-sync" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const resp = await fetch(url, { headers });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${url}`);
  return resp.json();
}

function readPreviews(repositoryDir) {
  const candidate = path.join(repositoryDir, "api", "apps");
  if (!fs.existsSync(candidate)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(candidate, "utf8"));
    const list = Array.isArray(payload) ? payload : payload.data || [];
    const app = list.find((item) => item.id === "mmh");
    return Array.isArray(app?.screenshots) ? app.screenshots : [];
  } catch (error) {
    console.warn(`[warn] 读取 ${candidate} 失败：${error.message}`);
    return [];
  }
}

function validate(source) {
  const problems = [];
  if (source.schema_version !== "2") problems.push('schema_version 必须是字符串 "2"');
  if (!source.source_info?.name) problems.push("source_info.name 必填");
  if (!source.source_info?.author) problems.push("source_info.author 必填");
  const apps = source.apps || {};
  if (Object.keys(apps).length === 0) problems.push("apps 不能为空");
  for (const [appName, app] of Object.entries(apps)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appName)) problems.push(`${appName}: 应用名不合法`);
    if (!app.display_name) problems.push(`${appName}: display_name 必填`);
    if (!app.desc) problems.push(`${appName}: desc 必填`);
    const platforms = Array.isArray(app.platform) ? app.platform : [app.platform];
    for (const platform of platforms) {
      if (!PLATFORM_KEYS.includes(platform)) problems.push(`${appName}: platform 非法值 ${platform}`);
    }
    for (const category of app.categories || []) {
      if (!FIXED_CATEGORIES.includes(category)) problems.push(`${appName}: categories 非法分类 ${category}`);
    }
    if ((app.categories || []).length > 2) problems.push(`${appName}: categories 最多两项`);
    if (!app.icon_url) problems.push(`${appName}: icon_url 必填`);
    if (!["package", "root"].includes(app.run_as)) problems.push(`${appName}: run_as 必须是 package 或 root`);
    if (typeof app.install_type !== "string") problems.push(`${appName}: install_type 必须是字符串`);
    if (typeof app.is_docker !== "boolean") problems.push(`${appName}: is_docker 必须是布尔值`);
    if ((app.preview_urls || []).length > 8) problems.push(`${appName}: preview_urls 最多 8 张`);
    const versions = Object.keys(app.releases || {});
    if (versions.length === 0) problems.push(`${appName}: releases 不能为空`);
    if (versions.length > 5) problems.push(`${appName}: releases 超过 5 个版本（仓库约定只保留最近 5 个）`);
    for (const version of versions) {
      const release = app.releases[version];
      const packages = release.packages || {};
      const archKeys = Object.keys(packages);
      if (archKeys.length === 0) problems.push(`${appName}@${version}: packages 不能为空`);
      for (const arch of archKeys) {
        if (!ARCH_KEYS.includes(arch)) problems.push(`${appName}@${version}: 架构键非法 ${arch}`);
        const branch = packages[arch];
        if (!branch.download_url) problems.push(`${appName}@${version}/${arch}: download_url 必填`);
        if (branch.sha256 && !/^[0-9a-f]{64}$/.test(branch.sha256)) {
          problems.push(`${appName}@${version}/${arch}: sha256 必须是 64 位小写十六进制`);
        }
        if (branch.size !== undefined && (!Number.isInteger(branch.size) || branch.size <= 0)) {
          problems.push(`${appName}@${version}/${arch}: size 必须是正整数（Bytes）`);
        }
      }
    }
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.input || "deploy/fnos/repository/fnpack.json");
  const repo = args.repo || "frankluise5220/MMH";
  const dropVersions = String(args.drop || "").split(",").map((v) => v.trim()).filter(Boolean);

  const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const repositoryDir = path.dirname(inputPath);
  const previews = readPreviews(repositoryDir);
  const appName = args.app || Object.keys(source.apps)[0];
  const app = source.apps[appName];
  if (!app) throw new Error(`源文件中找不到应用 ${appName}`);

  if (previews.length > 0) {
    app.preview_urls = previews.slice(0, 8);
    console.log(`[info] preview_urls <- ${previews.length} 张截图`);
  }

  // 未发布版本不进源：release 条目由发布流程（release: published → 本脚本）创建。
  // 只有显式给出 --version / VERSION 时才建条目，否则退化为「只刷新已有条目」。
  const targetVersion = String(args.version || process.env.VERSION || "").trim();
  if (!args.check && targetVersion) {
    // 图标缓存串跟着发布走（原来在 bump 脚本里做，随 release 条目一起挪过来）。
    if (typeof app.icon_url === "string") {
      app.icon_url = app.icon_url.replace(/([?&]v=)[^&]+/, `$1${targetVersion}`);
    }
    const pkg = readPackageJson();
    const pkgVersion = String(pkg.version || "").trim();
    // changelog 只能来自「同一个版本」的 package.json。版本对不上时宁可留空
    // （空 changelog 会在 check:release-version 里明显失败），也不要写入
    // 别的版本的说明——那正是 cd5bab17 那类静默张冠李戴错误的成因。
    const manifestChangelog = targetVersion === pkgVersion ? String(pkg.mmhFnosManifestChangelog || "").trim() : "";
    if (targetVersion !== pkgVersion) {
      console.warn(
        `[warn] --version ${targetVersion} 与 package.json 的 ${pkgVersion || "(空)"} 不一致，changelog 留空；请确认要同步的是哪个版本。`,
      );
    }
    const existing = app.releases[targetVersion];
    if (!existing) {
      app.releases[targetVersion] = {
        changelog: manifestChangelog,
        os_min_version: "0.9.0",
        packages: fnosPackages(repo, targetVersion),
      };
      console.log(`[info] 新建 release 条目 v${targetVersion}（由发布流程创建）`);
    } else if (manifestChangelog && existing.changelog !== manifestChangelog) {
      existing.changelog = manifestChangelog;
      console.log(`[info] v${targetVersion} changelog <- package.json mmhFnosManifestChangelog`);
    }
  }

  const dropped = [];
  for (const version of dropVersions) {
    if (app.releases[version]) {
      delete app.releases[version];
      dropped.push(version);
    }
  }
  if (dropped.length) console.log(`[info] 按 --drop 剔除版本：${dropped.join(", ")}`);

  const deadVersions = [];
  for (const version of Object.keys(app.releases)) {
    const release = await fetchRelease(repo, version);
    if (!release) {
      deadVersions.push(version);
      console.warn(`[warn] v${version} 在 GitHub 上没有 Release（该版本所有下载地址均为死链）`);
      continue;
    }
    release.published_at = release.published_at || release.created_at;
    const iso = toShanghaiIso(release.published_at);
    if (iso) app.releases[version].updated_at = iso;
    for (const [arch, suffix] of Object.entries(ASSET_SUFFIX)) {
      const assetName = `mmh-fnos-v${version}-${suffix}.fpk`;
      const asset = (release.assets || []).find((item) => item.name === assetName);
      if (!asset) {
        console.warn(`[warn] v${version} 缺少资产 ${assetName}`);
        continue;
      }
      if (!app.releases[version].packages?.[arch]) continue;
      app.releases[version].packages[arch].size = asset.size;
      const digest = String(asset.digest || "");
      if (digest.startsWith("sha256:")) {
        app.releases[version].packages[arch].sha256 = digest.slice("sha256:".length);
      } else {
        console.warn(`[warn] v${version}/${arch} 未返回 digest，请本地 sha256sum 核对`);
      }
    }
  }

  // 发布流程必须产出完整条目：条目建好后仍拿不到 sha256/size，说明 Release 没发布
  // 或资产缺失——宁可失败，也不要把半成品（= FnDepot 里的死链）写进源文件。
  if (!args.check && targetVersion) {
    const target = app.releases[targetVersion];
    if (!target) {
      console.error(`[FAIL] 未能为 v${targetVersion} 建立 release 条目。`);
      process.exit(1);
    }
    for (const arch of ["x86", "arm"]) {
      const branch = target.packages?.[arch];
      if (!branch || !branch.sha256 || !branch.size) {
        console.error(`[FAIL] v${targetVersion}/${arch} 未取得 sha256/size：Release 未发布或资产缺失，拒绝写出源文件。`);
        process.exit(1);
      }
    }
  }

  const ordered = Object.keys(app.releases).sort(compareVersions);
  if (ordered.length > KEEP_RELEASE_COUNT) {
    console.log(
      `[info] releases 只保留最近 ${KEEP_RELEASE_COUNT} 个，剔除：${ordered.slice(0, -KEEP_RELEASE_COUNT).join(", ")}`,
    );
  }
  const sorted = {};
  for (const version of ordered.slice(-KEEP_RELEASE_COUNT)) {
    sorted[version] = app.releases[version];
  }
  app.releases = sorted;

  const problems = validate(source);
  if (deadVersions.length) {
    console.warn(`[warn] 死链版本：${deadVersions.join(", ")}（建议用 --drop 剔除）`);
  }
  if (problems.length) {
    console.error("[FAIL] 源文件不符合 FnDepot V2 规范：");
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log("[OK] FnDepot V2 规范校验通过");
  }

  if (args.check) {
    if (problems.length || deadVersions.length) process.exit(1);
    return;
  }

  const outputPath = path.resolve(args.output || inputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  console.log(`[done] 已写入 ${outputPath}`);
  console.log(`[done] 版本：${Object.keys(sorted).join(", ")}`);
  if (problems.length) process.exit(1);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});
