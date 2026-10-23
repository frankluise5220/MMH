#!/usr/bin/env node
/**
 * 账户名称渲染守卫（见 AGENTS.md「Account label contract」）。
 *
 * 契约：界面上任何"账户名"都必须经过 `src/lib/account-display.ts` 的统一入口
 * （`accountTableCell` / `accountOptionRow` / `buildAccountDisplayOption` /
 * `formatAccountTableLabel` / `formatAccountTableTitle` / `resolveAccountTableLabel`
 * / `renderAccountLabel`），因为只有它同时做到：
 *   1. 按「系统设置 - 显示 - 账户显示格式」的字段与顺序渲染；
 *   2. 给出行内看不到的信息（所有人/类型/非本位币）作为 hover。
 *
 * 手工拼 `机构·名称`、裸渲染 `account.name`、或调用只吃两个字符串的
 * `formatAccountDisplayName` 都会让设置失效、hover 丢失，一律视为错误。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

const RULES = [
  {
    re: /formatAccountDisplayName\s*\(/g,
    hint: "改用 accountTableCell(...) 或 buildAccountDisplayOption(...)；只吃两个字符串的旧函数不读设置、不产 hover",
  },
  {
    re: /formatOwnerQualifiedAccountLabel\s*\(/g,
    hint: "改用 buildAccountDisplayOption(...).ownerQualifiedLabel / listLabel",
  },
  {
    re: /`\$\{[^`]*Institution\??\.(?:name|shortName)[^`]*\}·\$\{[^`]*\.name[^`]*\}`/g,
    hint: "禁止手拼「机构·名称」；用 accountTableCell(...).label，hover 用 .title",
  },
  {
    re: /^\s*(?:const|let)\s+\w*(?:account|Account)\w*Label\w*\s*=\s*[^;\n]*Institution[^;\n]*\?\.name[^;\n]*\?[^;\n]*:.*$/gm,
    hint: "禁止用三元自拼机构+名称；改用统一入口",
  },
];

/** 行级规则：整行同时命中多个特征才算违规，避免一个正则吃掉多行上下文 */
const LINE_RULES = [
  {
    test: (line) => /\.join\("·"\)|\.join\('·'\)/.test(line) && /institution/i.test(line),
    // 导出/去重需要「完整身份串」，与界面显示设置无关，属于显式豁免。
    // 导出/去重/身份键需要「完整身份串」，与界面显示设置无关，属于显式豁免。
    allow: (line) =>
      /exportAccountLabel|accountIdentityKey|identityKey|tailOrName|kindLabel\(account\.kind\)|\.split\("·"\)/i.test(line),
    hint: "禁止用 join(\"·\") 拼机构与名称；改用 accountTableCell(...).label / accountOptionRow(...).label",
  },
  {
    test: (line) => /title=\{[^}]*accountName[^}]*\}/.test(line) && !/HoverTitle/.test(line),
    hint: "hover 要用统一入口产出的 title（accountTableCell(...).title），裸 accountName 不含机构与币种",
  },
];

/** 唯一允许实现这些细节的文件 */
const ALLOW = new Set([path.join(SRC, "lib", "account-display.ts")]);

/**
 * 「`fields` 与 `baseCurrency` 必须成对传」的守卫。
 *
 * 只传 `fields` 时，非本位币账户的币种既不会出现在标签里，也不会出现在 hover 里
 * （`resolveAccountCurrencyText` 拿不到本位币就直接返回空串），用户看不出这笔钱
 * 记在哪个币种上。这类调用必须报错，不能靠人肉 review。
 */
const RENDER_CALL_NAMES = [
  "buildAccountDisplayOption(",
  "accountTableCell(",
  "accountOptionRow(",
  "accountOptionFromParts(",
  "formatAccountTableLabel(",
  "formatAccountTableTitle(",
];

function extractCall(source, startIndex, openParenIndex) {
  let depth = 1;
  let cursor = openParenIndex + 1;
  while (cursor < source.length && depth > 0) {
    const ch = source[cursor];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    cursor += 1;
  }
  return source.slice(startIndex, cursor);
}

function checkRenderSettingsCalls(source, abs) {
  const found = [];
  for (const name of RENDER_CALL_NAMES) {
    let index = 0;
    while ((index = source.indexOf(name, index)) >= 0) {
      const before = source.slice(Math.max(0, index - 40), index);
      // 跳过定义本身（`function foo(` / `export function foo(`）。
      if (/function\s+$/.test(before)) {
        index += name.length;
        continue;
      }
      const call = extractCall(source, index, index + name.length - 1);
      index += name.length;
      const hasFields = /\bfields\s*[:,}]/.test(call);
      const hasBaseCurrency = /\bbaseCurrency\b/.test(call);
      if (!hasFields || hasBaseCurrency) continue;
      found.push({
        file: path.relative(ROOT, abs),
        line: lineOf(source, index - name.length),
        text: call.replace(/\s+/g, " ").trim().slice(0, 90),
        hint: "只传了 fields 没传 baseCurrency：外币账户的币种会从标签和 hover 里彻底消失。传 { fields, baseCurrency }（服务端用 getHouseholdBaseCurrency，客户端用 readAccountDisplaySettings / useAccountDisplaySettings）",
      });
    }
  }
  return found;
}

/**
 * 迁移中：这些位置的数据源只有账户名快照，没有机构/币种，无法按设置渲染。
 * 只记录不失败，待数据层补 `accountLabel` / `accountHoverTitle` 后移除。
 */
const WARN_ONLY = new Set([
  path.join(SRC, "lib", "account-import-match.ts"),
  path.join(SRC, "components", "layout", "AIPanel.tsx"),
  path.join(SRC, "components", "NotificationBell.tsx"),
  path.join(SRC, "components", "FundScheduledTasksPanel.tsx"),
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

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

const errors = [];
const warnings = [];

for (const abs of walk(SRC)) {
  if (ALLOW.has(abs)) continue;
  const source = fs.readFileSync(abs, "utf8");
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(source))) {
      const item = {
        file: path.relative(ROOT, abs),
        line: lineOf(source, match.index),
        text: match[0].trim().slice(0, 90),
        hint: rule.hint,
      };
      (WARN_ONLY.has(abs) ? warnings : errors).push(item);
    }
  }
  for (const item of checkRenderSettingsCalls(source, abs)) {
    errors.push(item);
  }
  source.split("\n").forEach((line, index) => {
    for (const rule of LINE_RULES) {
      if (!rule.test(line)) continue;
      if (rule.allow && rule.allow(line)) continue;
      (WARN_ONLY.has(abs) ? warnings : errors).push({
        file: path.relative(ROOT, abs),
        line: index + 1,
        text: line.trim().slice(0, 90),
        hint: rule.hint,
      });
    }
  });
}

const seen = new Set();
const dedupe = (list) =>
  list.filter((p) => {
    const key = `${p.file}:${p.line}:${p.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

const errs = dedupe(errors);

if (!errs.length) {
  if (warnings.length) {
    console.log(`[check:account-label] ok（${warnings.length} 处迁移中警告）`);
  } else {
    console.log("[check:account-label] ok — 账户名称没有发现绕开统一入口的写法。");
  }
  process.exit(0);
}

console.error(`[check:account-label] 发现 ${errs.length} 处账户名称绕开统一入口：\n`);
for (const p of errs) {
  console.error(`  ${p.file}:${p.line}  ${p.text}`);
  console.error(`      → ${p.hint}`);
}
console.error("\n规则见 AGENTS.md「Account label contract」。");
process.exit(1);
