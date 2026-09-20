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

console.log("Backup completeness checks passed.");
