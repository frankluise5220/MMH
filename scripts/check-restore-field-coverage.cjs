/**
 * 恢复字段覆盖校验（2026-10-06 新增）
 *
 * 背景：备份恢复是**逐字段白名单**写入（src/lib/server/backup.ts），白名单漏字段时不会
 * 报错，只会静默落回列默认值。2026-09-30 那次恢复就是这样把 Account.loanType /
 * isConsumerLoan / fixedAssetType / collateralAssetId / repaymentOffsetDays /
 * billingDayTxPeriod 全部清空的 —— 表现是「消费贷分组消失、所有贷款变房贷、固定资产细分
 * 类型回退、抵押物关联丢失」。
 *
 * 这个门禁把 schema 与恢复白名单逐字段比对：Account 上任何标量字段没有出现在恢复映射里，
 * 就直接红，堵住"以后再漏一个"。
 *
 * Usage: node scripts/check-restore-field-coverage.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const schemaText = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const backupText = fs.readFileSync(path.join(root, "src", "lib", "server", "backup.ts"), "utf8");

const SCALAR_TYPES = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"]);

// schema 里的枚举名，用来把枚举字段和关系字段区分开
const enumNames = new Set();
for (const match of schemaText.matchAll(/^enum\s+(\w+)\s*\{/gm)) enumNames.add(match[1]);

function modelFields(modelName) {
  const start = schemaText.indexOf(`model ${modelName} {`);
  if (start === -1) return null;
  const end = schemaText.indexOf("\n}", start);
  const body = schemaText.slice(start, end);
  const fields = [];
  for (const line of body.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;
    const match = /^(\w+)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(trimmed);
    if (!match) continue;
    const [, name, type, isArray] = match;
    if (isArray) continue; // 关系列表
    if (!SCALAR_TYPES.has(type) && !enumNames.has(type)) continue; // 关系字段
    fields.push(name);
  }
  return fields;
}

/** 从 backup.ts 的某个恢复块里提取被写入的字段名 */
function restoredFields(startMarker, endMarker) {
  const start = backupText.indexOf(startMarker);
  const end = backupText.indexOf(endMarker, start);
  if (start === -1 || end === -1) return null;
  const block = backupText.slice(start, end);
  const keys = new Set();
  // 显式键值：`name: ...`
  for (const match of block.matchAll(/^\s{8,}([A-Za-z]\w*)\s*:/gm)) keys.add(match[1]);
  // 简写属性：`householdId,`
  for (const match of block.matchAll(/^\s{8,}([A-Za-z]\w*)\s*,\s*$/gm)) keys.add(match[1]);
  return keys;
}

const failures = [];

// Account：schema 标量字段 vs 恢复白名单
const accountFields = modelFields("Account") ?? [];
const accountRestored = restoredFields("if (data.accounts.length > 0) {", "if (data.accountAliases.length > 0) {");
if (!accountRestored) {
  failures.push("恢复校验：在 backup.ts 找不到 Account 的恢复映射块，脚本需要同步更新。");
} else {
  const missing = accountFields.filter((field) => !accountRestored.has(field));
  if (missing.length > 0) {
    failures.push(
      `备份恢复白名单漏掉 Account 字段：${missing.join(", ")}。` +
        "漏字段不会报错，只会静默落回列默认值，必须补进 backup.ts 的账户恢复映射。",
    );
  }
}

if (failures.length > 0) {
  console.error("Restore field coverage check FAILED:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Restore field coverage check passed. Account scalars: ${accountFields.length}, restored: ${accountRestored.size}.`);
