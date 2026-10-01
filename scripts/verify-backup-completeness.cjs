const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backupSource = fs.readFileSync(path.join(root, "src", "lib", "server", "backup.ts"), "utf8");
const schemaSource = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const restoreRouteSource = fs.readFileSync(path.join(root, "src", "app", "api", "v1", "settings", "backup", "route.ts"), "utf8");
const nextConfigSource = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
const uploadLimitSource = fs.readFileSync(path.join(root, "src", "lib", "backup-upload-limit.ts"), "utf8");

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const requiredPayloadKeys = [
  "fundNavCaches",
  "fundSnapshots",
  "stockBrokerageCatalogs",
  "distillLogs",
  "commandTestResults",
  "commandAliases",
];

for (const key of requiredPayloadKeys) {
  expect(backupSource.includes(`${key}: ensureArray`), `Backup parser must accept ${key}.`);
  expect(backupSource.includes(`${key},`), `Backup payload must expose ${key}.`);
  expect(backupSource.includes(`{ field: "${key}"`), `Backup summary must expose ${key}.`);
}

for (const field of [
  "baseCurrency",
  "usageCount",
  "lastUsedAt",
  "passwordResetEnabled",
  "entryOrigin",
  "secondaryExecutionDay",
]) {
  expect(backupSource.includes(field), `Backup restore must preserve ${field}.`);
}

expect(
  backupSource.includes('{ field: "fundQueryApis"') &&
  backupSource.includes("fundQueryApis: fundQueryApis.length"),
  "Backup summary must expose the number of fund query APIs.",
);

for (const model of [
  "FundNavCache",
  "FundSnapshot",
  "StockBrokerageCatalog",
  "DistillLog",
  "CommandTestResult",
  "CommandAlias",
]) {
  expect(schemaSource.includes(`model ${model} {`), `Schema must contain ${model}.`);
  expect(backupSource.includes(model[0].toLowerCase() + model.slice(1)), `Backup source must reference ${model}.`);
}

expect(
  backupSource.includes('await tx.systemSetting.deleteMany({});') &&
  backupSource.includes('await tx.accessKey.deleteMany({});') &&
  backupSource.includes('await tx.aiModel.deleteMany({});') &&
  backupSource.includes('await tx.aiChannel.deleteMany({});'),
  "System restore must remove stale global settings and AI/access-key records before importing the snapshot.",
);

expect(
  backupSource.includes("await tx.passwordResetToken.deleteMany") &&
  backupSource.includes("await tx.undoOperation.deleteMany"),
  "Restore must continue clearing security tokens and undo history instead of restoring them.",
);

expect(
  backupSource.includes("OR: [{ householdId }, { householdId: null }]") &&
  backupSource.includes("householdId: isSystemRestore && item.householdId == null ? null : householdId"),
  "System backup must preserve global fund query APIs separately from household-scoped APIs.",
);

expect(
  backupSource.includes("export function serializeEncryptedBackupPackage"),
  "Encrypted backup packages must be serialized through serializeEncryptedBackupPackage.",
);
expect(
  backupSource.includes("function importBatchesForBackup") &&
  backupSource.includes("importBatchesForBackup(importBatches)") &&
  restoreRouteSource.includes("omitImportBatchRawText: false"),
  "Household backup export must omit ImportBatch.rawText through importBatchesForBackup.",
);
expect(
  backupSource.includes("function transactionsForBackup") &&
  backupSource.includes("TRANSACTION_BACKUP_DISPLAY_NAME_FIELDS") &&
  backupSource.includes("omitTransactionDisplayNames") &&
  restoreRouteSource.includes("omitTransactionDisplayNames: false"),
  "Household backup export must omit transaction display names while table export keeps them.",
);
expect(
  uploadLimitSource.includes("RESTORE_UPLOAD_LIMIT_MB = 512") &&
  uploadLimitSource.includes("RESTORE_UPLOAD_LIMIT_BYTES") &&
  uploadLimitSource.includes("RESTORE_UPLOAD_LIMIT_CONFIG") &&
  uploadLimitSource.includes("RESTORE_UPLOAD_LIMIT_LABEL"),
  "Restore upload limit must be the shared 512MB constant.",
);
expect(
  nextConfigSource.includes("RESTORE_UPLOAD_LIMIT_CONFIG") &&
  nextConfigSource.includes("proxyClientMaxBodySize: RESTORE_UPLOAD_LIMIT_CONFIG"),
  "Next.js proxy body size must use the shared restore upload limit.",
);
expect(
  restoreRouteSource.includes("RESTORE_UPLOAD_LIMIT_BYTES") &&
  restoreRouteSource.includes("serializeEncryptedBackupPackage") &&
  restoreRouteSource.includes("file.size > RESTORE_UPLOAD_LIMIT_BYTES") &&
  restoreRouteSource.includes("writeRestoreUploadToTemp") &&
  !restoreRouteSource.includes("128 * 1024 * 1024"),
  "Restore route must use the shared 512MB limit, compact export JSON, file.size check, and disk-backed upload.",
);

// Bond (bond products + bond certificates) must stay wired into every backup
// path: export query, payload, parser, restore clear, restore import, and the
// entry-business-link reference. It was silently missing until 2026-10-01,
// which both broke restores (dangling bondTransactionId FK) and dropped bond
// data from every backup. This block exists so the same gap cannot come back.
for (const key of ["bondProducts", "bondTransactions"]) {
  expect(backupSource.includes(`${key}: ensureArray`), `Backup parser must accept ${key}.`);
  expect(backupSource.includes(`data.${key}`), `Backup payload must expose ${key}.`);
}
expect(
  backupSource.includes("prisma.bondProduct.findMany") &&
  backupSource.includes("prisma.bondTransaction.findMany"),
  "Backup export must read bond products and bond transactions.",
);
expect(
  backupSource.includes('["BondProducts", sheetRows(payload.data.bondProducts)]') &&
  backupSource.includes('["BondTransactions", sheetRows(payload.data.bondTransactions)]'),
  "Table export workbooks must include BondProducts and BondTransactions sheets.",
);
expect(
  backupSource.includes("await tx.bondTransaction.deleteMany({ where: { householdId } });") &&
  backupSource.includes("await tx.bondProduct.deleteMany({ where: { householdId } });"),
  "Restore must clear stale bond transactions and bond products before importing the snapshot.",
);
expect(
  backupSource.includes("tx.bondProduct,") &&
  backupSource.includes("tx.bondTransaction,"),
  "Restore must import bond products and bond transactions.",
);
expect(
  backupSource.includes("importedBondProducts") &&
  backupSource.includes("importedBondTransactions"),
  "Restore must gate bond references on the bond rows that were actually imported.",
);
expect(
  backupSource.includes('{ name: "bondProductId", select: \'x."bondProductId"\' }'),
  "Transaction restore whitelist must carry bondProductId, or the bond link is silently dropped.",
);
expect(
  backupSource.includes("importedBondTransactions.has(String(item.bondTransactionId))"),
  "Entry business links must restore a bond reference only when that bond transaction was imported.",
);

// Reimbursement family (2026-10-01). Only Reimbursement and ReimbursementItem
// used to be backed up; ReimbursementBatch / ReimbursementTransaction /
// ReimbursementSettlement / ReimbursementSettlementTransaction were silently
// dropped, and reimbursements.batchId was force-nulled on restore because the
// batch table never travelled with the snapshot. The generic audit in
// scripts/check-backup-coverage.cjs catches a *missing* table; this block pins
// the *semantics* it cannot see (gated references instead of dropped rows).
for (const key of [
  "reimbursementBatches",
  "reimbursementTransactions",
  "reimbursementSettlements",
  "reimbursementSettlementTransactions",
  "creditCardBillingDays",
]) {
  expect(backupSource.includes(`${key}: ensureArray`), `Backup parser must accept ${key}.`);
  expect(backupSource.includes(`data.${key}`), `Backup payload must expose ${key}.`);
}
expect(
  backupSource.includes("prisma.reimbursementBatch.findMany") &&
  backupSource.includes("prisma.reimbursementTransaction.findMany") &&
  backupSource.includes("prisma.reimbursementSettlement.findMany") &&
  backupSource.includes("prisma.reimbursementSettlementTransaction.findMany") &&
  backupSource.includes("prisma.creditCardBillingDay.findMany"),
  "Backup export must read the whole reimbursement family plus credit-card billing-day history.",
);
expect(
  backupSource.includes("await tx.reimbursementSettlementTransaction.deleteMany") &&
  backupSource.includes("await tx.reimbursementSettlement.deleteMany") &&
  backupSource.includes("await tx.reimbursementTransaction.deleteMany") &&
  backupSource.includes("await tx.reimbursementBatch.deleteMany") &&
  backupSource.includes("await tx.creditCardBillingDay.deleteMany"),
  "Restore must clear stale reimbursement batches/settlements/links and billing-day history.",
);
expect(
  backupSource.includes("tx.reimbursementBatch,") &&
  backupSource.includes("tx.reimbursementTransaction,") &&
  backupSource.includes("tx.reimbursementSettlement,") &&
  backupSource.includes("tx.reimbursementSettlementTransaction,") &&
  backupSource.includes("tx.creditCardBillingDay.createMany"),
  "Restore must import the whole reimbursement family and billing-day history.",
);
expect(
  backupSource.includes("importedReimbursementBatches") &&
  backupSource.includes("importedReimbursementSettlements") &&
  backupSource.includes("importedReimbursementBatches.has(String(item.batchId))"),
  "Restore must gate reimbursement batch/settlement references on the rows that were imported.",
);
expect(
  !backupSource.includes("Reimbursement batches are not part of the backup payload"),
  "reimbursements.batchId must carry a gated reference now that batches are backed up, not be force-nulled.",
);
expect(
  backupSource.includes("item.paymentTxRecordId && importedTransactions.has(String(item.paymentTxRecordId))"),
  "reimbursements.paymentTxRecordId is a real foreign key and must be gated on imported transactions.",
);
expect(
  backupSource.includes("item.txRecordId && importedTransactions.has(String(item.txRecordId))"),
  "Reimbursement items must gate their optional txRecordId on imported transactions instead of dropping the row.",
);

console.log("Backup completeness checks passed.");
