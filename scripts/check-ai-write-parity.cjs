/**
 * Guardrail: the built-in AI is an automated writer, not a privileged backdoor.
 *
 * MCP tools are forced to dispatch through the existing route handlers. The AI
 * routes historically wrote TxRecord rows directly and skipped the side effects
 * those handlers own (undo snapshots, credit-card cycle cache, revalidation).
 * This check keeps the two write paths from drifting apart again.
 *
 * It is intentionally a source-level contract check: the effects live in shared
 * services, so a runtime test would need a full ledger fixture for every case.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILES = {
  aiImport: "src/app/api/v1/ai/import/route.ts",
  aiChat: "src/app/api/v1/ai/chat/route.ts",
  restore: "src/lib/server/entry-restore.ts",
  deleteRoute: "src/app/api/v1/entries/delete/route.ts",
  detailRoute: "src/app/api/v1/transactions/detail/route.ts",
  ledgerCreate: "src/lib/server/ledger-entry-create.ts",
};

const text = {};
for (const [key, rel] of Object.entries(FILES)) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.error(`[check:ai-write] 缺少文件：${rel}`);
    process.exit(1);
  }
  text[key] = fs.readFileSync(file, "utf8");
}

const required = [
  // 导入改成批量建行后用 prepareCreatedEntryUndo 按新建 id 生成快照（取代逐条 prepareEntryUndo）
  ["AI 导入写批量撤销快照", "aiImport", "prepareCreatedEntryUndo("],
  ["AI 导入保存 batch_create 快照", "aiImport", "saveEntryUndo("],
  ["AI 导入快照动作为 batch_create", "aiImport", '"batch_create"'],
  ["AI 导入失效信用卡账单缓存", "aiImport", "invalidateCreditCardCycleCacheForAccountIds("],
  ["AI 导入刷新页面缓存", "aiImport", "revalidateAfterTxChange("],
  ["AI 导入重算余额", "aiImport", "recalcAndSaveAccountBalance("],
  ["AI 对话写批量撤销快照", "aiChat", "prepareEntryUndo("],
  ["AI 对话保存 batch_edit 快照", "aiChat", "saveEntryUndo("],
  ["AI 对话快照动作为 batch_edit", "aiChat", '"batch_edit"'],
  ["AI 对话恢复走共享服务", "aiChat", "restoreDeletedEntries("],
  ["AI 对话失效信用卡账单缓存", "aiChat", "invalidateCreditCardCycleCacheForAccountIds("],
  ["共享恢复服务恢复业务明细", "restore", "restoreBusinessRecordsForCashEntryIds("],
  ["共享恢复服务重算余额", "restore", "recalcAndSaveAccountBalance("],
  ["共享恢复服务失效账单缓存", "restore", "invalidateCreditCardCycleCacheForAccountIds("],
  ["共享恢复服务刷新页面缓存", "restore", "revalidateAfterTxChange("],
  ["Web UI 删除/恢复入口复用共享服务", "deleteRoute", "restoreDeletedEntries("],
  ["UI/MCP 的 detail handler 走共享建行 action", "detailRoute", "createPlainLedgerEntry("],
  ["AI 导入走同一个共享建行 action", "aiImport", "createPlainLedgerEntry("],
  ["共享 action 统一账单期口径", "ledgerCreate", "resolvePlainStatementMonth("],
  ["共享 action 是唯一普通建行落库点", "ledgerCreate", "tx.txRecord.create("],
];

let failed = 0;
for (const [label, key, needle] of required) {
  const ok = text[key].includes(needle);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}（${FILES[key]}）`);
}

// A bare restore is the drift that started this guardrail. The only legitimate
// `data: { deletedAt: null }` for a restore lives in the shared service.
for (const key of ["aiImport", "aiChat"]) {
  const ok = !/data:\s*\{\s*deletedAt:\s*null\s*\}/.test(text[key]);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${FILES[key]} 不含裸软删除恢复`);
}

const callCount = (key, needle) => text[key].split(needle).length - 1;
for (const [label, key, needle, min] of [
  ["AI 导入的收支与转账都走共享 action", "aiImport", "createPlainLedgerEntry(", 2],
  ["detail handler 的支出/收入/转账都走共享 action", "detailRoute", "createPlainLedgerEntry(", 3],
]) {
  const count = callCount(key, needle);
  const ok = count >= min;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}（${count} 处，至少 ${min} 处）`);
}

console.log("");
if (failed > 0) {
  console.error(`[check:ai-write] ${failed} 项写入契约被破坏，请修复后再提交。`);
  process.exit(1);
}
console.log("[check:ai-write] 内置 AI 与 Web UI / MCP 的写入契约一致。");
