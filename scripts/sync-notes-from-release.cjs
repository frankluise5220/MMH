#!/usr/bin/env node
"use strict";

/**
 * 把「GitHub Release 正文」回灌成仓库里的三份正典文案（2026-10-23 用户规则）。
 *
 * ── 为什么存在 ───────────────────────────────────────────────────────────────
 * 用户在发版前会**直接在 draft 的正文里改写措辞、删掉不满意的条目**，draft 才是他
 * 认可的最终文本。但所有渠道的文案并不是从 Release 正文派生的：
 *
 *   mmhReleaseNotes        → GitHub Release 正文本身
 *   mmhReleaseNotesI18n    → 应用内「本版说明」正典，软仓 desc / FnDepot changelog /
 *                            群晖「新增功能」都从它派生（scripts/store-changelog.cjs）
 *   mmhFnosManifestChangelog → fnOS 应用中心「版本说明」原文（FPK manifest 的
 *                            `changelog=`），软仓源条目 changelog、群晖 changelog_short
 *
 * 三者都只写在 package.json 里。只在 draft 上改正文、不回灌，结果就是
 * **各渠道继续显示仓库里那份旧清单**（0.1.77 实际事故：用户在 draft 删掉了
 * 「合计大写金额 / 差旅分项小计 / 明细最多 6 行 / 系统更新页控制台输出」四条，
 * 而 FPK manifest 与软仓 desc、FnDepot changelog 仍在展示它们）。
 *
 * 所以本脚本是「draft 正文 → 仓库正典」的唯一入口，必须在 **publish 之前**跑完并提交，
 * 因为 FPK / SPK / 应用内说明都是在构建时从 package.json 注入的。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node scripts/sync-notes-from-release.cjs --version 0.1.78 --check     # 只比对，不一致退出 1
 *   node scripts/sync-notes-from-release.cjs --version 0.1.78 --write     # 回灌 mmhReleaseNotes + i18n.zh-CN
 *   node scripts/sync-notes-from-release.cjs --version 0.1.78 --write --auto-manifest
 *   node scripts/sync-notes-from-release.cjs --version 0.1.78 --write --manifest "单行压缩文本…"
 *   node scripts/sync-notes-from-release.cjs --version 0.1.78 --write --from-file docs/releases/v0.1.78.body.md
 *
 * 正文来源优先级：`--from-file` → GitHub Release（先按 tag 取，draft 回落到列表匹配）。
 * `--auto-manifest` 用正文条目机械压平成 `mmhFnosManifestChangelog`（超 600 字符时从尾部
 * 整条丢弃并打印丢掉的条目）；不给时只报告压平后的长度，需要人工用 `--manifest` 传入定稿。
 * CI 的渠道构建用 `--auto-manifest`，保证 FPK/SPK 里的版本说明与 Release 正文同源。
 */

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const API = "https://api.github.com";
const REPO = process.env.MMH_REPO || "frankluise5220/MMH";
const MCP = process.env.MMH_MCP_CONFIG || path.join(os.homedir(), ".codebuddy", "mcp.json");
const MANIFEST_MAX = 600;

const GROUP_HEADING = /^###\s+(.+?)\s*$/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.+?)\s*$/;
// 只有这两组进商店文案；`打包与部署` / `手机端使用建议` / `安装 / 更新说明` 任何渠道都不许出现。
const NOTE_GROUPS = ["功能改进", "Bug 修复"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : def;
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const mcp = readJson(MCP);
    const env = mcp?.mcpServers?.GitHub?.env ?? {};
    const found = env.GITHUB_PERSONAL_ACCESS_TOKEN || env.GITHUB_TOKEN;
    if (found) return found;
  } catch {
    /* 没有 mcp 配置就走匿名（公开仓库的已发布 release 可匿名读） */
  }
  return "";
}

function api(pathname) {
  const headers = { "user-agent": "mmh-sync-notes", accept: "application/vnd.github+json" };
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  return new Promise((resolve, reject) => {
    https
      .get({ hostname: "api.github.com", path: pathname, headers }, (res) => {
        let body = "";
        // 必须显式指定 utf8：默认 `body += chunk` 会在缓冲区边界把多字节汉字切成两半，
        // 每半个字节序列解码成 U+FFFD 并被 --write 原样写进 package.json。
        // 2026-10-24 在 v0.1.77 上实测到「裸账户名」被写成「裸��户名」，根因就是这里。
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(new Error(`invalid JSON from ${pathname}: ${error.message}`));
            }
            return;
          }
          reject(new Error(`HTTP ${res.statusCode} from ${pathname}`));
        });
      })
      .on("error", reject);
  });
}

/** 按 tag 取正文；draft 在 tags 端点上取不到，回落到列表匹配（draft 的 tag_name 是真实的）。 */
async function releaseBody(version) {
  try {
    const rel = await api(`/repos/${REPO}/releases/tags/v${version}`);
    return { body: String(rel.body || ""), source: `API release v${version} (draft=${rel.draft})` };
  } catch {
    const list = await api(`/repos/${REPO}/releases?per_page=100`);
    const hit = list.find((rel) => String(rel.tag_name) === `v${version}`);
    if (!hit) throw new Error(`找不到 v${version} 的 release（已发布和 draft 都没有）`);
    return { body: String(hit.body || ""), source: `API release list v${version} (draft=${hit.draft})` };
  }
}

/** 从 Release 正文取出 `## 本次更新` 里 `### 功能改进` / `### Bug 修复` 两组。 */
function parseNoteGroups(markdown) {
  const groups = new Map();
  let current = null;
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const section = SECTION_HEADING.exec(line);
    if (section) {
      // `## 本次更新` 之后才是清单；`## 手机端使用建议` / `## 安装 / 更新说明` 直接停。
      current = section[1].startsWith("本次更新") ? { title: null, items: [] } : null;
      continue;
    }
    if (!current) continue;
    const group = GROUP_HEADING.exec(line);
    if (group) {
      const title = group[1];
      current = { title, items: [] };
      if (NOTE_GROUPS.includes(title)) groups.set(title, current);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && current.title && NOTE_GROUPS.includes(current.title)) current.items.push(bullet[1]);
  }
  return groups;
}

function renderI18n(groups) {
  const blocks = [];
  for (const title of NOTE_GROUPS) {
    const items = groups.get(title)?.items ?? [];
    if (items.length === 0) continue;
    blocks.push([`### ${title}`, ...items.map((item) => `- ${item}`)].join("\n"));
  }
  return blocks.join("\n\n");
}

/** 完全一致的比对：`mmhReleaseNotes` 等于正文，i18n.zh-CN 等于正文抽出的两组。 */
function compare(pkg, body) {
  const groups = parseNoteGroups(body);
  const expectedI18n = renderI18n(groups);
  const problems = [];
  const bodyText = String(body || "").trim();
  const currentNotes = String(pkg.mmhReleaseNotes || "").trim();
  if (currentNotes !== bodyText) problems.push(`mmhReleaseNotes 与 Release 正文不一致（仓库 ${currentNotes.length} 字符 / 正文 ${bodyText.length} 字符）`);
  const currentI18n = String(pkg.mmhReleaseNotesI18n?.["zh-CN"] || "").trim();
  if (currentI18n !== expectedI18n.trim()) {
    const missing = expectedI18n
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- "))
      .filter((line) => !currentI18n.includes(line));
    const extra = currentI18n
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- "))
      .filter((line) => !expectedI18n.includes(line));
    problems.push(
      [
        `mmhReleaseNotesI18n["zh-CN"] 与 Release 正文的「功能改进 / Bug 修复」不一致`,
        missing.length ? `    正文有、仓库没有：${missing.map((line) => line.slice(2, 32)).join(" | ")}` : "",
        extra.length ? `    仓库有、正文已删：${extra.map((line) => line.slice(2, 32)).join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { problems, groups, expectedI18n };
}

function writePackageJson(pkg) {
  fs.writeFileSync(path.join(REPO_ROOT, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * 把正文条目压成 fnOS/群晖共用的单行版本说明（`mmhFnosManifestChangelog`）。
 * 超长时从尾部整条丢弃——半句切断的说明比少一条更糟；丢掉的条目会打印出来。
 */
function deriveManifest(groups, version) {
  const suffix = `完整说明见 GitHub Release v${version}`;
  const items = [...groups.values()].flatMap((group) => group.items);
  const kept = [];
  for (const item of items) {
    const body = kept.concat(item).join("；").replace(/。$/, "");
    if (`${body}。${suffix}`.length > MANIFEST_MAX) break;
    kept.push(item);
  }
  const body = kept.join("；").replace(/。$/, "");
  const text = body ? `${body}。${suffix}` : `v${version} 更新。${suffix}`;
  return { text, dropped: items.slice(kept.length) };
}

async function main() {
  const version = String(opt("version", readJson(path.join(REPO_ROOT, "package.json")).version || "")).replace(/^v/, "");
  if (!/^0\.1\.\d+$/.test(version)) {
    console.error("用法：node scripts/sync-notes-from-release.cjs --version <x.y.z> [--check|--write]");
    process.exit(2);
  }
  const mode = flag("write") ? "write" : "check";
  const pkgPath = path.join(REPO_ROOT, "package.json");
  const pkg = readJson(pkgPath);

  const fromFile = opt("from-file", "");
  const { body, source } = fromFile
    ? { body: fs.readFileSync(path.resolve(REPO_ROOT, fromFile), "utf8"), source: fromFile }
    : await releaseBody(version);

  const { problems, groups, expectedI18n } = compare(pkg, body);
  const flat = [...groups.values()].flatMap((group) => group.items).join("；");
  console.log(`正文来源：${source}`);
  console.log(`条目：功能改进 ${groups.get("功能改进")?.items.length ?? 0} 条 / Bug 修复 ${groups.get("Bug 修复")?.items.length ?? 0} 条`);

  if (mode === "check") {
    if (problems.length) {
      console.error("[FAIL] 各渠道文案的来源与 Release 正文不一致：");
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("  修法：node scripts/sync-notes-from-release.cjs --version <ver> --write，然后 sync:store-desc");
      process.exit(1);
    }
    console.log("[OK] mmhReleaseNotes 与 mmhReleaseNotesI18n.zh-CN 均等于 Release 正文。");
    return;
  }

  pkg.mmhReleaseNotes = String(body).trim();
  if (!pkg.mmhReleaseNotesI18n || typeof pkg.mmhReleaseNotesI18n !== "object") pkg.mmhReleaseNotesI18n = {};
  pkg.mmhReleaseNotesI18n["zh-CN"] = expectedI18n;

  const manifestFile = opt("manifest-file", "");
  if (manifestFile) {
    // 中文长串走命令行容易被 shell 引号破坏，定稿文本建议放文件再传。
    pkg.mmhFnosManifestChangelog = fs.readFileSync(path.resolve(REPO_ROOT, manifestFile), "utf8").trim();
    const text = pkg.mmhFnosManifestChangelog;
    if (text.length > MANIFEST_MAX) {
      console.error(`[FAIL] ${manifestFile} 超过 ${MANIFEST_MAX} 字符（${text.length}），请先压缩。`);
      process.exit(3);
    }
    if (!new RegExp(`完整说明见 GitHub Release v${version.replace(/\./g, "\\.")}$`).test(text)) {
      console.error(`[FAIL] ${manifestFile} 必须以「完整说明见 GitHub Release v${version}」结尾。`);
      process.exit(3);
    }
    console.log(`[done] mmhFnosManifestChangelog 已写入（${text.length} 字符，来自 ${manifestFile}）`);
  }

  const manifestArg = manifestFile ? "" : opt("manifest", "");
  if (manifestArg) {
    const text = String(manifestArg).trim();
    if (text.length > MANIFEST_MAX) {
      console.error(`[FAIL] --manifest 超过 ${MANIFEST_MAX} 字符（${text.length}），请先压缩。`);
      process.exit(3);
    }
    if (!new RegExp(`完整说明见 GitHub Release v${version.replace(/\./g, "\\.")}$`).test(text)) {
      console.error(`[FAIL] --manifest 必须以「完整说明见 GitHub Release v${version}」结尾。`);
      process.exit(3);
    }
    pkg.mmhFnosManifestChangelog = text;
    console.log(`[done] mmhFnosManifestChangelog 已写入（${text.length} 字符）`);
  }

  if (!manifestArg && !manifestFile && flag("auto-manifest")) {
    const { text, dropped } = deriveManifest(groups, version);
    if (text.length > MANIFEST_MAX) {
      console.error(`[FAIL] 自动压平的 mmhFnosManifestChangelog 仍超过 ${MANIFEST_MAX} 字符（${text.length}）。`);
      process.exit(3);
    }
    pkg.mmhFnosManifestChangelog = text;
    console.log(`[done] mmhFnosManifestChangelog 已按正文自动压平（${text.length} 字符）`);
    if (dropped.length) {
      console.log(`[warn] 因 ${MANIFEST_MAX} 字符上限丢弃 ${dropped.length} 条：${dropped.map((item) => item.slice(0, 24)).join(" | ")}`);
    }
  }

  writePackageJson(pkg);
  console.log("[done] 已回灌 package.json：mmhReleaseNotes、mmhReleaseNotesI18n.zh-CN");
  if (!manifestArg && !manifestFile && !flag("auto-manifest")) {
    // 单行短说明要压到 ≤600 且保住信息密度，机械压平往往超限，所以只报数、不代写。
    const auto = flat.length + `；完整说明见 GitHub Release v${version}`.length;
    console.log(
      [
        `[todo] mmhFnosManifestChangelog 需要人工定稿（当前 ${String(pkg.mmhFnosManifestChangelog || "").length} 字符）：`,
        `       新清单机械压平 + 结尾引用共 ${auto} 字符（上限 ${MANIFEST_MAX}），` +
          (auto > MANIFEST_MAX ? "已超限，必须人工压缩后重跑 --write --manifest-file …。" : "可直接写成文件用 --manifest-file 传入。"),
      ].join("\n"),
    );
  }
  const otherLangs = Object.keys(pkg.mmhReleaseNotesI18n).filter((key) => key !== "zh-CN");
  if (otherLangs.length) {
    console.log(`[warn] ${otherLangs.join(" / ")} 译文未自动更新：条目增删后必须人工复核，否则外文界面与中文清单对不上。`);
  }
  console.log("[next] npm run sync:store-desc   # 软仓 desc 的【本版更新】段按新 i18n 重写");
  if (problems.length) {
    console.log(`[info] 本次修正了 ${problems.length} 处不一致。`);
  }
}

// 只在作为 CLI 执行时跑 main；被 release-publish.cjs import 时只取 compare / parseNoteGroups，
// 发布闸门和回灌脚本共用同一份解析与比对，避免两边规则漂移。
if (require.main === module) {
  main().catch((error) => {
    console.error(`[error] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseNoteGroups, renderI18n, compare };
