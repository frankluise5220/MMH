#!/usr/bin/env node
/**
 * 分发渠道巡检：一条命令确认某个版本是否已真正抵达全部渠道。
 *
 * 为什么必须有它：`release: published` 只完成 GitHub Release 这一个面。其余渠道各自
 * 独立、各自静默失败，谁都不会向上报错——
 *   - FN 软仓：fnVPS `sync.sh` 每小时跑一次，没跑到就看不到新版本；
 *   - FnDepot：两跳（本仓库 fnpack.json 回填 → FnDepot 镜像），GitHub 对镜像的
 *     scheduled cron 节流到 4–6 小时，平台再每天 00:00（UTC+8）读一次仓库；
 *   - 群晖套件源：只认 fnVPS `data/downloads/` 里的 SPK 文件名，与 Release 无关；
 *   - Docker/GHCR：`latest` 只能由 tag 构建写入，被 main 构建顶掉就会让 updater 装错。
 * draft 流程一旦中断或延期，上面任何一个面都可能被漏掉，而且不会有任何红叉。
 * 所以发布流程（含 draft 中断后恢复）结束前必须跑本脚本，全绿才算这个版本发布完成。
 *
 * 用法：
 *   node scripts/check-channels.cjs [--version 0.1.76] [--repo owner/repo]
 *
 * 退出码：0 = 自动校验全部通过；1 = 有渠道未同步（逐条列出原因）；2 = 用法错误
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_REPO = "frankluise5220/MMH";
const FNDEPOT_REPO = "frankluise5220/FnDepot";
const TIMEOUT_MS = 20000;
const FN_SOFTSTORE_API = "http://fnapp.floatingice.win/api/apps";
const SYNOLOGY_PROTOCOL =
  "https://synology.floatingice.win/?arch=x86_64&build=64570&language=chs";

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

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
}

function vpsX86Url(version) {
  return `http://fnapp.floatingice.win/apps/mmh-${version}.fpk`;
}

function expectedReleaseAssets(version) {
  return [
    `mmh-fnos-v${version}-x86_64.fpk`,
    `mmh-fnos-v${version}-arm64.fpk`,
    `mmh-synology-v${version}-x86_64.spk`,
    `mmh-synology-v${version}-arm64.spk`,
    `mmh-nas-v${version}.zip`,
  ];
}

async function request(url, init = {}, attempt = 1) {
  try {
    return await fetch(url, {
      ...init,
      headers: { "user-agent": "mmh-check-channels", ...(init.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (attempt >= 3) throw new Error(`请求失败（${error.message}）`);
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    return request(url, init, attempt + 1);
  }
}

async function getJson(url, headers) {
  const response = await request(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function stripDigest(digest) {
  return String(digest || "").replace(/^sha256:/, "");
}

// 每个校验返回一句给人看的细节；失败抛 Error，由主流程统一渲染。
function createChecks({ version, repo }) {
  const state = { assets: new Map() };

  return [
    {
      label: "GitHub Release",
      async run() {
        const release = await getJson(
          `https://api.github.com/repos/${repo}/releases/tags/v${version}`,
        );
        if (release.draft) throw new Error("Release 仍是 draft，未公开");
        for (const asset of release.assets || []) state.assets.set(asset.name, asset);
        const missing = expectedReleaseAssets(version).filter((name) => !state.assets.has(name));
        if (missing.length) throw new Error(`缺少资产：${missing.join("、")}`);
        const extras = [...state.assets.keys()].filter((name) => !name.includes(`v${version}`));
        return `${expectedReleaseAssets(version).length} 个资产齐全${
          extras.length ? `（另有：${extras.join("、")}）` : ""
        }`;
      },
    },
    {
      label: "GHCR latest",
      async run() {
        const headers = {
          accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
        };
        // GHCR 的包路径就是 owner/repo（镜像名与仓库同名，不要再拼一次 mmh）
        const packagePath = repo.toLowerCase();
        const { token } = await getJson(
          `https://ghcr.io/token?service=ghcr.io&scope=repository:${packagePath}:pull`,
        );
        const digestOf = async (tag) => {
          const response = await request(
            `https://ghcr.io/v2/${packagePath}/manifests/${tag}`,
            { headers: { ...headers, authorization: `Bearer ${token}` } },
          );
          if (!response.ok) throw new Error(`manifests/${tag} 返回 HTTP ${response.status}`);
          return response.headers.get("docker-content-digest");
        };
        const latest = await digestOf("latest");
        const tagged = await digestOf(version);
        if (!tagged) throw new Error(`${version} 标签缺少 digest`);
        if (latest !== tagged) {
          throw new Error(`latest=${latest} 与 ${version}=${tagged} 不一致（main 构建抢了 latest？）`);
        }
        return `latest 与 ${version} 同 digest（${tagged.slice(0, 19)}…）`;
      },
    },
    {
      label: "MMH fnpack.json",
      async run() {
        const source = await getJson(
          `https://raw.githubusercontent.com/${repo}/main/deploy/fnos/repository/fnpack.json`,
        );
        const entry = source?.apps?.mmh?.releases?.[version];
        if (!entry) {
          throw new Error(
            "源里没有该版本条目（release: published 的 Sync FnDepot source 未完成？）",
          );
        }
        const problems = [];
        for (const [arch, assetName] of [
          ["x86", `mmh-fnos-v${version}-x86_64.fpk`],
          ["arm", `mmh-fnos-v${version}-arm64.fpk`],
        ]) {
          const pkg = entry.packages?.[arch] || {};
          const asset = state.assets.get(assetName);
          if (!pkg.sha256 || !pkg.size) {
            problems.push(`${arch} 缺 sha256/size（回填未完成）`);
            continue;
          }
          if (!asset) {
            problems.push(`${arch} 无对应 Release 资产可比对`);
            continue;
          }
          if (Number(pkg.size) !== Number(asset.size)) {
            problems.push(`${arch} size 不符（源 ${pkg.size} / Release ${asset.size}）`);
          }
          const digest = stripDigest(asset.digest);
          if (digest && stripDigest(pkg.sha256) !== digest) {
            problems.push(`${arch} sha256 与 Release 资产不符`);
          }
        }
        if (problems.length) throw new Error(problems.join("；"));
        return `${version} 已回填，x86/arm 的 size 与 sha256 均与 Release 资产一致`;
      },
    },
    {
      label: "FnDepot 镜像",
      async run() {
        const mirror = await getJson(
          `https://raw.githubusercontent.com/${FNDEPOT_REPO}/main/fnpack.json`,
        );
        const releases = mirror?.apps?.mmh?.releases || {};
        if (!releases[version]) {
          throw new Error(
            `镜像仍停在 ${Object.keys(releases).join("、") || "空"}；`
              + "手动 dispatch FnDepot 的 sync-from-mmh.yml，不要等 cron",
          );
        }
        return `镜像 releases 已含 ${version}`;
      },
    },
    {
      label: "FN 软仓",
      async run() {
        const payload = await getJson(FN_SOFTSTORE_API);
        const apps = Array.isArray(payload?.data) ? payload.data : [];
        const app = apps.find((item) => item.id === "mmh");
        if (!app) throw new Error("/api/apps 里没有 mmh 条目");
        if (String(app.version) !== version) {
          throw new Error(`源里仍是 ${app.version}（fnVPS sync.sh 未跑到该版本）`);
        }
        const desc = String(app.desc || "");
        if (!desc.startsWith("【本版更新】")) throw new Error("desc 缺少【本版更新】段");
        if (desc.includes("\n")) throw new Error("desc 含真实换行，会把「更新内容」面板顶出来");
        return `${version}，desc 为单行【本版更新】`;
      },
    },
    {
      label: "群晖套件源",
      async run() {
        const payload = await getJson(SYNOLOGY_PROTOCOL);
        const pkg = (payload?.packages || [])[0];
        if (!pkg) throw new Error("源返回空 packages（fnVPS data/downloads/ 缺 SPK？）");
        if (String(pkg.version) !== version) {
          throw new Error(`源里仍是 ${pkg.version}`);
        }
        const changelog = String(pkg.changelog || "");
        if (!changelog) throw new Error("changelog 为空，「新增功能」面板会是空白");
        if (changelog === `MMH ${version}`) {
          throw new Error("changelog 仍是占位符 MMH <version>，「新增功能」面板会是空白");
        }
        return `${version}，changelog 为真实文案`;
      },
    },
    {
      label: "软仓 x86 镜像包",
      async run() {
        const response = await request(vpsX86Url(version), { method: "HEAD" });
        if (!response.ok) throw new Error(`mmh-${version}.fpk 返回 HTTP ${response.status}`);
        const size = Number(response.headers.get("content-length"));
        const asset = state.assets.get(`mmh-fnos-v${version}-x86_64.fpk`);
        if (asset && size !== Number(asset.size)) {
          throw new Error(`镜像包 ${size} 字节与 Release 资产 ${asset.size} 不符`);
        }
        return `200，${size} 字节，与 Release x86 一致`;
      },
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  const pkg = readPackageJson();
  const version = String(args.version || pkg.version || "").trim();
  const repo = String(args.repo || DEFAULT_REPO);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`用法：node scripts/check-channels.cjs [--version 0.1.x] [--repo owner/repo]`);
    console.error(`版本号不合法：${version || "(空)"}`);
    process.exit(2);
  }

  console.log(`MMH 分发渠道巡检  version=${version}  repo=${repo}\n`);

  const checks = createChecks({ version, repo });
  const failures = [];
  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  [PASS] ${check.label.padEnd(16, " ")} ${detail}`);
    } catch (error) {
      failures.push({ label: check.label, reason: error.message });
      console.log(`  [FAIL] ${check.label.padEnd(16, " ")} ${error.message}`);
    }
  }

  const notes = pkg.mmhReleaseNotesI18n || {};
  const inApp = String(notes["zh-CN"] || "");
  if (!inApp.includes("功能改进") || !inApp.includes("Bug 修复")) {
    failures.push({ label: "应用内说明", reason: "package.json mmhReleaseNotesI18n 缺少功能改进/Bug 修复" });
    console.log(`  [FAIL] ${"应用内说明".padEnd(16, " ")} package.json 的更新说明缺功能改进/Bug 修复`);
  } else {
    console.log(`  [PASS] ${"应用内说明".padEnd(16, " ")} mmhReleaseNotesI18n（zh-CN）已就位`);
  }

  console.log(`  [INFO] ${"fnOS 官方应用中心".padEnd(14, " ")} 上架与新版本说明只能人工在应用中心确认`);

  console.log("");
  if (failures.length) {
    console.log(`汇总：${failures.length} 个渠道未同步 —— 这个版本还不能算发布完成。`);
    for (const item of failures) console.log(`  - ${item.label}：${item.reason}`);
    console.log("");
    console.log("::CHECK_CHANNELS status=failed");
    process.exit(1);
  }

  console.log(`汇总：${checks.length + 1} 项自动校验全部通过；fnOS 官方应用中心需人工确认。`);
  console.log("");
  console.log("::CHECK_CHANNELS status=success");
}

main().catch((error) => {
  console.error(`巡检本身出错：${error.message}`);
  process.exit(1);
});
