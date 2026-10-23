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

run("sync-notes-from-release.cjs", ["--write", "--auto-manifest", ...argv]);
run("store-changelog.cjs", ["--write"]);
syncSoftstoreChangelog();
