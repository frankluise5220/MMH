#!/usr/bin/env node
"use strict";

/**
 * `npm run release:notes -- --version <x.y.z>` 的入口。
 *
 * ── 为什么需要这一层 ─────────────────────────────────────────────────────────
 * 这条命令要做两件事，顺序不能反：
 *   1. 按 Release 正文回灌 package.json（mmhReleaseNotes / i18n.zh-CN / 单行 manifest）
 *   2. 再由 package.json 重算 4 处软仓 desc 的【本版更新】段
 *
 * 不能直接写成 `"release:notes": "node a.cjs && node b.cjs"`：npm 会把
 * `npm run release:notes -- --version 0.1.77` 的参数追加到**整条** shell 命令末尾，
 * 变成 `node a.cjs && node b.cjs --version 0.1.77` —— 第一个脚本拿不到版本，
 * 补跑旧版本时会静默写成 package.json 当前版本。所以参数在这里透传给第一段。
 *
 * 省略 `--version` 时沿用 package.json 的版本（发版前的正常路径）。
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);

/**
 * 软仓源条目里的 `changelog` 字段是 `mmhFnosManifestChangelog` 的镜像
 * （`check-release-version` 会逐字比对）。这个字段平时由 `bump-release-version.cjs`
 * 在升版本时写入，而回灌发生在 bump 之后，所以这里补一次；否则回灌完
 * `npm run check:release-version` 立刻失败。
 */
function syncSoftstoreChangelog() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const manifest = String(pkg.mmhFnosManifestChangelog || "").trim();
  if (!manifest) return;

  const files = [
    { file: "deploy/fnos/repository/apps.example.json", list: (json) => json.apps },
    { file: "deploy/fnos/repository/api/apps", list: (json) => json.data },
    { file: "fn-appstores.json", list: (json) => (Array.isArray(json) ? json : []) },
  ];

  for (const { file, list } of files) {
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const json = JSON.parse(fs.readFileSync(abs, "utf8"));
    let changed = 0;
    for (const app of list(json) || []) {
      if (!app || typeof app !== "object") continue;
      const targets = [];
      if (app.id === "mmh") targets.push(app);
      if (app._manual && typeof app._manual === "object") targets.push(app._manual);
      for (const target of targets) {
        if (target.changelog !== manifest) {
          target.changelog = manifest;
          changed += 1;
        }
      }
    }
    if (changed > 0) {
      fs.writeFileSync(abs, `${JSON.stringify(json, null, 2)}\n`, "utf8");
      console.log(`[done] ${file} 的 changelog 已同步为 package.json 的单行说明`);
    }
  }
}

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[FAIL] 无法执行 ${script}：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// `--push-draft` 是本文件的参数，不能透传给下游（它会按 --version 的取值方式误读）。
const passthrough = argv.filter((a) => a !== "--push-draft");
run("sync-notes-from-release.cjs", ["--write", "--auto-manifest", ...passthrough]);
run("store-changelog.cjs", ["--write"]);
syncSoftstoreChangelog();

/**
 * `--push-draft`：把刚回灌好的正文直接写进对应的 GitHub Release。
 *
 * 正文的正典是 `package.json.mmhReleaseNotes`，但用户读到的是 Release 正文，
 * 两者原本靠人工复制对齐 —— 2026-11-03 的 v0.1.81 就栽在这里：`--check` 在
 * tag 定死之后才发现 draft 与仓库记录不一致，回灌后只能移 tag，四个包全部
 * 重建（12 分钟）。写完即推送，这一对内容就不可能再分叉。
 *
 * 用 `gh` 而不是手拼 API：发布流程里的资产校验、Windows 上传本来就用它，
 * `--notes-file -` 还能直接吃 stdin。令牌按 GH_TOKEN → GITHUB_TOKEN →
 * `~/.codebuddy/mcp.json` 的细粒度 PAT 取（与 release-publish.cjs 同源）。
 */
function pushDraft() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const at = argv.indexOf("--version");
  const version = String((at >= 0 ? argv[at + 1] : pkg.version) || "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`[FAIL] --push-draft 需要明确的版本号（拿到 "${version}"）`);
    process.exit(1);
  }
  const body = String(pkg.mmhReleaseNotes || "").trim();
  if (!body) {
    console.error("[FAIL] package.json 的 mmhReleaseNotes 是空的，先回灌正文");
    process.exit(1);
  }
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    const cfg = process.env.MMH_MCP_CONFIG || path.join(os.homedir(), ".codebuddy", "mcp.json");
    try {
      const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
      const env = ((json.mcpServers || {}).GitHub || {}).env || {};
      token = env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "";
    } catch { /* 没配置就退回 gh 自己的凭据 */ }
  }
  const result = spawnSync("gh", ["release", "edit", `v${version}`, "--notes-file", "-"], {
    cwd: REPO_ROOT,
    input: body,
    encoding: "utf8",
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  });
  if (result.error) {
    console.error(`[FAIL] 无法执行 gh：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[FAIL] gh release edit v${version} 失败（exit ${result.status}）`);
    if (result.stderr) console.error(result.stderr.trim());
    console.error("  常见原因：draft 还没建、令牌没有 admin 权限、gh 未认证。");
    process.exit(result.status || 1);
  }
  console.log(`[done] Release v${version} 正文已与 package.json 对齐`);
}

if (argv.includes("--push-draft")) pushDraft();
