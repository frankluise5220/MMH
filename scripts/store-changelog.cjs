#!/usr/bin/env node
"use strict";

/**
 * 「商店更新说明」的单一派生源（2026-10-16 用户决定）。
 *
 * ── 为什么存在（2026-10-16 用户报障「软仓的更新说明也没换行」）────────────────
 * 两个商店渠道的更新说明此前都只有「一整行」（FN 软仓 desc 的【本版更新】段、
 * FnDepot `releases[v].changelog`），用户在详情页看到的是一段挤在一起的长文。
 * 修之前必须先按代码确认各自渲染器，否则一改就错：
 *
 *  · FN 软仓（已查证源码 `hhxs2025/fn-appstores-client`
 *    `src/app/server/static/js/apps.js`）：
 *      - `:391` `descEl.innerHTML = app.desc`  → `desc` 按 **HTML** 渲染，`<br>` 生效；
 *      - `:377-386` 把 `desc` **去掉 HTML 标签**后按 **真实 `\n`** 拆行，`lines.length >= 2`
 *        就渲染「更新内容」面板（与「应用介绍」重复显示同一份文案）、否则 `display:none`。
 *      => 软仓 `desc` 只能用 `<br>` 换行，绝不能出现真实 `\n`。这是硬约束，不是风格选择。
 *
 *  · FnDepot `releases[v].changelog`：渲染器无法从公开代码查证（`EWEDLCM/FnDepot`
 *    只是**源仓库**，商店本体是 Go 后端，前端不在公开仓库里）=> 取最保守的**真实 `\n`**：
 *    渲染器若忽略换行，只会退回今天的一整行（无损失）；若用 `<br>` 而渲染器不解析 HTML，
 *    用户会看到字面量 `<br>`（有损失）。二者取其一，只能选前者。
 *
 * ── 内容来源（`mmh-release/references/update-notes-surfaces.md` §1 内容来源规则）────
 * 所有渠道的更新说明只有**一个**来源：本版相对上一版的 `功能改进` + `Bug 修复`，
 * 即 `package.json.mmhReleaseNotesI18n["zh-CN"]` —— 应用内「本版说明」的正典，
 * 也是 `check-release-version.cjs` 已经断言过「不含安装 / 手机端 / 打包与部署」的那份。
 * 各渠道只做**形态适配**（软仓 `<br>` 逐条一行 / FnDepot `\n` 逐条一行），不做内容增减。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node scripts/store-changelog.cjs --print html    # 软仓【本版更新】段（一条 `\n` 也没有）
 *   node scripts/store-changelog.cjs --print plain   # FnDepot changelog（`\n` 分隔）
 *   node scripts/store-changelog.cjs --write         # 把各软仓 desc 的【本版更新】段重写为派生结果
 *   node scripts/store-changelog.cjs --check         # 只校验（CI 用），不一致则退出码 1
 */

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const UPDATE_PREFIX = "【本版更新】";
const INTRO_MARKER = "【软件简介】";
const HTML_SEPARATOR = "<br>";
// 软仓 desc 的硬约束：任何位置都不许出现真实换行（见文件头 apps.js:377-386）。
const FORBIDDEN_IN_SOFTSTORE = /\r|\n/;

const GROUP_HEADING = /^###\s+(.+?)\s*$/;
const SECTION_HEADING = /^##\s+/;
const BULLET = /^[-*]\s+(.+?)\s*$/;

const SOFTSTORE_TARGETS = [
  {
    file: "deploy/fnos/repository/apps.example.json",
    field: "description",
    getApps: (payload) => payload.apps ?? [],
  },
  {
    file: "deploy/fnos/repository/api/apps",
    field: "desc",
    getApps: (payload) => payload.data ?? [],
  },
  {
    file: "fn-appstores.json",
    field: "desc",
    getApps: (payload) =>
      (Array.isArray(payload) ? payload : []).filter((app) => app.id === "mmh").map((app) => app._manual),
  },
  {
    file: "deploy/fnos/selfhosted-source/data/fn-appstores.json",
    field: "desc",
    getApps: (payload) =>
      (Array.isArray(payload) ? payload : []).filter((app) => app.id === "mmh").map((app) => app._manual),
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPackageJson() {
  return readJson(path.join(REPO_ROOT, "package.json"));
}

/**
 * 把 `mmhReleaseNotesI18n["zh-CN"]` 解析成 [{ title, items[] }]。
 * 只认 `### 分组标题` 下的 `- 条目`；`## 本次更新` 这类二级标题被跳过。
 */
function releaseNoteGroups(markdown) {
  const groups = [];
  let current = null;
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const group = GROUP_HEADING.exec(line);
    if (group) {
      current = { title: group[1], items: [] };
      groups.push(current);
      continue;
    }
    if (SECTION_HEADING.test(line)) {
      current = null;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && current) current.items.push(bullet[1]);
  }
  return groups.filter((group) => group.items.length > 0);
}

/** 派生商店更新说明的行（分组标题一行 + 每条一行 + 版本引用一行）。 */
function storeChangelogLines(version, { bullet }) {
  const pkg = readPackageJson();
  const groups = releaseNoteGroups(pkg.mmhReleaseNotesI18n?.["zh-CN"]);
  const lines = [];
  for (const group of groups) {
    lines.push(`【${group.title}】`);
    for (const item of group.items) lines.push(`${bullet} ${item}`);
  }
  lines.push(`完整说明见 GitHub Release v${version}`);
  return lines;
}

/** 软仓 desc 的【本版更新】段：`<br>` 分隔，**不含任何真实换行**。 */
function softstoreUpdateBlock(version) {
  const lines = storeChangelogLines(version, { bullet: "•" });
  return `${UPDATE_PREFIX}${HTML_SEPARATOR}${lines.join(HTML_SEPARATOR)}`;
}

/** FnDepot `releases[v].changelog`：真实换行分隔。 */
function fndepotChangelog(version) {
  return storeChangelogLines(version, { bullet: "-" }).join("\n");
}

/** 把现有 desc 的简介段原样接回派生的【本版更新】段。 */
function rewriteDesc(desc, version) {
  const text = String(desc || "");
  const index = text.indexOf(INTRO_MARKER);
  if (index < 0) return null; // 没有简介段：不敢猜，交给人工
  const intro = text.slice(index);
  const next = `${softstoreUpdateBlock(version)}${HTML_SEPARATOR}${HTML_SEPARATOR}${intro}`;
  if (next.includes("\r") || next.includes("\n")) return null;
  return next;
}

function writeJson(file, payload) {
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const version = String(readPackageJson().version || "").trim();
  const mode = args.includes("--write") ? "write" : args.includes("--check") ? "check" : "print";

  if (mode === "print") {
    const which = args.find((arg) => arg === "html" || arg === "plain") || "html";
    const text = which === "html" ? softstoreUpdateBlock(version) : fndepotChangelog(version);
    process.stdout.write(`${text}\n`);
    return;
  }

  const stale = [];
  const skipped = [];
  for (const target of SOFTSTORE_TARGETS) {
    const fullPath = path.join(REPO_ROOT, target.file);
    if (!fs.existsSync(fullPath)) {
      skipped.push(`${target.file}（文件不存在）`);
      continue;
    }
    const payload = readJson(fullPath);
    const apps = target.getApps(payload).filter((app) => app && typeof app[target.field] === "string");
    if (apps.length === 0) {
      skipped.push(`${target.file}（找不到 mmh 的 ${target.field}）`);
      continue;
    }
    for (const app of apps) {
      const next = rewriteDesc(app[target.field], version);
      if (!next) {
        skipped.push(`${target.file}（desc 里没有「${INTRO_MARKER}」，结构未知）`);
        continue;
      }
      if (next === app[target.field]) continue;
      if (FORBIDDEN_IN_SOFTSTORE.test(next)) {
        stale.push(`${target.file}（派生结果含真实换行，软仓 desc 不允许）`);
        continue;
      }
      stale.push(`${target.file} [${app.platform || "?"}]`);
      if (mode === "write") app[target.field] = next;
    }
    if (mode === "write") writeJson(fullPath, payload);
  }

  for (const entry of skipped) console.warn(`[skip] ${entry}`);

  if (mode === "check") {
    if (stale.length) {
      console.error("[FAIL] 以下软仓 desc 的【本版更新】段不是派生的逐条一行形式：");
      for (const entry of stale) console.error(`  - ${entry}`);
      console.error("  修法：npm run sync:store-desc");
      process.exit(1);
    }
    console.log(`[OK] ${SOFTSTORE_TARGETS.length} 处软仓 desc 的【本版更新】段与 package.json 一致（v${version}）。`);
    return;
  }

  if (stale.length) {
    console.log(`[done] 已重写 ${stale.length} 处：`);
    for (const entry of stale) console.log(`  - ${entry}`);
  } else {
    console.log("[done] 全部已是最新，无需改动。");
  }
  const fndepot = path.join(REPO_ROOT, "deploy/fnos/repository/fnpack.json");
  if (fs.existsSync(fndepot)) {
    console.log(`[info] FnDepot changelog 由 scripts/sync-fndepot-source.cjs 在 release: published 时写入（本脚本不动它）。`);
  }
}

/** package.json 是否带可派生的多行正典（mmhReleaseNotesI18n["zh-CN"]）。 */
function hasDerivedNotes() {
  return releaseNoteGroups(readPackageJson().mmhReleaseNotesI18n?.["zh-CN"]).length > 0;
}

module.exports = {
  releaseNoteGroups,
  storeChangelogLines,
  softstoreUpdateBlock,
  fndepotChangelog,
  rewriteDesc,
  hasDerivedNotes,
  UPDATE_PREFIX,
  INTRO_MARKER,
  HTML_SEPARATOR,
};

if (require.main === module) main();
