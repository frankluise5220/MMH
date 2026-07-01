import { prisma } from "@/lib/db/prisma";
import type { CurrentUser } from "@/lib/server/auth";

export const BACKUP_FORMAT_VERSION = 2;

type ExportedBy = Pick<CurrentUser, "id" | "name" | "role"> | null;

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
  ];
}

function sheetRows<T extends Record<string, unknown>>(records: T[]) {
  return records.map((record) => toPlainRecord(record));
}

const TRANSACTION_EXPORT_LABELS: Record<string, string> = {
  id: "记录ID",
  date: "日期",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  type: "类型",
  amount: "金额",
  accountId: "账户ID",
  accountName: "账户名称",
  toAccountId: "对向账户ID",
  toAccountName: "对向账户名称",
  categoryId: "分类ID",
  categoryName: "分类",
  note: "备注",
  toNote: "第二备注",
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

export function buildBackupFileName(householdName: string, exportedAt: Date, format: "json" | "xlsx") {
  const suffix = format === "json" ? "json" : "xlsx";
  return `${safeFilePart(householdName)}-backup-${exportedAt.toISOString().replace(/[:.]/g, "-")}.${suffix}`;
}

export async function buildHouseholdBackupPayload(householdId: string, exportedBy: ExportedBy) {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
  });
  if (!household) {
    restoreError("当前账簿不存在");
  }

  const [
    users,
    accountGroups,
    institutions,
    counterparties,
    categories,
    tags,
    accounts,
    regularInvestPlans,
    fundQueryApis,
    importBatches,
    transactions,
    emailAccounts,
  ] = await Promise.all([
    prisma.user.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.accountGroup.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.institution.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.counterparty.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.category.findMany({ where: { householdId }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.tag.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.account.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.regularInvestPlan.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.fundQueryApi.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.importBatch.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.txRecord.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.emailAccount.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
  ]);

  const userIds = users.map((item) => item.id);
  const accountIds = accounts.map((item) => item.id);
  const entryIds = transactions.map((item) => item.id);

  const [
    userSettings,
    accountAliases,
    billOverrides,
    creditCardCycles,
    fundConfirmDays,
    fundFeeRates,
    fundHoldings,
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
      ? prisma.fundSnapshot.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    entryIds.length > 0
      ? prisma.attachment.findMany({ where: { entryId: { in: entryIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    entryIds.length > 0
      ? prisma.entryTag.findMany({ where: { entryId: { in: entryIds } }, orderBy: [{ entryId: "asc" }, { tagId: "asc" }] })
      : Promise.resolve([]),
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
    },
    data: {
      household,
      users,
      userSettings,
      accountGroups,
      institutions,
      counterparties,
      categories,
      tags,
      accounts,
      accountAliases,
      billOverrides,
      creditCardCycles,
      fundConfirmDays,
      fundFeeRates,
      fundHoldings,
      fundQueryApis,
      fundSnapshots,
      regularInvestPlans,
      importBatches,
      transactions,
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
    ["Users", sheetRows(payload.data.users)],
    ["UserSettings", sheetRows(payload.data.userSettings)],
    ["AccountGroups", sheetRows(payload.data.accountGroups)],
    ["Institutions", sheetRows(payload.data.institutions)],
    ["Counterparties", sheetRows(payload.data.counterparties)],
    ["Categories", sheetRows(payload.data.categories)],
    ["Tags", sheetRows(payload.data.tags)],
    ["Accounts", sheetRows(payload.data.accounts)],
    ["AccountAliases", sheetRows(payload.data.accountAliases)],
    ["BillOverrides", sheetRows(payload.data.billOverrides)],
    ["CreditCardCycles", sheetRows(payload.data.creditCardCycles)],
    ["FundConfirmDays", sheetRows(payload.data.fundConfirmDays)],
    ["FundFeeRates", sheetRows(payload.data.fundFeeRates)],
    ["FundHoldings", sheetRows(payload.data.fundHoldings)],
    ["FundQueryApis", sheetRows(payload.data.fundQueryApis)],
    ["FundSnapshots", sheetRows(payload.data.fundSnapshots)],
    ["RegularInvestPlans", sheetRows(payload.data.regularInvestPlans)],
    ["ImportBatches", sheetRows(payload.data.importBatches)],
    ["Transactions", labelTransactionRows(payload.data.transactions as Record<string, unknown>[])],
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
      users: ensureArray(data.users ?? [], "data.users"),
      userSettings: ensureArray(data.userSettings ?? [], "data.userSettings"),
      accountGroups: ensureArray(data.accountGroups ?? [], "data.accountGroups"),
      institutions: ensureArray(data.institutions ?? [], "data.institutions"),
      counterparties: ensureArray(data.counterparties ?? [], "data.counterparties"),
      categories: ensureArray(data.categories ?? [], "data.categories"),
      tags: ensureArray(data.tags ?? [], "data.tags"),
      accounts: ensureArray(data.accounts ?? [], "data.accounts"),
      accountAliases: ensureArray(data.accountAliases ?? [], "data.accountAliases"),
      billOverrides: ensureArray(data.billOverrides ?? [], "data.billOverrides"),
      creditCardCycles: ensureArray(data.creditCardCycles ?? [], "data.creditCardCycles"),
      fundConfirmDays: ensureArray(data.fundConfirmDays ?? [], "data.fundConfirmDays"),
      fundFeeRates: ensureArray(data.fundFeeRates ?? [], "data.fundFeeRates"),
      fundHoldings: ensureArray(data.fundHoldings ?? [], "data.fundHoldings"),
      fundQueryApis: ensureArray(data.fundQueryApis ?? [], "data.fundQueryApis"),
      fundSnapshots: ensureArray(data.fundSnapshots ?? [], "data.fundSnapshots"),
      regularInvestPlans: ensureArray(data.regularInvestPlans ?? [], "data.regularInvestPlans"),
      importBatches: ensureArray(data.importBatches ?? [], "data.importBatches"),
      transactions: ensureArray(data.transactions ?? [], "data.transactions"),
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

  await prisma.$transaction(async (tx) => {
    const currentUsers = await tx.user.findMany({
      where: { householdId },
      select: { id: true },
    });
    const currentAccounts = await tx.account.findMany({
      where: { householdId },
      select: { id: true },
    });
    const currentTransactions = await tx.txRecord.findMany({
      where: { householdId },
      select: { id: true },
    });

    const currentUserIds = currentUsers.map((item) => item.id);
    const currentAccountIds = currentAccounts.map((item) => item.id);
    const currentTransactionIds = currentTransactions.map((item) => item.id);

    if (currentTransactionIds.length > 0) {
      await tx.attachment.deleteMany({ where: { entryId: { in: currentTransactionIds } } });
      await tx.entryTag.deleteMany({ where: { entryId: { in: currentTransactionIds } } });
    }

    if (currentAccountIds.length > 0) {
      await tx.regularInvestPlan.deleteMany({
        where: {
          OR: [{ householdId }, { accountId: { in: currentAccountIds } }, { cashAccountId: { in: currentAccountIds } }],
        },
      });
      await tx.fundSnapshot.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundHolding.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.billOverride.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.accountAlias.deleteMany({ where: { accountId: { in: currentAccountIds } } });
    }

    await tx.txRecord.deleteMany({ where: { householdId } });
    await tx.account.deleteMany({ where: { householdId } });
    await tx.importBatch.deleteMany({ where: { householdId } });
    await tx.fundQueryApi.deleteMany({ where: { householdId } });
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
          type: item.type == null ? null : String(item.type),
          householdId,
        })),
      });
    }

    if (data.counterparties.length > 0) {
      await tx.counterparty.createMany({
        data: data.counterparties.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          shortName: item.shortName == null ? null : String(item.shortName),
          type: item.type == null ? null : String(item.type),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
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
          numberMasked: item.numberMasked == null ? null : String(item.numberMasked),
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
          defaultFundQueryApiId:
            item.defaultFundQueryApiId && importedFundQueryApis.has(String(item.defaultFundQueryApiId))
              ? String(item.defaultFundQueryApiId)
              : null,
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
            type: String(item.type ?? "expense") as never,
            amount: item.amount == null ? "0" : String(item.amount),
            accountId: String(item.accountId),
            accountName: String(item.accountName ?? ""),
            toAccountId: item.toAccountId && importedAccounts.has(String(item.toAccountId)) ? String(item.toAccountId) : null,
            toAccountName: item.toAccountName == null ? null : String(item.toAccountName),
            categoryId: item.categoryId && importedCategories.has(String(item.categoryId)) ? String(item.categoryId) : null,
            categoryName: item.categoryName == null ? null : String(item.categoryName),
            fundCode: item.fundCode == null ? null : String(item.fundCode),
            fundProductType: item.fundProductType == null ? null : (String(item.fundProductType) as never),
            confirmDate: item.confirmDate == null ? null : new Date(String(item.confirmDate)),
            statementMonth: item.statementMonth == null ? null : String(item.statementMonth),
            note: item.note == null ? null : String(item.note),
            deletedAt: item.deletedAt == null ? null : new Date(String(item.deletedAt)),
            importBatchId:
              item.importBatchId && importedImportBatches.has(String(item.importBatchId)) ? String(item.importBatchId) : null,
            householdId,
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            currency: item.currency == null ? "CNY" : String(item.currency),
            paymentChannelId: item.paymentChannelId == null ? null : String(item.paymentChannelId),
            paymentChannelName: item.paymentChannelName == null ? null : String(item.paymentChannelName),
            status: String(item.status ?? "posted") as never,
            fundArrivalAmount: item.fundArrivalAmount == null ? null : String(item.fundArrivalAmount),
            fundArrivalDate: item.fundArrivalDate == null ? null : new Date(String(item.fundArrivalDate)),
            fundConfirmDate: item.fundConfirmDate == null ? null : new Date(String(item.fundConfirmDate)),
            fundFee: item.fundFee == null ? null : String(item.fundFee),
            fundNav: item.fundNav == null ? null : String(item.fundNav),
            fundSubtype: item.fundSubtype == null ? null : (String(item.fundSubtype) as never),
            fundUnits: item.fundUnits == null ? null : String(item.fundUnits),
            realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
            regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
            fundName: item.fundName == null ? null : String(item.fundName),
            source: item.source == null ? null : String(item.source),
          })),
      });
    }

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

  return {
    householdName: payload.scope.householdName,
    counts: {
      users: data.users.length,
      accounts: data.accounts.length,
      transactions: data.transactions.length,
      categories: data.categories.length,
      tags: data.tags.length,
      institutions: data.institutions.length,
      counterparties: data.counterparties.length,
      emailAccounts: data.emailAccounts.length,
      regularInvestPlans: data.regularInvestPlans.length,
    },
  };
}
