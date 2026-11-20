#!/usr/bin/env node
/**
 * 从 git tag 抽出历史版本的更新说明，生成 `src/lib/release-notes-history.ts`。
 *
 * 为什么内置而不是发布时请求 GitHub：NAS / 内网用户经常拿不到 GitHub API
 * （限流 60 次/小时、国内直连不稳），而「历史更新」只是只读文案，没必要联网。
 * 每个 tag 的 `package.json.mmhReleaseNotesI18n` 就是应用内「本版说明」的来源，
 * 抽出来的内容与发布说明天然一致。
 *
 * 用法：node scripts/gen-release-history.cjs [数量，默认 20]
 * 发布新版本后重跑一次，把新版本补进列表。
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LIMIT = Number(process.argv[2] || 20);
const OUTPUT = path.join(__dirname, "..", "src", "lib", "release-notes-history.ts");

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }).trim();
}

const tags = git(["tag", "--list", "v0.1.*", "--sort=-v:refname"])
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(0, LIMIT);

// 当前版本用工作区的 package.json:发版前「先改说明、后移 tag」是正常顺序,
// 此时 tag 上的说明还是上一批内容。其余历史版本仍以 tag 为准。
const workingPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

// 历史说明直接渲染进「系统设置 → 系统更新 → 历史更新」，属于用户可见的公开文案。
// 旧版本的说明里把真实家庭成员姓名/网名当例子写了进去，生成时统一换成示例名，
// 这样既不用改写历史 tag，又能保证重跑后不会把姓名带回来。
const PERSON_NAME_REDACTIONS = [
  ["付斌", "张三"],
  ["墨斗鱼", "李四"],
  ["Fu Bin", "Zhang San"],
];

function redactPersonNames(text) {
  let output = String(text || "");
  for (const [from, to] of PERSON_NAME_REDACTIONS) output = output.split(from).join(to);
  return output;
}

const entries = [];
for (const tag of tags) {
  let pkg;
  try {
    pkg = JSON.parse(git(["show", `${tag}:package.json`]));
  } catch {
    continue;
  }
  const tagVersion = String(pkg.version || tag.replace(/^v/, ""));
  const source = tagVersion === String(workingPkg.version || "") ? workingPkg : pkg;
  const notes = source.mmhReleaseNotesI18n || {};
  // 语言键统一成界面语言码（zh-CN / en-US / ja-JP），与 API 的 RELEASE_NOTES_LANGUAGES 一致；
  // package.json 里历史上可能写 "en"，一并接受。
  const zh = redactPersonNames(notes["zh-CN"] || "").trim();
  const en = redactPersonNames(notes["en-US"] || notes["en"] || "").trim();
  if (!zh && !en) continue;
  let date = "";
  try {
    date = git(["log", "-1", "--format=%cs", tag]);
  } catch {
    date = "";
  }
  const entry = { version: String(pkg.version || tag.replace(/^v/, "")), date, notes: {} };
  if (zh) entry.notes["zh-CN"] = zh;
  if (en) entry.notes["en-US"] = en;
  entries.push(entry);
}

const body = entries.map((entry) => `  ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n  ")},`).join("\n");

const file = `// 本文件由 scripts/gen-release-history.cjs 生成，请勿手改。
// 数据源：各 git tag 的 package.json.mmhReleaseNotesI18n（与应用内「本版说明」同源）。
// 发布新版本后重跑：node scripts/gen-release-history.cjs
export type ReleaseHistoryEntry = {
  version: string;
  /** tag 提交日期，YYYY-MM-DD */
  date: string;
  notes: { "zh-CN"?: string; "en-US"?: string };
};

export const RELEASE_HISTORY: ReleaseHistoryEntry[] = [
${body}
];

export function releaseHistoryFor(version: string | undefined) {
  const target = String(version || "").trim();
  if (!target || target === "unknown") return null;
  return RELEASE_HISTORY.find((entry) => entry.version === target) ?? null;
}
`;

fs.writeFileSync(OUTPUT, file, "utf8");
console.log(`wrote ${entries.length} entries -> ${path.relative(process.cwd(), OUTPUT)}`);
