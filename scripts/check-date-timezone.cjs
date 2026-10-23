#!/usr/bin/env node
/**
 * 时间口径守卫（见 AGENTS.md「Date & timezone contract」）。
 *
 * 契约：
 * 1. DB 里所有「日历日」字段一律以 **UTC 零点** 存储，读写只用
 *    `parseDateInputToUtc` / `formatDateUtc`（别名 `businessDateKey`）。
 * 2. 「今天/本月/本年」在服务端只用 `todayDateBusinessYmd()` /
 *    `businessTodayUtcStart()` / `businessDayStartUtc()`，禁止用进程本地时区或
 *    `toISOString()` 直接取日期。
 * 3. 前端表单默认日期只用 `todayDateLocalYmd()`。
 *
 * 这个脚本把上述规则变成可执行的失败项，防止「修一个漏十个」。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

/** 服务端文件：一律禁用进程本地/UTC 时刻推导业务日期 */
const SERVER_FORBIDDEN = [
  { re: /new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/g, hint: "用 todayDateBusinessYmd()" },
  { re: /new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\]/g, hint: "用 todayDateBusinessYmd()" },
  { re: /formatDateLocal\(new Date\(\)\)/g, hint: "用 todayDateBusinessYmd()" },
  { re: /localDateKey\(new Date\(\)\)/g, hint: "用 todayDateBusinessYmd()" },
  { re: /localDayKey\(new Date\(\)\)/g, hint: "用 todayDateBusinessYmd()" },
  { re: /localDayKey\(now\)/g, hint: "用 businessDayStartUtc(now) 的日期键" },
  { re: /startOfDayUtc\(new Date\(\)\)/g, hint: "用 businessTodayUtcStart()" },
  { re: /utcDayStart\(new Date\(\)\)/g, hint: "用 businessTodayUtcStart()" },
  { re: /formatDateLocal\(/g, hint: "DB 日历日必须用 formatDateUtc()；真实时刻用 formatDateInTimeZone()" },
  { re: /new Date\(\s*\d{4}\s*,\s*[^,)]+,\s*[^,)]+\s*[,)]/g, hint: "用 Date.UTC(...) 构造日历日；本地构造在容器 TZ=UTC 时偏移一天" },
];

/** 任何位置都禁用的写法 */
const GLOBAL_FORBIDDEN = [
  { re: /new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/g, hint: "「今天」不是 UTC 日期：前端 todayDateLocalYmd()，服务端 todayDateBusinessYmd()" },
];

/** 允许保留的例外（绝对路径 + 规则索引），必须写明原因 */
const ALLOW = new Map([
  // date-utils 内部实现「本地今天」是唯一合法来源
  [path.join(SRC, "lib", "date-utils.ts"), new Set([0, 1, 2, 3, 4, 5, 6, 7, 8])],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

function isServerFile(abs, source) {
  const rel = path.relative(SRC, abs).split(path.sep).join("/");
  if (rel.startsWith("lib/server/")) return true;
  if (rel.startsWith("app/api/")) return true;
  // 这些目录是「服务端语义的共享库」（被 route/RSC 调用），同样禁止进程本地时区。
  if (/^lib\/(insurance|fund|credit|ai|statement|deposit|bond)\//.test(rel)) return true;
  if (/(^|\/)route\.ts$/.test(rel)) return true;
  if (/(^|\/)page\.tsx$/.test(rel)) return !/^\s*["']use client["']/.test(source);
  if (/(^|\/)layout\.tsx$/.test(rel)) return !/^\s*["']use client["']/.test(source);
  return false;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scan(abs, source, rules) {
  const problems = [];
  const allowed = ALLOW.get(abs);
  rules.forEach((rule, ruleIndex) => {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(source))) {
      if (allowed && allowed.has(ruleIndex)) continue;
      problems.push({
        file: path.relative(ROOT, abs),
        line: lineOf(source, match.index),
        text: match[0],
        hint: rule.hint,
      });
    }
  });
  return problems;
}

const problems = [];
for (const abs of walk(SRC)) {
  const source = fs.readFileSync(abs, "utf8");
  problems.push(...scan(abs, source, GLOBAL_FORBIDDEN));
  if (isServerFile(abs, source)) problems.push(...scan(abs, source, SERVER_FORBIDDEN));
}

// 去重（GLOBAL 与 SERVER 规则可能命中同一处）
const seen = new Set();
const unique = problems.filter((p) => {
  const key = `${p.file}:${p.line}:${p.hint}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (!unique.length) {
  console.log("[check:timezone] ok — 时间口径没有发现违规写法。");
  process.exit(0);
}

console.error(`[check:timezone] 发现 ${unique.length} 处违反时间口径契约：\n`);
for (const p of unique) {
  console.error(`  ${p.file}:${p.line}  ${p.text}`);
  console.error(`      → ${p.hint}`);
}
console.error("\n规则见 AGENTS.md「Date & timezone contract」。");
process.exit(1);
