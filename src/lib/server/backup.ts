import crypto from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import type { CurrentUser } from "@/lib/server/auth";

export const BACKUP_FORMAT_VERSION = 3;
const ENCRYPTED_BACKUP_PACKAGE_VERSION = 3;
const ENCRYPTED_BACKUP_ALGORITHM = "aes-256-gcm";
const BACKUP_PACKAGE_KEY_SETTING = "backup_package_encryption_key";
const BACKUP_PASSPHRASE_KEY_SOURCE = "passphrase";
const BACKUP_PASSPHRASE_KDF = "pbkdf2-sha256";
const BACKUP_PASSPHRASE_KDF_ITERATIONS = 210_000;

type ExportedBy = Pick<CurrentUser, "id" | "name" | "role"> | null;
type BackupPackageEncryptionOptions = {
  passphrase?: string | null;
};

export type HouseholdBackupPayload = Awaited<ReturnType<typeof buildHouseholdBackupPayload>>;

function safeFilePart(value: string) {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "mmh"
  );
}

function toIsoString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function toSheetCellValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value.map((item) => toSheetCellValue(item)).join(", ");
  }
  if (value && typeof value === "object") {
    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      return toSheetCellValue((value as { toJSON: () => unknown }).toJSON());
    }
    return JSON.stringify(value);
  }
  return value;
}

function toPlainRecord<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      return [key, toSheetCellValue(value)];
    }),
  ) as Record<string, unknown>;
}

function summaryRows(payload: HouseholdBackupPayload) {
  return [
    { field: "app", value: payload.app },
    { field: "formatVersion", value: payload.formatVersion },
    { field: "exportedAt", value: toIsoString(payload.exportedAt) },
    { field: "householdName", value: payload.scope.householdName },
    { field: "householdId", value: payload.scope.householdId },
    { field: "exportedBy", value: payload.exportedBy?.name ?? "" },
    { field: "users", value: payload.counts.users },
    { field: "accounts", value: payload.counts.accounts },
    { field: "transactions", value: payload.counts.transactions },
    { field: "categories", value: payload.counts.categories },
    { field: "tags", value: payload.counts.tags },
    { field: "institutions", value: payload.counts.institutions },
    { field: "counterparties", value: payload.counts.counterparties },
    { field: "emailAccounts", value: payload.counts.emailAccounts },
    { field: "regularInvestPlans", value: payload.counts.regularInvestPlans },
    { field: "businessTransactions", value: payload.counts.businessTransactions },
    { field: "systemSettings", value: payload.counts.systemSettings },
    { field: "accessKeys", value: payload.counts.accessKeys },
    { field: "aiChannels", value: payload.counts.aiChannels },
    { field: "aiModels", value: payload.counts.aiModels },
  ];
}

function sheetRows<T extends Record<string, unknown>>(records: T[]) {
  return records.map((record) => toPlainRecord(record));
}

function omitRecordFields<T extends Record<string, unknown>>(records: T[], fields: Set<string>) {
  return records.map((record) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !fields.has(key))) as Record<string, unknown>,
  );
}

function buildAccountNameById(payload: HouseholdBackupPayload) {
  return new Map(payload.data.accounts.map((account) => [String(account.id), String(account.name ?? "")]));
}

function withGeneratedAccountNames(
  records: Record<string, unknown>[],
  accountNameById: Map<string, string>,
  fields: Array<{ idKey: string; nameKey: string }>,
) {
  return records.map((record) => {
    const next = { ...record };
    for (const field of fields) {
      const id = record[field.idKey] == null ? "" : String(record[field.idKey]);
      if (id && accountNameById.has(id)) {
        next[field.nameKey] = accountNameById.get(id) ?? "";
      }
    }
    return next;
  });
}

const TRANSACTION_EXPORT_LABELS: Record<string, string> = {
  id: "记录ID",
  date: "日期",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  dayOrder: "同日顺序",
  type: "类型",
  amount: "金额",
  accountId: "账户ID",
  accountName: "账户名称",
  toAccountId: "对向账户ID",
  toAccountName: "对向账户名称",
  categoryId: "分类ID",
  categoryName: "分类",
  note: "备注",
  toNote: "转账显示备注",
  counterpartyInstitutionId: "收支机构ID",
  counterpartyInstitutionName: "收支机构",
  statementMonth: "账单月份",
  source: "来源",
  fundCode: "基金代码",
  fundName: "基金名称",
  fundProductType: "产品类型",
  fundSubtype: "产品动作",
  fundUnits: "份额",
  fundNav: "净值",
  fundFee: "手续费",
  fundConfirmDate: "确认日期",
  fundArrivalDate: "到账日期",
  fundArrivalAmount: "到账金额",
  depositAnnualRate: "年化利率",
  depositInterest: "利息",
  depositSourceEntryId: "关联存单ID",
  insuranceProductId: "保险产品ID",
  householdId: "账簿ID",
  deletedAt: "删除时间",
};

function labelTransactionRows(records: Record<string, unknown>[]) {
  return records.map((record) => {
    const plain = toPlainRecord(record);
    return Object.fromEntries(
      Object.entries(plain).map(([key, value]) => [TRANSACTION_EXPORT_LABELS[key] ?? key, value]),
    );
  });
}

function restoreError(message: string): never {
  throw new Error(message);
}

function ensureArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    restoreError(`备份文件格式错误：${label} 不是数组`);
  }
  return value as Array<Record<string, unknown>>;
}

function ensureObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    restoreError(`备份文件格式错误：${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function isLegacyFundProductType(value: unknown) {
  const productType = String(value ?? "");
  return !productType || productType === "fund" || productType === "money" || productType === "money_fund";
}

function normalizeLegacyFundProductType(value: unknown) {
  const productType = String(value ?? "");
  return productType === "money" || productType === "money_fund" ? "money" : "fund";
}

function normalizeLegacyFundSubtype(value: unknown) {
  const subtype = String(value ?? "buy");
  return subtype || "buy";
}

function isLegacyFundCashReceipt(item: Record<string, unknown>) {
  const subtype = normalizeLegacyFundSubtype(item.fundSubtype);
  return subtype === "redeem" || subtype === "switch_out" || subtype === "dividend_cash";
}

function isLegacyFundRefundRow(item: Record<string, unknown>) {
  return normalizeLegacyFundSubtype(item.fundSubtype) === "buy_failed" && String(item.source ?? "") === "regular_invest_refund";
}

function legacyFundAccountIdOf(item: Record<string, unknown>) {
  if (isLegacyFundCashReceipt(item) || isLegacyFundRefundRow(item)) return String(item.accountId ?? "");
  return String(item.toAccountId ?? item.accountId ?? "");
}

function legacyFundCashAccountIdOf(item: Record<string, unknown>, importedAccounts: Set<string>) {
  const raw = isLegacyFundCashReceipt(item) || isLegacyFundRefundRow(item) ? item.toAccountId : item.accountId;
  const id = raw == null ? "" : String(raw);
  return id && importedAccounts.has(id) ? id : null;
}

function legacyFundCashFlowKindOf(item: Record<string, unknown>) {
  const subtype = normalizeLegacyFundSubtype(item.fundSubtype);
  if (isLegacyFundRefundRow(item)) return "refund_in";
  if (subtype === "buy" || subtype === "buy_failed") return "buy_out";
  if (subtype === "redeem" || subtype === "switch_out") return "redeem_in";
  if (subtype === "dividend_cash") return "dividend_in";
  if (subtype === "dividend_reinvest") return "dividend_reinvest_internal";
  if (subtype === "switch_in") return "switch_in";
  return "other";
}

function absDecimalString(value: unknown) {
  const amount = Math.abs(Number(String(value ?? "0")));
  return Number.isFinite(amount) ? String(amount) : "0";
}

function legacyDate(value: unknown) {
  return value == null || value === "" ? null : new Date(String(value));
}

function normalizeRecordDates(record: Record<string, unknown>, nullDateKeys = new Set<string>()) {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    const isDateField = key === "date" || lowerKey.endsWith("date") || lowerKey.endsWith("at");
    if (isDateField) {
      if (value == null || value === "") {
        normalized[key] = nullDateKeys.has(key) ? null : value;
      } else {
        normalized[key] = new Date(String(value));
      }
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

async function createManyRecords(
  delegate: unknown,
  records: Record<string, unknown>[],
  nullDateKeys = new Set<string>(),
) {
  if (records.length === 0) return;
  const target = delegate as { createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown> };
  await target.createMany({ data: records.map((record) => normalizeRecordDates(record, nullDateKeys)) });
}

function decodeBackupPackageKey(value: string) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    restoreError("当前系统备份加密密钥格式错误，无法处理加密备份");
  }
  return key;
}

async function getOrCreateBackupPackageKey() {
  const existing = await prisma.systemSetting.findUnique({ where: { key: BACKUP_PACKAGE_KEY_SETTING } });
  if (existing?.value) {
    return decodeBackupPackageKey(existing.value);
  }

  const generatedValue = crypto.randomBytes(32).toString("base64");
  try {
    const created = await prisma.systemSetting.create({
      data: { key: BACKUP_PACKAGE_KEY_SETTING, value: generatedValue },
    });
    return decodeBackupPackageKey(created.value);
  } catch {
    const retry = await prisma.systemSetting.findUnique({ where: { key: BACKUP_PACKAGE_KEY_SETTING } });
    if (retry?.value) {
      return decodeBackupPackageKey(retry.value);
    }
    restoreError("当前系统无法创建备份加密密钥");
  }
}

async function getBackupPackageKey() {
  const existing = await prisma.systemSetting.findUnique({ where: { key: BACKUP_PACKAGE_KEY_SETTING } });
  if (!existing?.value) {
    restoreError("当前系统缺少备份解密密钥，无法恢复该加密备份");
  }
  return decodeBackupPackageKey(existing.value);
}

function normalizeBackupPassphrase(value: string | null | undefined) {
  const passphrase = String(value ?? "").trim();
  return passphrase || null;
}

function deriveBackupPassphraseKey(passphrase: string, salt: Buffer, iterations: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, iterations, 32, "sha256", (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

function backupPassphraseIterations(value: unknown) {
  const iterations = Number(value ?? BACKUP_PASSPHRASE_KDF_ITERATIONS);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    restoreError("备份加密参数错误");
  }
  return iterations;
}

function decodeBackupPassphraseSalt(value: unknown) {
  const salt = Buffer.from(String(value ?? ""), "base64");
  if (salt.length < 16) {
    restoreError("备份加密参数错误");
  }
  return salt;
}

async function getBackupEncryptionKey(options: BackupPackageEncryptionOptions = {}) {
  const passphrase = normalizeBackupPassphrase(options.passphrase);
  if (passphrase) {
    const salt = crypto.randomBytes(16);
    const iterations = BACKUP_PASSPHRASE_KDF_ITERATIONS;
    const key = await deriveBackupPassphraseKey(passphrase, salt, iterations);
    return {
      key,
      metadata: {
        keySource: BACKUP_PASSPHRASE_KEY_SOURCE,
        kdf: BACKUP_PASSPHRASE_KDF,
        iterations,
        salt: salt.toString("base64"),
      },
    };
  }

  const key = await getOrCreateBackupPackageKey();
  return {
    key,
    metadata: {
      keySource: BACKUP_PACKAGE_KEY_SETTING,
    },
  };
}

async function getBackupDecryptionKey(
  encryption: Record<string, unknown>,
  options: BackupPackageEncryptionOptions = {},
) {
  const keySource = String(encryption.keySource ?? "");
  if (keySource === BACKUP_PASSPHRASE_KEY_SOURCE) {
    if (String(encryption.kdf ?? "") !== BACKUP_PASSPHRASE_KDF) {
      restoreError("不支持的备份加密口令格式");
    }
    const passphrase = normalizeBackupPassphrase(options.passphrase);
    if (!passphrase) {
      restoreError("请输入备份加密口令，或输入创建备份时使用的用户密码");
    }
    return deriveBackupPassphraseKey(
      passphrase,
      decodeBackupPassphraseSalt(encryption.salt),
      backupPassphraseIterations(encryption.iterations),
    );
  }

  if (keySource === BACKUP_PACKAGE_KEY_SETTING) {
    try {
      return await getBackupPackageKey();
    } catch (error) {
      if (error instanceof Error && error.message.includes("缺少备份解密密钥")) {
        restoreError("这是旧版系统密钥加密备份，当前系统缺少原备份解密密钥；请在创建该备份的系统重新导出新版口令备份，或恢复包含该密钥的旧环境。");
      }
      throw error;
    }
  }

  restoreError("不支持的备份加密密钥来源");
}

export async function encryptBackupPayload(
  payload: HouseholdBackupPayload,
  options: BackupPackageEncryptionOptions = {},
) {
  const iv = crypto.randomBytes(12);
  const { key, metadata } = await getBackupEncryptionKey(options);
  const cipher = crypto.createCipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    app: "MMH" as const,
    packageType: "encrypted-backup" as const,
    packageVersion: ENCRYPTED_BACKUP_PACKAGE_VERSION,
    encrypted: true,
    exportedAt: payload.exportedAt,
    scope: payload.scope,
    encryption: {
      algorithm: ENCRYPTED_BACKUP_ALGORITHM,
      ...metadata,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptBackupPackage(
  raw: unknown,
  options: BackupPackageEncryptionOptions = {},
) {
  const packageObject = ensureObject(raw, "payload");
  if (packageObject.encrypted !== true) return raw;
  if (packageObject.app !== "MMH" || packageObject.packageType !== "encrypted-backup") {
    restoreError("这不是 MMH 加密备份文件");
  }

  const encryption = ensureObject(packageObject.encryption, "encryption");
  if (encryption.algorithm !== ENCRYPTED_BACKUP_ALGORITHM) {
    restoreError("不支持的备份加密格式");
  }

  const key = await getBackupDecryptionKey(encryption, options);
  try {
    const iv = Buffer.from(String(encryption.iv ?? ""), "base64");
    const authTag = Buffer.from(String(encryption.authTag ?? ""), "base64");
    const ciphertext = Buffer.from(String(packageObject.ciphertext ?? ""), "base64");
    const decipher = crypto.createDecipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    restoreError("备份文件无法解密或已损坏");
  }
}

const RESTORABLE_HOUSEHOLD_SETTING_PREFIXES = [
  "category_hierarchy_normalized:",
  "category_deleted_default_templates:",
];

function householdSystemSettingKeys(householdId: string) {
  return RESTORABLE_HOUSEHOLD_SETTING_PREFIXES.map((prefix) => `${prefix}${householdId}`);
}

function remapHouseholdSystemSettingKey(key: string, sourceHouseholdId: string, targetHouseholdId: string) {
  for (const prefix of RESTORABLE_HOUSEHOLD_SETTING_PREFIXES) {
    if (key === `${prefix}${sourceHouseholdId}` || key === `${prefix}${targetHouseholdId}`) {
      return `${prefix}${targetHouseholdId}`;
    }
  }
  return null;
}

export function buildBackupFileName(householdName: string, exportedAt: Date, format: "json" | "xlsx" | "mmh-backup") {
  const suffix = format;
  return `${safeFilePart(householdName)}-backup-${exportedAt.toISOString().replace(/[:.]/g, "-")}.${suffix}`;
}

export function buildTableExportFileName(householdName: string, exportedAt: Date) {
  return `${safeFilePart(householdName)}-table-export-${exportedAt.toISOString().replace(/[:.]/g, "-")}.xlsx`;
}

export async function buildHouseholdBackupPayload(
  householdId: string,
  exportedBy: ExportedBy,
  options: { ensureBackupPackageKey?: boolean } = {},
) {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
  });
  if (!household) {
    restoreError("当前账簿不存在");
  }

  if (options.ensureBackupPackageKey !== false) {
    await getOrCreateBackupPackageKey();
  }

  const [
    users,
    accountGroups,
    institutions,
    counterparties,
    categories,
    tags,
    insuranceProductMasters,
    wealthProducts,
    accounts,
    regularInvestPlans,
    creditCardInstallmentPlans,
    loanRateAdjustments,
    fundQueryApis,
    importBatches,
    transactions,
    emailAccounts,
    preciousMetalTypes,
    preciousMetalUnits,
    fxRates,
    fxConversions,
    insuranceProducts,
    fundTransactions,
    fundTransactionCashFlows,
    insuranceTransactions,
    wealthTransactions,
    depositTransactions,
    preciousMetalTransactions,
    stockSecurities,
    stockHoldings,
    stockTransactions,
    stockPriceCache,
    stockFeeRules,
    entryBusinessLinks,
    systemSettings,
    accessKeys,
    aiChannels,
    aiModels,
  ] = await Promise.all([
    prisma.user.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.accountGroup.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.institution.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.counterparty.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.category.findMany({ where: { householdId }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.tag.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.insuranceProductMaster.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.wealthProduct.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.account.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.regularInvestPlan.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.creditCardInstallmentPlan.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.loanRateAdjustment.findMany({ where: { householdId }, orderBy: [{ effectiveDate: "asc" }] }),
    prisma.fundQueryApi.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.importBatch.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.txRecord.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.emailAccount.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.preciousMetalType.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.preciousMetalUnit.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.fxRate.findMany({ where: { householdId }, orderBy: [{ rateDate: "asc" }] }),
    prisma.fxConversion.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.insuranceProduct.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.fundTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.fundTransactionCashFlow.findMany({
      where: { FundTransaction: { householdId } },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.insuranceTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.wealthTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.depositTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.preciousMetalTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.stockSecurity.findMany({ where: { householdId }, orderBy: [{ market: "asc" }, { stockCode: "asc" }] }),
    prisma.stockHolding.findMany({ where: { householdId }, orderBy: [{ accountId: "asc" }, { market: "asc" }, { stockCode: "asc" }] }),
    prisma.stockTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.stockPriceCache.findMany({ where: { StockSecurity: { is: { householdId } } }, orderBy: [{ priceDate: "asc" }, { market: "asc" }, { stockCode: "asc" }] }),
    prisma.stockFeeRule.findMany({ where: { Account: { householdId } }, orderBy: [{ accountId: "asc" }, { effectiveDate: "asc" }] }),
    prisma.entryBusinessLink.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.systemSetting.findMany({ orderBy: [{ key: "asc" }] }),
    prisma.accessKey.findMany({ orderBy: [{ createdAt: "asc" }] }),
    prisma.aiChannel.findMany({ orderBy: [{ createdAt: "asc" }] }),
    prisma.aiModel.findMany({ orderBy: [{ createdAt: "asc" }] }),
  ]);

  const userIds = users.map((item) => item.id);
  const accountIds = accounts.map((item) => item.id);

  const [
    userSettings,
    accountAliases,
    billOverrides,
    creditCardCycles,
    fundConfirmDays,
    fundFeeRates,
    fundHoldings,
    preciousMetalHoldings,
    fundSnapshots,
    attachments,
    entryTags,
  ] = await Promise.all([
    userIds.length > 0
      ? prisma.userSettings.findMany({ where: { userId: { in: userIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.accountAlias.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.billOverride.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.creditCardCycle.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundConfirmDays.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundFeeRate.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundHolding.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ accountId: "asc" }, { fundCode: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.preciousMetalHolding.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ accountId: "asc" }, { metalTypeName: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundSnapshot.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    prisma.attachment.findMany({ where: { transactions: { householdId } }, orderBy: [{ createdAt: "asc" }] }),
    prisma.entryTag.findMany({
      where: { transactions: { householdId } },
      orderBy: [{ entryId: "asc" }, { tagId: "asc" }],
    }),
  ]);

  const exportedAt = new Date();

  return {
    app: "MMH" as const,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt,
    exportedBy,
    scope: {
      householdId: household.id,
      householdName: household.name,
    },
    counts: {
      users: users.length,
      accounts: accounts.length,
      transactions: transactions.length,
      categories: categories.length,
      tags: tags.length,
      institutions: institutions.length,
      counterparties: counterparties.length,
      emailAccounts: emailAccounts.length,
      regularInvestPlans: regularInvestPlans.length,
      businessTransactions:
        fundTransactions.length +
        insuranceTransactions.length +
        wealthTransactions.length +
        depositTransactions.length +
        preciousMetalTransactions.length +
        stockTransactions.length,
      systemSettings: systemSettings.length,
      accessKeys: accessKeys.length,
      aiChannels: aiChannels.length,
      aiModels: aiModels.length,
    },
    data: {
      household,
      systemSettings,
      accessKeys,
      aiChannels,
      aiModels,
      users,
      userSettings,
      accountGroups,
      institutions,
      counterparties,
      categories,
      tags,
      insuranceProductMasters,
      wealthProducts,
      accounts,
      accountAliases,
      billOverrides,
      creditCardCycles,
      creditCardInstallmentPlans,
      fundConfirmDays,
      fundFeeRates,
      fundHoldings,
      preciousMetalTypes,
      preciousMetalUnits,
      preciousMetalHoldings,
      loanRateAdjustments,
      fundQueryApis,
      fundSnapshots,
      regularInvestPlans,
      importBatches,
      transactions,
      fxRates,
      fxConversions,
      insuranceProducts,
      fundTransactions,
      fundTransactionCashFlows,
      insuranceTransactions,
      wealthTransactions,
      depositTransactions,
      preciousMetalTransactions,
      stockSecurities,
      stockHoldings,
      stockTransactions,
      stockPriceCache,
      stockFeeRules,
      entryBusinessLinks,
      attachments,
      entryTags,
      emailAccounts,
    },
  };
}

export async function buildHouseholdBackupWorkbook(payload: HouseholdBackupPayload) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();

  const sheets: Array<[string, Record<string, unknown>[]]> = [
    ["Summary", summaryRows(payload)],
    ["SystemSettings", sheetRows(payload.data.systemSettings)],
    ["Users", sheetRows(payload.data.users)],
    ["UserSettings", sheetRows(payload.data.userSettings)],
    ["AccountGroups", sheetRows(payload.data.accountGroups)],
    ["Institutions", sheetRows(payload.data.institutions)],
    ["Counterparties", sheetRows(payload.data.counterparties)],
    ["Categories", sheetRows(payload.data.categories)],
    ["Tags", sheetRows(payload.data.tags)],
    ["InsuranceProductMasters", sheetRows(payload.data.insuranceProductMasters)],
    ["WealthProducts", sheetRows(payload.data.wealthProducts)],
    ["Accounts", sheetRows(payload.data.accounts)],
    ["AccountAliases", sheetRows(payload.data.accountAliases)],
    ["BillOverrides", sheetRows(payload.data.billOverrides)],
    ["CreditCardCycles", sheetRows(payload.data.creditCardCycles)],
    ["CreditCardInstallmentPlans", sheetRows(payload.data.creditCardInstallmentPlans)],
    ["FundConfirmDays", sheetRows(payload.data.fundConfirmDays)],
    ["FundFeeRates", sheetRows(payload.data.fundFeeRates)],
    ["FundHoldings", sheetRows(payload.data.fundHoldings)],
    ["PreciousMetalTypes", sheetRows(payload.data.preciousMetalTypes)],
    ["PreciousMetalUnits", sheetRows(payload.data.preciousMetalUnits)],
    ["PreciousMetalHoldings", sheetRows(payload.data.preciousMetalHoldings)],
    ["LoanRateAdjustments", sheetRows(payload.data.loanRateAdjustments)],
    ["FundQueryApis", sheetRows(payload.data.fundQueryApis)],
    ["FundSnapshots", sheetRows(payload.data.fundSnapshots)],
    ["RegularInvestPlans", sheetRows(payload.data.regularInvestPlans)],
    ["ImportBatches", sheetRows(payload.data.importBatches)],
    ["Transactions", labelTransactionRows(payload.data.transactions as Record<string, unknown>[])],
    ["FxRates", sheetRows(payload.data.fxRates)],
    ["FxConversions", sheetRows(payload.data.fxConversions)],
    ["InsuranceProducts", sheetRows(payload.data.insuranceProducts)],
    ["FundTransactions", sheetRows(payload.data.fundTransactions)],
    ["FundTransactionCashFlows", sheetRows(payload.data.fundTransactionCashFlows)],
    ["InsuranceTransactions", sheetRows(payload.data.insuranceTransactions)],
    ["WealthTransactions", sheetRows(payload.data.wealthTransactions)],
    ["DepositTransactions", sheetRows(payload.data.depositTransactions)],
    ["PreciousMetalTransactions", sheetRows(payload.data.preciousMetalTransactions)],
    ["StockSecurities", sheetRows(payload.data.stockSecurities)],
    ["StockHoldings", sheetRows(payload.data.stockHoldings)],
    ["StockTransactions", sheetRows(payload.data.stockTransactions)],
    ["StockPriceCache", sheetRows(payload.data.stockPriceCache)],
    ["StockFeeRules", sheetRows(payload.data.stockFeeRules)],
    ["EntryBusinessLinks", sheetRows(payload.data.entryBusinessLinks)],
    ["Attachments", sheetRows(payload.data.attachments)],
    ["EntryTags", sheetRows(payload.data.entryTags)],
    ["EmailAccounts", sheetRows(payload.data.emailAccounts)],
  ];

  for (const [sheetName, rows] of sheets) {
    const worksheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ empty: "" }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function buildHouseholdTableExportWorkbook(payload: HouseholdBackupPayload) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const accountNameById = buildAccountNameById(payload);
  const tableTransactions = withGeneratedAccountNames(
    payload.data.transactions as Record<string, unknown>[],
    accountNameById,
    [
      { idKey: "accountId", nameKey: "accountName" },
      { idKey: "toAccountId", nameKey: "toAccountName" },
    ],
  );
  const tableRegularInvestPlans = withGeneratedAccountNames(
    payload.data.regularInvestPlans as Record<string, unknown>[],
    accountNameById,
    [
      { idKey: "accountId", nameKey: "accountName" },
      { idKey: "cashAccountId", nameKey: "cashAccountName" },
    ],
  );

  const sheets: Array<[string, Record<string, unknown>[]]> = [
    ["Summary", summaryRows(payload)],
    ["Users", sheetRows(omitRecordFields(payload.data.users, new Set(["passwordHash"])))],
    ["AccountGroups", sheetRows(payload.data.accountGroups)],
    ["Institutions", sheetRows(payload.data.institutions)],
    ["Counterparties", sheetRows(payload.data.counterparties)],
    ["Categories", sheetRows(payload.data.categories)],
    ["Tags", sheetRows(payload.data.tags)],
    ["InsuranceProductMasters", sheetRows(payload.data.insuranceProductMasters)],
    ["WealthProducts", sheetRows(payload.data.wealthProducts)],
    ["Accounts", sheetRows(payload.data.accounts)],
    ["AccountAliases", sheetRows(payload.data.accountAliases)],
    ["BillOverrides", sheetRows(payload.data.billOverrides)],
    ["CreditCardCycles", sheetRows(payload.data.creditCardCycles)],
    ["CreditCardInstallmentPlans", sheetRows(payload.data.creditCardInstallmentPlans)],
    ["FundConfirmDays", sheetRows(payload.data.fundConfirmDays)],
    ["FundFeeRates", sheetRows(payload.data.fundFeeRates)],
    ["FundHoldings", sheetRows(payload.data.fundHoldings)],
    ["PreciousMetalTypes", sheetRows(payload.data.preciousMetalTypes)],
    ["PreciousMetalUnits", sheetRows(payload.data.preciousMetalUnits)],
    ["PreciousMetalHoldings", sheetRows(payload.data.preciousMetalHoldings)],
    ["LoanRateAdjustments", sheetRows(payload.data.loanRateAdjustments)],
    ["FundQueryApis", sheetRows(payload.data.fundQueryApis)],
    ["FundSnapshots", sheetRows(payload.data.fundSnapshots)],
    ["RegularInvestPlans", sheetRows(tableRegularInvestPlans)],
    ["ImportBatches", sheetRows(payload.data.importBatches)],
    ["Transactions", labelTransactionRows(tableTransactions)],
    ["FxRates", sheetRows(payload.data.fxRates)],
    ["FxConversions", sheetRows(payload.data.fxConversions)],
    ["InsuranceProducts", sheetRows(payload.data.insuranceProducts)],
    ["FundTransactions", sheetRows(payload.data.fundTransactions)],
    ["FundTransactionCashFlows", sheetRows(payload.data.fundTransactionCashFlows)],
    ["InsuranceTransactions", sheetRows(payload.data.insuranceTransactions)],
    ["WealthTransactions", sheetRows(payload.data.wealthTransactions)],
    ["DepositTransactions", sheetRows(payload.data.depositTransactions)],
    ["PreciousMetalTransactions", sheetRows(payload.data.preciousMetalTransactions)],
    ["StockSecurities", sheetRows(payload.data.stockSecurities)],
    ["StockHoldings", sheetRows(payload.data.stockHoldings)],
    ["StockTransactions", sheetRows(payload.data.stockTransactions)],
    ["StockPriceCache", sheetRows(payload.data.stockPriceCache)],
    ["StockFeeRules", sheetRows(payload.data.stockFeeRules)],
    ["EntryBusinessLinks", sheetRows(payload.data.entryBusinessLinks)],
    ["Attachments", sheetRows(payload.data.attachments)],
    ["EntryTags", sheetRows(payload.data.entryTags)],
  ];

  for (const [sheetName, rows] of sheets) {
    const worksheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ empty: "" }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function parseBackupPayload(raw: unknown) {
  const payload = ensureObject(raw, "payload");
  if (payload.app !== "MMH") {
    restoreError("这不是 MMH 备份文件");
  }
  const data = ensureObject(payload.data, "data");
  const scope = ensureObject(payload.scope, "scope");

  return {
    app: String(payload.app),
    formatVersion: Number(payload.formatVersion ?? 0),
    exportedAt: payload.exportedAt,
    exportedBy: payload.exportedBy ?? null,
    scope: {
      householdId: String(scope.householdId ?? ""),
      householdName: String(scope.householdName ?? "恢复账簿"),
    },
    counts: ensureObject(payload.counts ?? {}, "counts"),
    data: {
      household: ensureObject(data.household ?? {}, "data.household"),
      systemSettings: ensureArray(data.systemSettings ?? [], "data.systemSettings"),
      accessKeys: ensureArray(data.accessKeys ?? [], "data.accessKeys"),
      aiChannels: ensureArray(data.aiChannels ?? [], "data.aiChannels"),
      aiModels: ensureArray(data.aiModels ?? [], "data.aiModels"),
      users: ensureArray(data.users ?? [], "data.users"),
      userSettings: ensureArray(data.userSettings ?? [], "data.userSettings"),
      accountGroups: ensureArray(data.accountGroups ?? [], "data.accountGroups"),
      institutions: ensureArray(data.institutions ?? [], "data.institutions"),
      counterparties: ensureArray(data.counterparties ?? [], "data.counterparties"),
      categories: ensureArray(data.categories ?? [], "data.categories"),
      tags: ensureArray(data.tags ?? [], "data.tags"),
      insuranceProductMasters: ensureArray(data.insuranceProductMasters ?? [], "data.insuranceProductMasters"),
      wealthProducts: ensureArray(data.wealthProducts ?? [], "data.wealthProducts"),
      accounts: ensureArray(data.accounts ?? [], "data.accounts"),
      accountAliases: ensureArray(data.accountAliases ?? [], "data.accountAliases"),
      billOverrides: ensureArray(data.billOverrides ?? [], "data.billOverrides"),
      creditCardCycles: ensureArray(data.creditCardCycles ?? [], "data.creditCardCycles"),
      creditCardInstallmentPlans: ensureArray(data.creditCardInstallmentPlans ?? [], "data.creditCardInstallmentPlans"),
      fundConfirmDays: ensureArray(data.fundConfirmDays ?? [], "data.fundConfirmDays"),
      fundFeeRates: ensureArray(data.fundFeeRates ?? [], "data.fundFeeRates"),
      fundHoldings: ensureArray(data.fundHoldings ?? [], "data.fundHoldings"),
      preciousMetalTypes: ensureArray(data.preciousMetalTypes ?? [], "data.preciousMetalTypes"),
      preciousMetalUnits: ensureArray(data.preciousMetalUnits ?? [], "data.preciousMetalUnits"),
      preciousMetalHoldings: ensureArray(data.preciousMetalHoldings ?? [], "data.preciousMetalHoldings"),
      loanRateAdjustments: ensureArray(data.loanRateAdjustments ?? [], "data.loanRateAdjustments"),
      fundQueryApis: ensureArray(data.fundQueryApis ?? [], "data.fundQueryApis"),
      fundSnapshots: ensureArray(data.fundSnapshots ?? [], "data.fundSnapshots"),
      regularInvestPlans: ensureArray(data.regularInvestPlans ?? [], "data.regularInvestPlans"),
      importBatches: ensureArray(data.importBatches ?? [], "data.importBatches"),
      transactions: ensureArray(data.transactions ?? [], "data.transactions"),
      fxRates: ensureArray(data.fxRates ?? [], "data.fxRates"),
      fxConversions: ensureArray(data.fxConversions ?? [], "data.fxConversions"),
      insuranceProducts: ensureArray(data.insuranceProducts ?? [], "data.insuranceProducts"),
      fundTransactions: ensureArray(data.fundTransactions ?? [], "data.fundTransactions"),
      fundTransactionCashFlows: ensureArray(data.fundTransactionCashFlows ?? [], "data.fundTransactionCashFlows"),
      insuranceTransactions: ensureArray(data.insuranceTransactions ?? [], "data.insuranceTransactions"),
      wealthTransactions: ensureArray(data.wealthTransactions ?? [], "data.wealthTransactions"),
      depositTransactions: ensureArray(data.depositTransactions ?? [], "data.depositTransactions"),
      preciousMetalTransactions: ensureArray(data.preciousMetalTransactions ?? [], "data.preciousMetalTransactions"),
      stockSecurities: ensureArray(data.stockSecurities ?? [], "data.stockSecurities"),
      stockHoldings: ensureArray(data.stockHoldings ?? [], "data.stockHoldings"),
      stockTransactions: ensureArray(data.stockTransactions ?? [], "data.stockTransactions"),
      stockPriceCache: ensureArray(data.stockPriceCache ?? [], "data.stockPriceCache"),
      stockFeeRules: ensureArray(data.stockFeeRules ?? [], "data.stockFeeRules"),
      entryBusinessLinks: ensureArray(data.entryBusinessLinks ?? [], "data.entryBusinessLinks"),
      attachments: ensureArray(data.attachments ?? [], "data.attachments"),
      entryTags: ensureArray(data.entryTags ?? [], "data.entryTags"),
      emailAccounts: ensureArray(data.emailAccounts ?? [], "data.emailAccounts"),
    },
  };
}

export async function restoreHouseholdBackup(
  rawPayload: unknown,
  options: {
    householdId: string;
    fallbackAdmin?: {
      name: string;
      role: string;
      isSystem: boolean;
      email?: string | null;
      passwordHash?: string | null;
    } | null;
  },
) {
  const payload = parseBackupPayload(rawPayload);
  const data = payload.data;
  const householdId = options.householdId;

  const importedUsers = data.users.map((item) => String(item.id));
  const importedUserSet = new Set(importedUsers);
  const importedAccountGroups = new Set(data.accountGroups.map((item) => String(item.id)));
  const importedInstitutions = new Set(data.institutions.map((item) => String(item.id)));
  const importedCounterparties = new Set(data.counterparties.map((item) => String(item.id)));
  const importedFundQueryApis = new Set(data.fundQueryApis.map((item) => String(item.id)));
  const importedAccounts = new Set(data.accounts.map((item) => String(item.id)));
  const importedCategories = new Set(data.categories.map((item) => String(item.id)));
  const importedImportBatches = new Set(data.importBatches.map((item) => String(item.id)));
  const importedTransactions = new Set(data.transactions.map((item) => String(item.id)));
  const importedTags = new Set(data.tags.map((item) => String(item.id)));
  const importedInsuranceProductMasters = new Set(data.insuranceProductMasters.map((item) => String(item.id)));
  const importedInsuranceProducts = new Set(data.insuranceProducts.map((item) => String(item.id)));
  const importedWealthProducts = new Set(data.wealthProducts.map((item) => String(item.id)));
  const importedCreditCardInstallmentPlans = new Set(data.creditCardInstallmentPlans.map((item) => String(item.id)));
  const importedPreciousMetalTypes = new Set(data.preciousMetalTypes.map((item) => String(item.id)));
  const importedPreciousMetalUnits = new Set(data.preciousMetalUnits.map((item) => String(item.id)));
  const importedFundTransactions = new Set(data.fundTransactions.map((item) => String(item.id)));
  const importedStockSecurities = new Set(data.stockSecurities.map((item) => String(item.id)));
  const importedStockTransactions = new Set(
    data.stockTransactions
      .filter(
        (item) =>
          importedAccounts.has(String(item.stockAccountId)) &&
          (!item.cashAccountId || importedAccounts.has(String(item.cashAccountId))) &&
          (!item.securityId || importedStockSecurities.has(String(item.securityId))),
      )
      .map((item) => String(item.id)),
  );
  const importedInsuranceTransactions = new Set(data.insuranceTransactions.map((item) => String(item.id)));
  const importedWealthTransactions = new Set(data.wealthTransactions.map((item) => String(item.id)));
  const importedDepositTransactions = new Set(data.depositTransactions.map((item) => String(item.id)));
  const importedPreciousMetalTransactions = new Set(data.preciousMetalTransactions.map((item) => String(item.id)));
  const importedAiChannels = new Set(data.aiChannels.map((item) => String(item.id)));
  const hasIndependentFundTransactions = data.fundTransactions.length > 0;
  const isSplitFundProjection = (item: Record<string, unknown>) => {
    const productType = String(item.fundProductType ?? "");
    return (
      item.fundCode != null && isLegacyFundProductType(item.fundProductType)
    ) || (
      hasIndependentFundTransactions &&
      (
      productType === "fund" ||
      productType === "money" ||
      productType === "money_fund"
      )
    );
  };
  const legacyFundRows = hasIndependentFundTransactions
    ? []
    : data.transactions.filter((item) => (
        item.fundCode != null &&
        isLegacyFundProductType(item.fundProductType) &&
        importedAccounts.has(String(item.accountId))
      ));
  const legacyMainFundRows = legacyFundRows.filter((item) => !isLegacyFundRefundRow(item));
  const legacyMainFundIds = new Set(legacyMainFundRows.map((item) => String(item.id)));
  const legacyRefundRows = legacyFundRows.filter((item) => (
    isLegacyFundRefundRow(item) &&
    item.fundSourceEntryId != null &&
    legacyMainFundIds.has(String(item.fundSourceEntryId))
  ));

  await prisma.$transaction(async (tx) => {
    const currentUsers = await tx.user.findMany({
      where: { householdId },
      select: { id: true },
    });
    const currentAccounts = await tx.account.findMany({
      where: { householdId },
      select: { id: true },
    });

    const currentUserIds = currentUsers.map((item) => item.id);
    const currentAccountIds = currentAccounts.map((item) => item.id);

    await tx.systemSetting.deleteMany({ where: { key: { in: householdSystemSettingKeys(householdId) } } });
    await tx.attachment.deleteMany({ where: { transactions: { householdId } } });
    await tx.entryTag.deleteMany({ where: { transactions: { householdId } } });
    await tx.entryBusinessLink.deleteMany({ where: { householdId } });
    await tx.fundTransactionCashFlow.deleteMany({ where: { FundTransaction: { householdId } } });
    await tx.fxConversion.deleteMany({ where: { householdId } });
    await tx.fundTransaction.deleteMany({ where: { householdId } });
    await tx.insuranceTransaction.deleteMany({ where: { householdId } });
    await tx.wealthTransaction.deleteMany({ where: { householdId } });
    await tx.depositTransaction.deleteMany({ where: { householdId } });
    await tx.preciousMetalTransaction.deleteMany({ where: { householdId } });
    await tx.stockTransaction.deleteMany({ where: { householdId } });
    await tx.stockPriceCache.deleteMany({ where: { StockSecurity: { is: { householdId } } } });
    await tx.stockFeeRule.deleteMany({ where: { Account: { householdId } } });
    await tx.stockHolding.deleteMany({ where: { householdId } });
    await tx.stockSecurity.deleteMany({ where: { householdId } });
    await tx.creditCardInstallmentPlan.deleteMany({ where: { householdId } });
    await tx.loanRateAdjustment.deleteMany({ where: { householdId } });

    if (currentAccountIds.length > 0) {
      await tx.regularInvestPlan.deleteMany({
        where: {
          OR: [{ householdId }, { accountId: { in: currentAccountIds } }, { cashAccountId: { in: currentAccountIds } }],
        },
      });
      await tx.fundSnapshot.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundHolding.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.preciousMetalHolding.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.stockHolding.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.stockFeeRule.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.billOverride.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.accountAlias.deleteMany({ where: { accountId: { in: currentAccountIds } } });
    }

    await tx.undoOperation.deleteMany({ where: { householdId } });
    await tx.txRecord.deleteMany({ where: { householdId } });
    await tx.account.deleteMany({ where: { householdId } });
    await tx.insuranceProduct.deleteMany({ where: { householdId } });
    await tx.insuranceProductMaster.deleteMany({ where: { householdId } });
    await tx.wealthProduct.deleteMany({ where: { householdId } });
    await tx.importBatch.deleteMany({ where: { householdId } });
    await tx.fundQueryApi.deleteMany({ where: { householdId } });
    await tx.preciousMetalType.deleteMany({ where: { householdId } });
    await tx.preciousMetalUnit.deleteMany({ where: { householdId } });
    await tx.fxRate.deleteMany({ where: { householdId } });
    await tx.emailAccount.deleteMany({ where: { householdId } });
    await tx.tag.deleteMany({ where: { householdId } });
    await tx.category.deleteMany({ where: { householdId } });
    await tx.counterparty.deleteMany({ where: { householdId } });
    await tx.institution.deleteMany({ where: { householdId } });
    await tx.accountGroup.deleteMany({ where: { householdId } });

    if (currentUserIds.length > 0) {
      await tx.userSettings.deleteMany({ where: { userId: { in: currentUserIds } } });
      await tx.passwordResetToken.deleteMany({ where: { userId: { in: currentUserIds } } });
    }
    await tx.user.deleteMany({ where: { householdId } });

    await tx.household.update({
      where: { id: householdId },
      data: { name: String(data.household.name ?? payload.scope.householdName ?? "恢复账簿") },
    });

    for (const item of data.systemSettings) {
      const rawKey = String(item.key ?? "");
      const key = remapHouseholdSystemSettingKey(rawKey, payload.scope.householdId, householdId) ?? rawKey;
      if (!key) continue;
      const value = String(item.value ?? "");
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, value, updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date() },
        update: { value, updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date() },
      });
    }

    for (const item of data.accessKeys) {
      const id = String(item.id ?? "");
      if (!id) continue;
      const record = {
        id,
        name: String(item.name ?? ""),
        key: String(item.key ?? ""),
        createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
      };
      await tx.accessKey.upsert({
        where: { id },
        create: record,
        update: {
          name: record.name,
          key: record.key,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    for (const item of data.aiChannels) {
      const id = String(item.id ?? "");
      if (!id) continue;
      const record = {
        id,
        name: String(item.name ?? ""),
        channelType: String(item.channelType ?? "custom"),
        baseUrl: String(item.baseUrl ?? ""),
        apiKey: item.apiKey == null ? null : String(item.apiKey),
        createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
      };
      await tx.aiChannel.upsert({
        where: { id },
        create: record,
        update: {
          name: record.name,
          channelType: record.channelType,
          baseUrl: record.baseUrl,
          apiKey: record.apiKey,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    for (const item of data.aiModels.filter((model) => importedAiChannels.has(String(model.channelId)))) {
      const id = String(item.id ?? "");
      if (!id) continue;
      const record = {
        id,
        model: String(item.model ?? ""),
        name: item.name == null ? null : String(item.name),
        channelId: String(item.channelId),
        vision: Boolean(item.vision),
        active: Boolean(item.active),
        createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
      };
      await tx.aiModel.upsert({
        where: { id },
        create: record,
        update: {
          model: record.model,
          name: record.name,
          channelId: record.channelId,
          vision: record.vision,
          active: record.active,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    if (data.users.length > 0) {
      await tx.user.createMany({
        data: data.users.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? "user"),
          email: item.email == null ? null : String(item.email),
          role: String(item.role ?? "user"),
          isSystem: Boolean(item.isSystem),
          passwordHash: item.passwordHash == null ? null : String(item.passwordHash),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    if (data.userSettings.length > 0) {
      await tx.userSettings.createMany({
        data: data.userSettings
          .filter((item) => importedUserSet.has(String(item.userId)))
          .map((item) => ({
            id: String(item.id),
            userId: String(item.userId),
            emailHost: item.emailHost == null ? null : String(item.emailHost),
            emailPort: item.emailPort == null ? null : Number(item.emailPort),
            emailSecure: item.emailSecure == null ? true : Boolean(item.emailSecure),
            emailUser: item.emailUser == null ? null : String(item.emailUser),
            emailPassword: item.emailPassword == null ? null : String(item.emailPassword),
            emailMailbox: item.emailMailbox == null ? "INBOX" : String(item.emailMailbox),
            smtpHost: item.smtpHost == null ? null : String(item.smtpHost),
            smtpPort: item.smtpPort == null ? null : Number(item.smtpPort),
            smtpSecure: item.smtpSecure == null ? true : Boolean(item.smtpSecure),
            smtpUser: item.smtpUser == null ? null : String(item.smtpUser),
            smtpPass: item.smtpPass == null ? null : String(item.smtpPass),
            smtpFrom: item.smtpFrom == null ? null : String(item.smtpFrom),
            resendApiKey: item.resendApiKey == null ? null : String(item.resendApiKey),
            resendFrom: item.resendFrom == null ? null : String(item.resendFrom),
            colorScheme: item.colorScheme == null ? "red_up_green_down" : String(item.colorScheme),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.accountGroups.length > 0) {
      await tx.accountGroup.createMany({
        data: data.accountGroups.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          sortOrder: Number(item.sortOrder ?? 0),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    if (data.institutions.length > 0) {
      await tx.institution.createMany({
        data: data.institutions.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          shortName: item.shortName == null ? null : String(item.shortName),
          type: item.type == null ? null : String(item.type),
          householdId,
        })),
      });
    }

    if (data.counterparties.length > 0) {
      await createManyRecords(
        tx.counterparty,
        data.counterparties.map((item) => ({
          ...item,
          householdId,
          sourceInstitutionId:
            item.sourceInstitutionId && importedInstitutions.has(String(item.sourceInstitutionId))
              ? String(item.sourceInstitutionId)
              : null,
        })),
      );
    }

    if (data.categories.length > 0) {
      await tx.category.createMany({
        data: data.categories.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          type: String(item.type ?? "expense"),
          icon: item.icon == null ? null : String(item.icon),
          parentId: item.parentId == null ? null : String(item.parentId),
          householdId,
          isSystem: Boolean(item.isSystem),
        })),
      });
    }

    if (data.tags.length > 0) {
      await tx.tag.createMany({
        data: data.tags.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          color: item.color == null ? null : String(item.color),
          householdId,
        })),
      });
    }

    if (data.insuranceProductMasters.length > 0) {
      await createManyRecords(
        tx.insuranceProductMaster,
        data.insuranceProductMasters
          .filter((item) => importedInstitutions.has(String(item.institutionId)))
          .map((item) => ({ ...item, householdId })),
      );
    }

    if (data.wealthProducts.length > 0) {
      await createManyRecords(
        tx.wealthProduct,
        data.wealthProducts.map((item) => ({
          ...item,
          householdId,
          institutionId:
            item.institutionId && importedInstitutions.has(String(item.institutionId))
              ? String(item.institutionId)
              : null,
        })),
      );
    }

    if (data.fundQueryApis.length > 0) {
      await tx.fundQueryApi.createMany({
        data: data.fundQueryApis.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          code: String(item.code ?? ""),
          baseUrl: String(item.baseUrl ?? ""),
          apiKey: item.apiKey == null ? null : String(item.apiKey),
          priority: Number(item.priority ?? 0),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    if (data.preciousMetalTypes.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.preciousMetalType,
        data.preciousMetalTypes.map((item) => ({
          id: String(item.id),
          code: String(item.code ?? ""),
          name: String(item.name ?? ""),
          shortName: item.shortName == null ? null : String(item.shortName),
          sortOrder: Number(item.sortOrder ?? 0),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          isSystem: Boolean(item.isSystem),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.preciousMetalUnits.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.preciousMetalUnit,
        data.preciousMetalUnits.map((item) => ({
          id: String(item.id),
          code: String(item.code ?? ""),
          name: String(item.name ?? ""),
          symbol: item.symbol == null ? null : String(item.symbol),
          decimals: Number(item.decimals ?? 3),
          sortOrder: Number(item.sortOrder ?? 0),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          isSystem: Boolean(item.isSystem),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.accounts.length > 0) {
      await tx.account.createMany({
        data: data.accounts.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          balance: item.balance == null ? "0" : String(item.balance),
          kind: String(item.kind ?? "other") as never,
          debtDirection: item.debtDirection == null ? null : (String(item.debtDirection) as never),
          currency: item.currency == null ? "CNY" : String(item.currency),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          isPlaceholder: item.isPlaceholder == null ? false : Boolean(item.isPlaceholder),
          investProductType: item.investProductType == null ? null : (String(item.investProductType) as never),
          creditLimit: item.creditLimit == null ? null : String(item.creditLimit),
          billingDay: item.billingDay == null ? null : Number(item.billingDay),
          repaymentDay: item.repaymentDay == null ? null : Number(item.repaymentDay),
          creditBillMode: item.creditBillMode == null ? "separate" : (String(item.creditBillMode) as never),
          numberMasked: item.numberMasked == null ? null : String(item.numberMasked),
          routeKey: item.routeKey == null ? null : String(item.routeKey),
          note: item.note == null ? null : String(item.note),
          householdId,
          institutionId:
            item.institutionId && importedInstitutions.has(String(item.institutionId)) ? String(item.institutionId) : null,
          counterpartyId:
            item.counterpartyId && importedCounterparties.has(String(item.counterpartyId)) ? String(item.counterpartyId) : null,
          userId: item.userId && importedUserSet.has(String(item.userId)) ? String(item.userId) : null,
          groupId:
            item.groupId && importedAccountGroups.has(String(item.groupId))
              ? String(item.groupId)
              : restoreError(`备份文件缺少账户分组：${String(item.groupId ?? "")}`),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          costBasisMethod: item.costBasisMethod == null ? null : (String(item.costBasisMethod) as never),
          defaultConfirmDays: item.defaultConfirmDays == null ? null : Number(item.defaultConfirmDays),
          defaultArrivalDays: item.defaultArrivalDays == null ? null : Number(item.defaultArrivalDays),
          tradingCalendar: item.tradingCalendar == null ? null : (String(item.tradingCalendar) as never),
          defaultFundQueryApiId:
            item.defaultFundQueryApiId && importedFundQueryApis.has(String(item.defaultFundQueryApiId))
              ? String(item.defaultFundQueryApiId)
              : null,
          fundUnitsDecimals: item.fundUnitsDecimals == null ? 3 : Number(item.fundUnitsDecimals),
        })),
      });
    }

    if (data.accountAliases.length > 0) {
      await tx.accountAlias.createMany({
        data: data.accountAliases
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            alias: String(item.alias ?? ""),
            accountId: String(item.accountId),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.billOverrides.length > 0) {
      await tx.billOverride.createMany({
        data: data.billOverrides
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            statementMonth: String(item.statementMonth ?? ""),
            amount: item.amount == null ? "0" : String(item.amount),
            note: item.note == null ? null : String(item.note),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.creditCardCycles.length > 0) {
      await tx.creditCardCycle.createMany({
        data: data.creditCardCycles
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            statementMonth: String(item.statementMonth ?? ""),
            periodStart: new Date(String(item.periodStart)),
            periodEnd: new Date(String(item.periodEnd)),
            dueDate: item.dueDate == null ? null : new Date(String(item.dueDate)),
            expenseAbs: item.expenseAbs == null ? "0" : String(item.expenseAbs),
            income: item.income == null ? "0" : String(item.income),
            paid: item.paid == null ? "0" : String(item.paid),
            rawBill: item.rawBill == null ? "0" : String(item.rawBill),
            effectiveBill: item.effectiveBill == null ? "0" : String(item.effectiveBill),
            cumulativeRemain: item.cumulativeRemain == null ? "0" : String(item.cumulativeRemain),
            cumulativeOverpaid: item.cumulativeOverpaid == null ? "0" : String(item.cumulativeOverpaid),
            isCurrentCycle: item.isCurrentCycle == null ? false : Boolean(item.isCurrentCycle),
            isLocked: item.isLocked == null ? false : Boolean(item.isLocked),
            lockSource: item.lockSource == null ? null : String(item.lockSource),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.fundConfirmDays.length > 0) {
      await tx.fundConfirmDays.createMany({
        data: data.fundConfirmDays
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            fundCode: String(item.fundCode ?? ""),
            days: Number(item.days ?? 0),
            redeemCostDays: Number(item.redeemCostDays ?? 1),
            arrivalDays: Number(item.arrivalDays ?? 0),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
          })),
      });
    }

    if (data.fundFeeRates.length > 0) {
      await tx.fundFeeRate.createMany({
        data: data.fundFeeRates
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            fundCode: String(item.fundCode ?? ""),
            rate: item.rate == null ? "0" : String(item.rate),
            effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            feeType: String(item.feeType ?? "buy") as never,
          })),
      });
    }

    if (data.fundHoldings.length > 0) {
      await tx.fundHolding.createMany({
        data: data.fundHoldings
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            fundCode: String(item.fundCode ?? ""),
            fundName: item.fundName == null ? null : String(item.fundName),
            units: item.units == null ? "0" : String(item.units),
            avgCost: item.avgCost == null ? "0" : String(item.avgCost),
            cost: item.cost == null ? "0" : String(item.cost),
            nav: item.nav == null ? null : String(item.nav),
            pendingCost: item.pendingCost == null ? "0" : String(item.pendingCost),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            historicalProfit: item.historicalProfit == null ? "0" : String(item.historicalProfit),
          })),
      });
    }

    if (data.stockSecurities.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockSecurity,
        data.stockSecurities.map((item) => ({
          id: String(item.id),
          householdId,
          market: String(item.market ?? "CN"),
          stockCode: String(item.stockCode ?? ""),
          stockName: String(item.stockName ?? item.stockCode ?? ""),
          currency: item.currency == null ? "CNY" : String(item.currency),
          exchange: item.exchange == null ? null : String(item.exchange),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.stockHoldings.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockHolding,
        data.stockHoldings
          .filter((item) => importedAccounts.has(String(item.accountId)) && importedStockSecurities.has(String(item.securityId)))
          .map((item) => ({
            id: String(item.id),
            householdId,
            accountId: String(item.accountId),
            securityId: String(item.securityId),
            market: String(item.market ?? "CN"),
            stockCode: String(item.stockCode ?? ""),
            stockName: item.stockName == null ? null : String(item.stockName),
            quantity: item.quantity == null ? "0" : String(item.quantity),
            avgCost: item.avgCost == null ? "0" : String(item.avgCost),
            cost: item.cost == null ? "0" : String(item.cost),
            latestPrice: item.latestPrice == null ? null : String(item.latestPrice),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            historicalProfit: item.historicalProfit == null ? "0" : String(item.historicalProfit),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.stockPriceCache.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockPriceCache,
        data.stockPriceCache
          .filter((item) => !item.securityId || importedStockSecurities.has(String(item.securityId)))
          .map((item) => ({
            id: String(item.id),
            securityId: item.securityId && importedStockSecurities.has(String(item.securityId)) ? String(item.securityId) : null,
            market: String(item.market ?? "CN"),
            stockCode: String(item.stockCode ?? ""),
            priceDate: item.priceDate ? new Date(String(item.priceDate)) : new Date(),
            closePrice: item.closePrice == null ? "0" : String(item.closePrice),
            currency: item.currency == null ? "CNY" : String(item.currency),
            source: item.source == null ? "manual" : String(item.source),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.stockFeeRules.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockFeeRule,
        data.stockFeeRules
          .filter((item) => importedAccounts.has(String(item.accountId)) && (!item.securityId || importedStockSecurities.has(String(item.securityId))))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            securityId: item.securityId && importedStockSecurities.has(String(item.securityId)) ? String(item.securityId) : null,
            market: item.market == null ? null : String(item.market),
            stockCode: item.stockCode == null ? null : String(item.stockCode),
            feeType: String(item.feeType ?? "commission") as never,
            direction: String(item.direction ?? "both") as never,
            rate: item.rate == null ? null : String(item.rate),
            amount: item.amount == null ? null : String(item.amount),
            minAmount: item.minAmount == null ? null : String(item.minAmount),
            currency: item.currency == null ? "CNY" : String(item.currency),
            effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
            source: item.source == null ? "manual" : String(item.source),
            note: item.note == null ? null : String(item.note),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.preciousMetalHoldings.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.preciousMetalHolding,
        data.preciousMetalHoldings
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            householdId,
            metalTypeId: String(item.metalTypeId ?? ""),
            metalTypeName: String(item.metalTypeName ?? ""),
            metalUnitId: String(item.metalUnitId ?? ""),
            metalUnitName: String(item.metalUnitName ?? ""),
            quantity: item.quantity == null ? "0" : String(item.quantity),
            avgCost: item.avgCost == null ? "0" : String(item.avgCost),
            cost: item.cost == null ? "0" : String(item.cost),
            unitPrice: item.unitPrice == null ? null : String(item.unitPrice),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            historicalProfit: item.historicalProfit == null ? "0" : String(item.historicalProfit),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.fundSnapshots.length > 0) {
      await tx.fundSnapshot.createMany({
        data: data.fundSnapshots
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            snapshotDate: new Date(String(item.snapshotDate)),
            totalCost: item.totalCost == null ? "0" : String(item.totalCost),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            floatingPnL: item.floatingPnL == null ? "0" : String(item.floatingPnL),
            floatingPnLRate: item.floatingPnLRate == null ? "0" : String(item.floatingPnLRate),
            units: item.units == null ? "0" : String(item.units),
            nav: item.nav == null ? null : String(item.nav),
            source: item.source == null ? null : String(item.source),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    await createManyRecords(
      tx.fxRate,
      data.fxRates.map((item) => ({ ...item, householdId })),
    );

    await createManyRecords(
      tx.insuranceProduct,
      data.insuranceProducts
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          productMasterId:
            item.productMasterId && importedInsuranceProductMasters.has(String(item.productMasterId))
              ? String(item.productMasterId)
              : null,
          institutionId:
            item.institutionId && importedInstitutions.has(String(item.institutionId))
              ? String(item.institutionId)
              : null,
          ownerGroupId:
            item.ownerGroupId && importedAccountGroups.has(String(item.ownerGroupId))
              ? String(item.ownerGroupId)
              : null,
          policyholderPersonId:
            item.policyholderPersonId && importedInstitutions.has(String(item.policyholderPersonId))
              ? String(item.policyholderPersonId)
              : null,
          insuredUserId:
            item.insuredUserId && importedUserSet.has(String(item.insuredUserId))
              ? String(item.insuredUserId)
              : null,
          insuredPersonId:
            item.insuredPersonId && importedInstitutions.has(String(item.insuredPersonId))
              ? String(item.insuredPersonId)
              : null,
        })),
      new Set(["startDate", "effectiveDate", "maturityDate"]),
    );

    const installmentSourceEntries = new Map(
      data.creditCardInstallmentPlans.map((item) => [String(item.id), item.sourceEntryId]),
    );
    await createManyRecords(
      tx.creditCardInstallmentPlan,
      data.creditCardInstallmentPlans
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({ ...item, householdId, sourceEntryId: null })),
    );

    if (data.importBatches.length > 0) {
      await tx.importBatch.createMany({
        data: data.importBatches.map((item) => ({
          id: String(item.id),
          source: item.source == null ? null : String(item.source),
          note: item.note == null ? null : String(item.note),
          rawText: item.rawText == null ? null : String(item.rawText),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        })),
      });
    }

    if (data.transactions.length > 0) {
      await tx.txRecord.createMany({
        data: data.transactions
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            date: new Date(String(item.date)),
            postedAt: item.postedAt == null ? null : new Date(String(item.postedAt)),
            type: String(item.type ?? "expense") as never,
            amount: item.amount == null ? "0" : String(item.amount),
            accountId: String(item.accountId),
            accountName: String(item.accountName ?? ""),
            toAccountId: item.toAccountId && importedAccounts.has(String(item.toAccountId)) ? String(item.toAccountId) : null,
            toAccountName: item.toAccountName == null ? null : String(item.toAccountName),
            categoryId: item.categoryId && importedCategories.has(String(item.categoryId)) ? String(item.categoryId) : null,
            categoryName: item.categoryName == null ? null : String(item.categoryName),
            fundCode: null,
            fundProductType: isSplitFundProjection(item) || item.fundProductType == null ? null : (String(item.fundProductType) as never),
            metalTypeId:
              item.metalTypeId && importedPreciousMetalTypes.has(String(item.metalTypeId))
                ? String(item.metalTypeId)
                : null,
            metalTypeName: item.metalTypeName == null ? null : String(item.metalTypeName),
            metalUnitId:
              item.metalUnitId && importedPreciousMetalUnits.has(String(item.metalUnitId))
                ? String(item.metalUnitId)
                : null,
            metalUnitName: item.metalUnitName == null ? null : String(item.metalUnitName),
            metalQuantity: item.metalQuantity == null ? null : String(item.metalQuantity),
            metalUnitPrice: item.metalUnitPrice == null ? null : String(item.metalUnitPrice),
            metalFee: item.metalFee == null ? null : String(item.metalFee),
            confirmDate: item.confirmDate == null ? null : new Date(String(item.confirmDate)),
            statementMonth: item.statementMonth == null ? null : String(item.statementMonth),
            note: item.note == null ? null : String(item.note),
            toNote: item.toNote == null ? null : String(item.toNote),
            deletedAt: item.deletedAt == null ? null : new Date(String(item.deletedAt)),
            importBatchId:
              item.importBatchId && importedImportBatches.has(String(item.importBatchId)) ? String(item.importBatchId) : null,
            householdId,
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            dayOrder: Number(item.dayOrder ?? 0),
            currency: item.currency == null ? "CNY" : String(item.currency),
            paymentChannelId: item.paymentChannelId == null ? null : String(item.paymentChannelId),
            paymentChannelName: item.paymentChannelName == null ? null : String(item.paymentChannelName),
            counterpartyInstitutionId:
              item.counterpartyInstitutionId && importedInstitutions.has(String(item.counterpartyInstitutionId))
                ? String(item.counterpartyInstitutionId)
                : null,
            counterpartyInstitutionName:
              item.counterpartyInstitutionName == null ? null : String(item.counterpartyInstitutionName),
            status: String(item.status ?? "posted") as never,
            fundArrivalAmount: isSplitFundProjection(item) || item.fundArrivalAmount == null ? null : String(item.fundArrivalAmount),
            fundArrivalDate: isSplitFundProjection(item) || item.fundArrivalDate == null ? null : new Date(String(item.fundArrivalDate)),
            depositAnnualRate: item.depositAnnualRate == null ? null : String(item.depositAnnualRate),
            depositInterest: item.depositInterest == null ? null : String(item.depositInterest),
            depositSourceEntryId:
              item.depositSourceEntryId && importedTransactions.has(String(item.depositSourceEntryId))
                ? String(item.depositSourceEntryId)
                : null,
            fundSourceEntryId:
              item.fundSourceEntryId && importedTransactions.has(String(item.fundSourceEntryId))
                ? String(item.fundSourceEntryId)
                : null,
            debtPrincipalAmount: item.debtPrincipalAmount == null ? null : String(item.debtPrincipalAmount),
            debtInterestAmount: item.debtInterestAmount == null ? null : String(item.debtInterestAmount),
            debtFeeAmount: item.debtFeeAmount == null ? null : String(item.debtFeeAmount),
            fundConfirmDate: isSplitFundProjection(item) || item.fundConfirmDate == null ? null : new Date(String(item.fundConfirmDate)),
            fundFee: isSplitFundProjection(item) || item.fundFee == null ? null : String(item.fundFee),
            fundNav: isSplitFundProjection(item) || item.fundNav == null ? null : String(item.fundNav),
            fundSubtype: isSplitFundProjection(item) || item.fundSubtype == null ? null : (String(item.fundSubtype) as never),
            fundUnits: isSplitFundProjection(item) || item.fundUnits == null ? null : String(item.fundUnits),
            realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
            regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
            creditCardInstallmentPlanId:
              item.creditCardInstallmentPlanId && importedCreditCardInstallmentPlans.has(String(item.creditCardInstallmentPlanId))
                ? String(item.creditCardInstallmentPlanId)
                : null,
            installmentNo: item.installmentNo == null ? null : Number(item.installmentNo),
            installmentTotal: item.installmentTotal == null ? null : Number(item.installmentTotal),
            installmentPrincipal: item.installmentPrincipal == null ? null : String(item.installmentPrincipal),
            installmentInterest: item.installmentInterest == null ? null : String(item.installmentInterest),
            installmentRole: item.installmentRole == null ? null : String(item.installmentRole),
            fundName: isSplitFundProjection(item) || item.fundName == null ? null : String(item.fundName),
            wealthProductId:
              item.wealthProductId && importedWealthProducts.has(String(item.wealthProductId))
                ? String(item.wealthProductId)
                : null,
            insuranceProductId:
              item.insuranceProductId && importedInsuranceProducts.has(String(item.insuranceProductId))
                ? String(item.insuranceProductId)
                : null,
            insuranceAction: item.insuranceAction == null ? null : String(item.insuranceAction),
            insuranceProductName: item.insuranceProductName == null ? null : String(item.insuranceProductName),
            source: item.source == null ? null : String(item.source),
          })),
      });
    }

    if (legacyMainFundRows.length > 0) {
      const legacyFundTransactions: Record<string, unknown>[] = legacyMainFundRows
        .flatMap((item) => {
          const fundAccountId = legacyFundAccountIdOf(item);
          if (!fundAccountId || !importedAccounts.has(fundAccountId)) return [];
          const cashAccountId = legacyFundCashAccountIdOf(item, importedAccounts);
          const subtype = normalizeLegacyFundSubtype(item.fundSubtype);
          const cashReceipt = isLegacyFundCashReceipt(item);
          return [{
            id: String(item.id),
            householdId,
            fundAccountId,
            cashAccountId,
            cashEntryId: importedTransactions.has(String(item.id)) ? String(item.id) : null,
            fundCode: String(item.fundCode),
            fundName: item.fundName == null ? null : String(item.fundName),
            fundProductType: normalizeLegacyFundProductType(item.fundProductType),
            fundSubtype: subtype,
            source: item.source == null ? null : String(item.source),
            applyDate: new Date(String(item.date)),
            confirmDate: legacyDate(item.fundConfirmDate),
            arrivalDate: legacyDate(item.fundArrivalDate),
            grossAmount: absDecimalString(item.amount),
            refundAmount: "0",
            arrivalAmount: item.fundArrivalAmount == null && !cashReceipt ? null : absDecimalString(item.fundArrivalAmount ?? item.amount),
            fee: item.fundFee == null ? null : String(item.fundFee),
            nav: item.fundNav == null ? null : String(item.fundNav),
            units: item.fundUnits == null ? null : String(item.fundUnits),
            realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
            regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
            note: item.note == null ? null : String(item.note),
            deletedAt: legacyDate(item.deletedAt),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          }];
        });

      await createManyRecords(
        tx.fundTransaction,
        legacyFundTransactions,
        new Set(["confirmDate", "arrivalDate", "deletedAt"]),
      );
      for (const item of legacyFundTransactions) importedFundTransactions.add(String(item.id));

      const legacyCashFlows = [
        ...legacyMainFundRows
          .filter((item) => legacyMainFundIds.has(String(item.id)))
          .map((item) => ({
            id: `cff_${String(item.id)}`,
            fundTransactionId: String(item.id),
            txRecordId: String(item.id),
            kind: legacyFundCashFlowKindOf(item),
            amount: absDecimalString(item.fundArrivalAmount ?? item.amount),
            flowDate: isLegacyFundCashReceipt(item)
              ? legacyDate(item.fundArrivalDate) ?? new Date(String(item.date))
              : new Date(String(item.date)),
            accountId: legacyFundCashAccountIdOf(item, importedAccounts),
          })),
        ...legacyRefundRows.map((item) => ({
          id: `cfr_${String(item.id)}`,
          fundTransactionId: String(item.fundSourceEntryId),
          txRecordId: String(item.id),
          kind: "refund_in",
          amount: absDecimalString(item.fundArrivalAmount ?? item.amount),
          flowDate: legacyDate(item.fundArrivalDate) ?? new Date(String(item.date)),
          accountId: legacyFundCashAccountIdOf(item, importedAccounts),
        })),
      ].filter((item) => importedFundTransactions.has(String(item.fundTransactionId)));

      await createManyRecords(tx.fundTransactionCashFlow, legacyCashFlows);

      const refundSummary = new Map<string, { amount: number; arrivalDate: Date | null }>();
      for (const refund of legacyRefundRows) {
        const sourceId = String(refund.fundSourceEntryId);
        if (!importedFundTransactions.has(sourceId)) continue;
        const current = refundSummary.get(sourceId) ?? { amount: 0, arrivalDate: null };
        current.amount += Number(absDecimalString(refund.fundArrivalAmount ?? refund.amount));
        const arrivalDate = legacyDate(refund.fundArrivalDate) ?? legacyDate(refund.date);
        if (arrivalDate && (!current.arrivalDate || arrivalDate > current.arrivalDate)) current.arrivalDate = arrivalDate;
        refundSummary.set(sourceId, current);
      }
      for (const [fundTransactionId, summary] of refundSummary.entries()) {
        await tx.fundTransaction.updateMany({
          where: { id: fundTransactionId, householdId },
          data: {
            refundAmount: String(summary.amount),
            arrivalDate: summary.arrivalDate,
          },
        });
      }

      for (const flow of legacyCashFlows) {
        await upsertEntryBusinessCashFlowLink(tx, {
          householdId,
          cashEntryId: String(flow.txRecordId),
          fundTransactionId: String(flow.fundTransactionId),
          businessType: "fund",
          cashFlowDirection: String(flow.kind) === "buy_out" ? "outflow" : String(flow.kind) === "dividend_reinvest_internal" ? "internal" : "inflow",
          source: "backup_restore_legacy",
          note: "Restored legacy fund cash flow link",
          metadata: {
            splitRecord: true,
            independentBusinessTransaction: true,
            restoredFromLegacyTxRecord: true,
          },
        });
      }
    }

    for (const [planId, sourceEntryId] of installmentSourceEntries.entries()) {
      if (sourceEntryId && importedTransactions.has(String(sourceEntryId))) {
        await tx.creditCardInstallmentPlan.updateMany({
          where: { id: planId, householdId },
          data: { sourceEntryId: String(sourceEntryId) },
        });
      }
    }

    await createManyRecords(
      tx.fxConversion,
      data.fxConversions
        .filter(
          (item) =>
            importedTransactions.has(String(item.fromEntryId)) &&
            importedTransactions.has(String(item.toEntryId)) &&
            importedAccounts.has(String(item.fromAccountId)) &&
            importedAccounts.has(String(item.toAccountId)),
        )
        .map((item) => ({ ...item, householdId })),
    );

    await createManyRecords(
      tx.fundTransaction,
      data.fundTransactions
        .filter((item) => importedAccounts.has(String(item.fundAccountId)))
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
        })),
      new Set(["confirmDate", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.insuranceTransaction,
      data.insuranceTransactions
        .filter(
          (item) =>
            importedAccounts.has(String(item.accountId)) &&
            importedInsuranceProducts.has(String(item.insuranceProductId)),
        )
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
        })),
      new Set(["postedAt", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.wealthTransaction,
      data.wealthTransactions
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          wealthProductId:
            item.wealthProductId && importedWealthProducts.has(String(item.wealthProductId))
              ? String(item.wealthProductId)
              : null,
        })),
      new Set(["confirmDate", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.depositTransaction,
      data.depositTransactions
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          sourceDepositTransactionId:
            item.sourceDepositTransactionId && importedDepositTransactions.has(String(item.sourceDepositTransactionId))
              ? String(item.sourceDepositTransactionId)
              : null,
        })),
      new Set(["maturityDate", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.preciousMetalTransaction,
      data.preciousMetalTransactions
        .filter(
          (item) =>
            importedAccounts.has(String(item.accountId)) &&
            importedPreciousMetalTypes.has(String(item.metalTypeId)) &&
            importedPreciousMetalUnits.has(String(item.metalUnitId)),
        )
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
        })),
      new Set(["deletedAt"]),
    );

    await createManyRecords(
      tx.stockTransaction,
      data.stockTransactions
        .filter(
          (item) =>
            importedAccounts.has(String(item.stockAccountId)) &&
            (!item.cashAccountId || importedAccounts.has(String(item.cashAccountId))) &&
            (!item.securityId || importedStockSecurities.has(String(item.securityId))),
        )
        .map((item) => ({
          ...item,
          householdId,
          stockAccountId: String(item.stockAccountId),
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          securityId:
            item.securityId && importedStockSecurities.has(String(item.securityId))
              ? String(item.securityId)
              : null,
          market: String(item.market ?? "CN"),
          stockCode: String(item.stockCode ?? ""),
          stockName: item.stockName == null ? null : String(item.stockName),
          action: String(item.action ?? "buy") as never,
          source: item.source == null ? "manual" : String(item.source),
          grossAmount: item.grossAmount == null ? "0" : String(item.grossAmount),
          netAmount: item.netAmount == null ? null : String(item.netAmount),
          quantity: item.quantity == null ? null : String(item.quantity),
          price: item.price == null ? null : String(item.price),
          fee: item.fee == null ? null : String(item.fee),
          commission: item.commission == null ? null : String(item.commission),
          stampTax: item.stampTax == null ? null : String(item.stampTax),
          transferFee: item.transferFee == null ? null : String(item.transferFee),
          exchangeFee: item.exchangeFee == null ? null : String(item.exchangeFee),
          regulatoryFee: item.regulatoryFee == null ? null : String(item.regulatoryFee),
          otherFee: item.otherFee == null ? null : String(item.otherFee),
          realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
          externalLinkId: item.externalLinkId == null ? null : String(item.externalLinkId),
          brokerTradeId: item.brokerTradeId == null ? null : String(item.brokerTradeId),
          note: item.note == null ? null : String(item.note),
        })),
      new Set(["settleDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.fundTransactionCashFlow,
      data.fundTransactionCashFlows
        .filter(
          (item) =>
            importedFundTransactions.has(String(item.fundTransactionId)) &&
            importedTransactions.has(String(item.txRecordId)),
        )
        .map((item) => ({
          ...item,
          accountId:
            item.accountId && importedAccounts.has(String(item.accountId))
              ? String(item.accountId)
              : null,
        })),
    );

    await createManyRecords(
      tx.entryBusinessLink,
      data.entryBusinessLinks.map((item) => ({
        ...item,
        householdId,
        cashEntryId:
          item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
            ? String(item.cashEntryId)
            : null,
        businessEntryId:
          item.businessEntryId && importedTransactions.has(String(item.businessEntryId))
            ? String(item.businessEntryId)
            : null,
        fundTransactionId:
          item.fundTransactionId && importedFundTransactions.has(String(item.fundTransactionId))
            ? String(item.fundTransactionId)
            : null,
        insuranceTransactionId:
          item.insuranceTransactionId && importedInsuranceTransactions.has(String(item.insuranceTransactionId))
            ? String(item.insuranceTransactionId)
            : null,
        wealthTransactionId:
          item.wealthTransactionId && importedWealthTransactions.has(String(item.wealthTransactionId))
            ? String(item.wealthTransactionId)
            : null,
        depositTransactionId:
          item.depositTransactionId && importedDepositTransactions.has(String(item.depositTransactionId))
            ? String(item.depositTransactionId)
            : null,
        preciousMetalTransactionId:
          item.preciousMetalTransactionId && importedPreciousMetalTransactions.has(String(item.preciousMetalTransactionId))
            ? String(item.preciousMetalTransactionId)
            : null,
        stockTransactionId:
          item.stockTransactionId && importedStockTransactions.has(String(item.stockTransactionId))
            ? String(item.stockTransactionId)
            : null,
      })),
      new Set(["deletedAt"]),
    );

    if (data.attachments.length > 0) {
      await tx.attachment.createMany({
        data: data.attachments
          .filter((item) => importedTransactions.has(String(item.entryId)))
          .map((item) => ({
            id: String(item.id),
            name: item.name == null ? null : String(item.name),
            mimeType: item.mimeType == null ? null : String(item.mimeType),
            url: item.url == null ? null : String(item.url),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            entryId: String(item.entryId),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.entryTags.length > 0) {
      await tx.entryTag.createMany({
        data: data.entryTags
          .filter((item) => importedTransactions.has(String(item.entryId)) && importedTags.has(String(item.tagId)))
          .map((item) => ({
            entryId: String(item.entryId),
            tagId: String(item.tagId),
          })),
      });
    }

    if (data.regularInvestPlans.length > 0) {
      await tx.regularInvestPlan.createMany({
        data: data.regularInvestPlans
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            cashAccountId:
              item.cashAccountId && importedAccounts.has(String(item.cashAccountId)) ? String(item.cashAccountId) : null,
            fundCode: String(item.fundCode ?? ""),
            fundName: item.fundName == null ? null : String(item.fundName),
            amount: item.amount == null ? "0" : String(item.amount),
            intervalUnit: String(item.intervalUnit ?? "month") as never,
            intervalValue: Number(item.intervalValue ?? 1),
            nextRunDate: new Date(String(item.nextRunDate)),
            lastRunDate: item.lastRunDate == null ? null : new Date(String(item.lastRunDate)),
            feeRate: item.feeRate == null ? null : String(item.feeRate),
            confirmDays: item.confirmDays == null ? null : Number(item.confirmDays),
            arrivalDays: item.arrivalDays == null ? 2 : Number(item.arrivalDays),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            accountName: String(item.accountName ?? ""),
            cashAccountName: item.cashAccountName == null ? null : String(item.cashAccountName),
            endDate: item.endDate == null ? null : new Date(String(item.endDate)),
            executedRuns: Number(item.executedRuns ?? 0),
            fundProductType: item.fundProductType == null ? null : (String(item.fundProductType) as never),
            taskType: item.taskType == null ? null : String(item.taskType),
            targetName: item.targetName == null ? null : String(item.targetName),
            insuranceProductName: item.insuranceProductName == null ? null : String(item.insuranceProductName),
            memo: item.memo == null ? null : String(item.memo),
            startDate: new Date(String(item.startDate)),
            status: String(item.status ?? "active") as never,
            totalRuns: item.totalRuns == null ? null : Number(item.totalRuns),
            executionDay: item.executionDay == null ? null : Number(item.executionDay),
            skipPendingPreceding: item.skipPendingPreceding == null ? true : Boolean(item.skipPendingPreceding),
            householdId,
          })),
      });
    }

    await createManyRecords(
      tx.loanRateAdjustment,
      data.loanRateAdjustments
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          regularInvestPlanId:
            item.regularInvestPlanId && data.regularInvestPlans.some((plan) => String(plan.id) === String(item.regularInvestPlanId))
              ? String(item.regularInvestPlanId)
              : null,
        })),
    );

    if (data.emailAccounts.length > 0) {
      await tx.emailAccount.createMany({
        data: data.emailAccounts.map((item) => ({
          id: String(item.id),
          householdId,
          label: String(item.label ?? ""),
          username: String(item.username ?? ""),
          imapHost: String(item.imapHost ?? ""),
          imapPort: Number(item.imapPort ?? 993),
          imapSecure: item.imapSecure == null ? true : Boolean(item.imapSecure),
          outboundType: String(item.outboundType ?? "smtp"),
          smtpHost: item.smtpHost == null ? null : String(item.smtpHost),
          smtpPort: item.smtpPort == null ? null : Number(item.smtpPort),
          smtpSecure: item.smtpSecure == null ? null : Boolean(item.smtpSecure),
          smtpFrom: item.smtpFrom == null ? null : String(item.smtpFrom),
          resendApiKey: item.resendApiKey == null ? null : String(item.resendApiKey),
          resendFrom: item.resendFrom == null ? null : String(item.resendFrom),
          password: String(item.password ?? ""),
          mailbox: item.mailbox == null ? "INBOX" : String(item.mailbox),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    const hasAdmin = await tx.user.count({ where: { householdId, role: "admin" } });
    if (!hasAdmin && options.fallbackAdmin) {
      await tx.user.create({
        data: {
          name: options.fallbackAdmin.name,
          role: options.fallbackAdmin.role || "admin",
          isSystem: options.fallbackAdmin.isSystem,
          email: options.fallbackAdmin.email ?? null,
          passwordHash: options.fallbackAdmin.passwordHash ?? null,
          householdId,
        },
      });
    }
  });

  const { clearMasterKeyCache } = await import("@/lib/auth/encrypt");
  clearMasterKeyCache();

  return {
    householdName: payload.scope.householdName,
    counts: {
      users: data.users.length,
      accounts: data.accounts.length,
      transactions: data.transactions.length,
      categories: data.categories.length,
      tags: data.tags.length,
      institutions: data.institutions.length,
      emailAccounts: data.emailAccounts.length,
      regularInvestPlans: data.regularInvestPlans.length,
    },
  };
}
