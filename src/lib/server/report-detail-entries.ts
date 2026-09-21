import type { DetailEntry } from "@/components/DetailViewClient";
import { prisma } from "@/lib/db/prisma";
import { formatDateLocal, toNumber } from "@/lib/date-utils";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import type { HouseholdContext } from "@/lib/server/household-scope";

export type ReportDetailEntryOverrides = {
  categoryByEntryId: ReadonlyMap<string, string>;
  realizedProfitByEntryId: ReadonlyMap<string, number | null>;
  accountByEntryId: ReadonlyMap<string, { accountId: string; accountName: string }>;
};

/**
 * The income/expense report already classifies each detail row, including the
 * auto-posted bond/deposit yield rows whose raw category snapshot is empty or
 * incomplete. Reuse that computed view instead of re-reading the raw fields.
 */
export function buildReportDetailEntryOverrides(
  rows: ReadonlyArray<{
    entryId: string;
    categoryName?: string | null;
    realizedProfit?: number | null;
    accountId?: string | null;
    accountName?: string | null;
  }>,
): ReportDetailEntryOverrides {
  const categoryByEntryId = new Map<string, string>();
  const realizedProfitByEntryId = new Map<string, number | null>();
  const accountByEntryId = new Map<string, { accountId: string; accountName: string }>();

  for (const row of rows) {
    const categoryName = row.categoryName?.trim() ?? "";
    if (categoryName && !categoryByEntryId.has(row.entryId)) {
      categoryByEntryId.set(row.entryId, categoryName);
    }
    if (row.realizedProfit != null) {
      // One TxRecord can produce several report rows (for example fund
      // redemption splits). The detail table renders the record once, so the
      // first non-null row result is the display value; summing duplicates
      // would turn one realized result into a much larger fake total.
      if (!realizedProfitByEntryId.has(row.entryId)) {
        realizedProfitByEntryId.set(row.entryId, row.realizedProfit);
      }
      // 经济收益行（基金/理财赎回收益、分红、债券/存款利息）归属投资账户侧；
      // 原始流水可能记在收款现金账户上（如赎回款到账余额宝），明细列表需要
      // 与报告保持同一归属口径。
      const accountId = row.accountId?.trim() ?? "";
      const accountName = row.accountName?.trim() ?? "";
      if (accountId && accountName && !accountByEntryId.has(row.entryId)) {
        accountByEntryId.set(row.entryId, { accountId, accountName });
      }
    }
  }

  return { categoryByEntryId, realizedProfitByEntryId, accountByEntryId };
}

export async function loadReportDetailEntries(
  ctx: HouseholdContext,
  entryIds: string[],
  overrides?: ReportDetailEntryOverrides,
): Promise<DetailEntry[]> {
  const uniqueEntryIds = [...new Set(entryIds)].filter(Boolean);
  if (uniqueEntryIds.length === 0) return [];

  const records = await prisma.txRecord.findMany({
    where: {
      ...ctx.hidFilter,
      deletedAt: null,
      id: { in: uniqueEntryIds },
    },
    include: {
      EntryTag: { include: { Tag: true } },
      Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
      ...entryBusinessLinkSummaryInclude,
      account: { include: { Institution: { select: { name: true } } } },
      toAccount: { include: { Institution: { select: { name: true } } } },
    },
  });

  // 经济收益明细在报告中归属投资账户，而原始流水可能记在收款现金账户上。
  // 这里把覆盖账户一次性查出，让明细列表与报告的账户口径一致。
  const overrideAccountIds = new Set<string>();
  for (const record of records) {
    const override = overrides?.accountByEntryId.get(record.id);
    if (override && override.accountId !== record.accountId) {
      overrideAccountIds.add(override.accountId);
    }
  }
  const overrideAccountById = new Map<string, NonNullable<typeof records[number]["account"]>>();
  if (overrideAccountIds.size > 0) {
    const overrideAccounts = await prisma.account.findMany({
      where: {
        ...ctx.hidFilter,
        id: { in: [...overrideAccountIds] },
      },
      include: { Institution: { select: { name: true } } },
    });
    for (const account of overrideAccounts) {
      overrideAccountById.set(account.id, account);
    }
  }

  const detailEntryById = new Map<string, DetailEntry>(records.map((record) => {
    const categoryName = overrides?.categoryByEntryId.has(record.id)
      ? overrides.categoryByEntryId.get(record.id) ?? null
      : record.categoryName;
    const realizedProfit = overrides?.realizedProfitByEntryId.has(record.id)
      ? overrides.realizedProfitByEntryId.get(record.id) ?? null
      : record.realizedProfit == null
        ? (record.fundSubtype === "redeem" || record.fundSubtype === "switch_out"
          ? (record.depositInterest == null ? null : toNumber(record.depositInterest))
          : null)
        : toNumber(record.realizedProfit);

    // 与报告口径一致的展示账户：覆盖账户优先；原始账户若只是收款侧，
    // 且流水没有 toAccount，则把原账户补到对账侧，保留资金去向信息。
    const overrideAccount = overrideAccountById.get(
      overrides?.accountByEntryId.get(record.id)?.accountId ?? "",
    );
    const displayAccount = overrideAccount ?? record.account;
    const backfillCashSide = !!overrideAccount && !record.toAccountId;

    return [record.id, {
    id: record.id,
    date: formatDateLocal(record.date),
    postedAt: record.postedAt ? formatDateLocal(record.postedAt) : null,
    createdAt: record.createdAt.toISOString(),
    dayOrder: record.dayOrder,
    // Redemption principal is a transfer between investment and cash accounts;
    // only the realized result belongs in income/expense detail.
    amount: record.type === "investment" && (record.fundSubtype === "redeem" || record.fundSubtype === "switch_out")
      ? 0
      : toNumber(record.amount),
    currency: record.currency ?? "CNY",
    runningBalance: null,
    type: record.type,
    categoryId: record.categoryId,
    categoryName,
    accountId: displayAccount?.id ?? record.accountId,
    accountName: displayAccount?.name ?? record.accountName,
    accountKind: displayAccount?.kind ?? null,
    accountDebtDirection: displayAccount?.debtDirection ?? null,
    accountInstitutionName: displayAccount?.Institution?.name ?? "",
    counterpartyInstitutionId: record.counterpartyInstitutionId,
    counterpartyInstitutionName: record.counterpartyInstitutionName,
    originalCurrency: record.originalCurrency,
    originalAmount: record.originalAmount == null ? null : toNumber(record.originalAmount),
    locationId: record.locationId,
    locationName: record.locationName,
    toAccountId: backfillCashSide ? record.accountId : record.toAccountId,
    toAccountName: backfillCashSide
      ? (record.account?.name ?? record.accountName)
      : (record.toAccount?.name ?? record.toAccountName),
    toAccountKind: backfillCashSide ? (record.account?.kind ?? null) : (record.toAccount?.kind ?? null),
    toAccountDebtDirection: backfillCashSide
      ? (record.account?.debtDirection ?? null)
      : (record.toAccount?.debtDirection ?? null),
    toAccountInstitutionName: backfillCashSide
      ? (record.account?.Institution?.name ?? "")
      : (record.toAccount?.Institution?.name ?? ""),
    note: record.note,
    toNote: record.toNote,
    fundSubtype: record.fundSubtype,
    fundCode: record.fundCode,
    fundName: record.fundName,
    wealthProductId: record.wealthProductId,
    depositProductId: record.depositProductId,
    insuranceProductId: record.insuranceProductId,
    insuranceAction: record.insuranceAction,
    insuranceProductName: record.insuranceProductName,
    metalTypeId: record.metalTypeId,
    metalTypeName: record.metalTypeName,
    metalUnitId: record.metalUnitId,
    metalUnitName: record.metalUnitName,
    metalQuantity: record.metalQuantity == null ? null : toNumber(record.metalQuantity),
    metalUnitPrice: record.metalUnitPrice == null ? null : toNumber(record.metalUnitPrice),
    metalFee: record.metalFee == null ? null : toNumber(record.metalFee),
    source: record.source,
    fundProductType: record.fundProductType,
    fundUnits: record.fundUnits == null ? null : toNumber(record.fundUnits),
    fundNav: record.fundNav == null ? null : toNumber(record.fundNav),
    realizedProfit,
    depositAnnualRate: record.depositAnnualRate == null ? null : toNumber(record.depositAnnualRate),
    depositInterest: record.depositInterest == null ? null : toNumber(record.depositInterest),
    depositSourceEntryId: record.depositSourceEntryId,
    fundSourceEntryId: record.fundSourceEntryId,
    fundFee: record.fundFee == null ? null : toNumber(record.fundFee),
    fundConfirmDate: record.fundConfirmDate ? formatDateLocal(record.fundConfirmDate) : null,
    fundArrivalDate: record.fundArrivalDate ? formatDateLocal(record.fundArrivalDate) : null,
    fundArrivalAmount: record.fundArrivalAmount == null ? null : toNumber(record.fundArrivalAmount),
    ...buildEntryBusinessLinkSummary(record),
    attachments: (record.Attachment || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "",
      mimeType: attachment.mimeType ?? null,
      url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
    })),
    entryTags: record.EntryTag.map((entryTag) => ({
      tagId: entryTag.tagId,
      Tag: entryTag.Tag ? { name: entryTag.Tag.name, color: entryTag.Tag.color ?? "#3B82F6" } : null,
    })),
  }];
  }));

  return uniqueEntryIds.flatMap((entryId) => {
    const entry = detailEntryById.get(entryId);
    return entry ? [entry] : [];
  });
}
