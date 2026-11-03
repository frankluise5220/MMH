#!/usr/bin/env node
"use strict";

/**
 * 渠道同步并行器：`node scripts/sync-channels.cjs [--version x.y.z] [--dry]`
 *
 * 发布之后还剩两件互不依赖的事，过去是串行等：
 *   1. fnVPS `sync.sh` —— 把 Release 资产拉进自建源 / 群晖源 / 首页公告，SSH 上跑，几分钟；
 *   2. FnDepot 镜像    —— `gh workflow run sync-from-mmh.yml` 触发另一仓库的同步。
 * 谁先谁后都不影响结果，串行只是把两份等待叠在一起。这里并行发出，再统一用
 * `check-channels.cjs` 判定是否真的到位。
 *
 * 参数：
 *   --version <x.y.z>  传给 check-channels，确认的是「这个版本」而非 package.json 当前值
 *   --dry              只打印将要执行的命令
 *   --skip-vps         不跑 fnVPS（例如只补 FnDepot）
 *   --skip-fndepot     不触发 FnDepot 镜像
 *   --no-check         不跑 check:channels，只看两个同步动作的退出码
 *
 * 退出码：0 = 动作全部成功且巡检通过；1 = 有动作失败或渠道未到位；2 = 参数错误。
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
// 与 release-publish.cjs 同名同义：换机或换 SSH 别名时两处一起改。
const SSH_TARGET = process.env.MMH_TOKEN_SSH || "fnvps";
// SKILL.md「发布后分发」表里的每小时 cron 就是这一支。
const VPS_SYNC = "/opt/fn-appstores-server/sync.sh";
const FNDEPOT_REPO = "frankluise5220/FnDepot";
const FNDEPOT_WORKFLOW = "sync-from-mmh.yml";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const version = opt("version", "");
const dry = has("dry");

/** 与 release-publish.cjs 同序：环境变量 → ~/.codebuddy/mcp.json 的细粒度 PAT。 */
function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const cfg = process.env.MMH_MCP_CONFIG || path.join(os.homedir(), ".codebuddy", "mcp.json");
  try {
    const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
    const env = ((json.mcpServers || {}).GitHub || {}).env || {};
    return env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "";
  } catch {
    return "";
  }
}

function start(name, command, args, env) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    if (dry) {
      console.log(`[dry] ${name}: ${command} ${args.join(" ")}`);
      resolve({ name, ok: true, code: 0, ms: 0, out: "" });
      return;
    }
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { out += chunk.toString(); });
    child.on("error", (error) => {
      resolve({ name, ok: false, code: null, ms: Date.now() - startedAt, out: `${out}\n${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ name, ok: code === 0, code, ms: Date.now() - startedAt, out });
    });
  });
}

async function main() {
  const token = githubToken();
  const jobs = [];

  if (!has("skip-vps")) {
    // `sudo -n` 免密执行；失败会立即返回而不是挂在密码提示上。
    jobs.push(start("fnVPS sync.sh", "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", SSH_TARGET, `sudo -n bash ${VPS_SYNC}`], {}));
  }
  if (!has("skip-fndepot")) {
    if (!token && !dry) {
      console.error("[warn] 没找到 GitHub 令牌，FnDepot 分支可能被 gh 拒绝："
        + "设 GH_TOKEN，或配置 ~/.codebuddy/mcp.json 的 GITHUB_PERSONAL_ACCESS_TOKEN");
    }
    jobs.push(start("FnDepot 镜像", "gh",
      ["workflow", "run", FNDEPOT_WORKFLOW, "-R", FNDEPOT_REPO], token ? { GH_TOKEN: token } : {}));
  }
  if (!jobs.length) {
    console.error("没选中任何动作：--skip-vps 与 --skip-fndepot 不能同时给");
    process.exit(2);
  }

  console.log(`=== 并行触发 ${jobs.length} 个渠道同步 ===`);
  const results = await Promise.all(jobs);

  let failed = 0;
  for (const result of results) {
    console.log(`\n--- ${result.name}: ${result.ok ? "ok" : `FAILED (exit ${result.code})`} `
      + `${(result.ms / 1000).toFixed(1)}s`);
    if (result.out.trim()) console.log(result.out.trimEnd());
    if (!result.ok) failed += 1;
  }
  if (failed) {
    console.error(`\n${failed} 个同步动作失败，先修掉再确认渠道。`);
    process.exit(1);
  }
  if (dry || has("no-check")) return;

  console.log("\n=== check:channels ===");
  const args = [path.join(REPO_ROOT, "scripts", "check-channels.cjs")];
  if (version) args.push("--version", version);
  const check = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (check.status !== 0) {
    // 两跳本来就有延迟：镜像要跑 workflow，软仓与群晖源还要等 sync.sh 的派生步骤。
    console.error("\n同步已发出，但巡检未全绿 —— FnDepot 镜像与软仓回填都有分钟级延迟，"
      + "稍后重跑 `npm run check:channels` 复核。");
    process.exit(check.status || 1);
  }
}

main();
