/**
 * 恢复字段覆盖校验
 *
 * 背景：备份恢复是**逐字段白名单**写入（src/lib/server/backup.ts），白名单漏字段时不会
 * 报错，只会静默落回列默认值。2026-09-30 那次恢复就是这样把 Account.loanType /
 * isConsumerLoan / fixedAssetType / collateralAssetId / repaymentOffsetDays /
 * billingDayTxPeriod 全部清空的 —— 表现是「消费贷分组消失、所有贷款变房贷、固定资产细分
 * 类型回退、抵押物关联丢失」。2026-10-26 又发现同一类漏写在 TxRecord 上：导出有值的
 * bond*、reimbursementDifference*、reconciled* 十一列在恢复映射里根本不存在。
 *
 * 所以规则不是「修一次 Account」，而是**每张被恢复的表都要把 schema 标量列和恢复白名单逐字段对齐**。
 * 新增一张表的覆盖 = 往 COVERED_MODELS 加一行；新增一个字段却忘了写进恢复映射 = 门禁直接红。
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

/**
 * 从 backup.ts 的某个恢复块里提取被写入的字段名。
 * 不给 endMarker 时，以「下一个 `if (data.`」为块边界——恢复映射块恒定的写法。
 */
function restoredFields(startMarker, endMarker) {
  const start = backupText.indexOf(startMarker);
  if (start === -1) return null;
  // 块边界：优先用显式 endMarker；否则取「行对象数组的收尾」或「下一个 if (data.」中更早的那个，
  // 这样不会把 createMappedRecordsInChunks 的选项对象（batchSize / afterChunk / label）算成字段。
  const candidates = endMarker
    ? [backupText.indexOf(endMarker, start)]
    : [backupText.indexOf("\n            };\n", start), backupText.indexOf("\n    if (data.", start)];
  const end = candidates.filter((index) => index > start).sort((a, b) => a - b)[0] ?? -1;
  if (end === -1) return null;
  const block = backupText.slice(start, end);
  const keys = new Set();
  // 显式键值：`name: ...`
  for (const match of block.matchAll(/^\s{8,}([A-Za-z]\w*)\s*:/gm)) keys.add(match[1]);
  // 简写属性：`householdId,`
  for (const match of block.matchAll(/^\s{8,}([A-Za-z]\w*)\s*,\s*$/gm)) keys.add(match[1]);
  return keys;
}

/**
 * 已纳入逐字段校验的表。每张表必须写清楚它在 backup.ts 里的恢复块边界，
 * 块找不到时会红（而不是静默跳过），避免重构后门禁假绿。
 */
const COVERED_MODELS = [
  {
    model: "Account",
    start: "if (data.accounts.length > 0) {",
    end: "if (data.accountAliases.length > 0) {",
  },
  {
    model: "TxRecord",
    start: "if (data.transactions.length > 0) {",
    end: null,
    // PostgreSQL 的快路径不经过 Prisma，用的是自己的列白名单——两条写路径都要逐字段对齐。
    insertColumns: {
      start: "const TRANSACTION_RESTORE_COLUMNS = [",
      end: "] as const;",
    },
  },
];

/** 从 PostgreSQL 快速插入的列白名单里提取列名 */
function insertColumnFields({ start: startMarker, end: endMarker }) {
  const start = backupText.indexOf(startMarker);
  if (start === -1) return null;
  const end = backupText.indexOf(endMarker, start);
  if (end === -1) return null;
  const block = backupText.slice(start, end);
  const keys = new Set();
  for (const match of block.matchAll(/\{\s*name:\s*"([A-Za-z]\w*)"/g)) keys.add(match[1]);
  return keys;
}

const failures = [];
for (const entry of COVERED_MODELS) {
  const fields = modelFields(entry.model);
  if (!fields) {
    failures.push(`恢复校验：schema 里找不到 model ${entry.model}，COVERED_MODELS 需要同步更新。`);
    continue;
  }
  const restored = restoredFields(entry.start, entry.end ?? undefined);
  if (!restored) {
    failures.push(`恢复校验：在 backup.ts 找不到 ${entry.model} 的恢复映射块（${entry.start}），脚本需要同步更新。`);
    continue;
  }
  const missing = fields.filter((field) => !restored.has(field));
  if (missing.length > 0) {
    failures.push(
      `备份恢复白名单漏掉 ${entry.model} 字段：${missing.join(", ")}。` +
        "漏字段不会报错，只会静默落回列默认值——必须补进 backup.ts 的恢复映射，" +
        "或（若确实不该恢复）在 scripts/check-restore-field-coverage.cjs 里显式登记理由。",
    );
  }

  if (entry.insertColumns) {
    const inserted = insertColumnFields(entry.insertColumns);
    if (!inserted) {
      failures.push(`恢复校验：找不到 ${entry.model} 的 PostgreSQL 快速插入列白名单，脚本需要同步更新。`);
    } else {
      const missingInsert = fields.filter((field) => !inserted.has(field));
      if (missingInsert.length > 0) {
        failures.push(
          `PostgreSQL 快速插入列白名单漏掉 ${entry.model} 字段：${missingInsert.join(", ")}。` +
            "这条路径绕过 Prisma 直接拼 INSERT，白名单少一列就静默丢一列。",
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Restore field coverage check FAILED:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const summary = COVERED_MODELS.map((entry) => {
  const fields = modelFields(entry.model) ?? [];
  const restored = restoredFields(entry.start, entry.end ?? undefined);
  return `${entry.model} ${fields.length}/${restored ? restored.size : 0}`;
}).join(", ");
console.log(`Restore field coverage check passed. schema/restored: ${summary}.`);
