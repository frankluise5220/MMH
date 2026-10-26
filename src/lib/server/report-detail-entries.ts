import type { DetailEntry } from "@/components/DetailViewClient";
import { prisma } from "@/lib/db/prisma";
import { toNumber, formatDateUtc, formatDateInTimeZone } from "@/lib/date-utils";
import { resolveHouseholdTimeZone } from "@/lib/server/business-time-zone";
import { rowWithLinkedInvestmentDisplayDate } from "@/lib/entry-reorder";
import { loadEntryLinkedInvestmentDisplay } from "@/lib/server/entry-business-display";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import type { HouseholdContext } from "@/lib/server/household-scope";

type ReportDetailEntryOverrides = {
  categoryByEntryId: ReadonlyMap<string, string>;
  realizedProfitByEntryId: ReadonlyMap<string, number | null>;
  accountByEntryId: ReadonlyMap<string, { accountId: string; accountName: string }>;
  /**
   * 报表明细行金额：报表在统计阶段已按汇率折成本位币，明细直接沿用这个值，
   * 不能再对记账原值折一次（否则 244 USD 的流水会被折两遍）。
   */
  amountByEntryId: ReadonlyMap<string, number>;
};

/**
 * The income/expense report already classifies each detail row, including the
 * auto-posted bond/deposit yield rows whose raw category snapshot is empty or
 * incomplete. Reuse that computed view instead of re-reading the raw fields.
 */
export function buildReportDetailEntryOverrides(
  rows: ReadonlyArray<{
    entryId: string;
    amount?: number | null;
    categoryName?: string | null;
    realizedProfit?: number | null;
    accountId?: string | null;
    accountName?: string | null;
  }>,
): ReportDetailEntryOverrides {
  const categoryByEntryId = new Map<string, string>();
  const realizedProfitByEntryId = new Map<string, number | null>();
  const accountByEntryId = new Map<string, { accountId: string; accountName: string }>();
  const amountByEntryId = new Map<string, number>();

  for (const row of rows) {
    const categoryName = row.categoryName?.trim() ?? "";
    if (categoryName && !categoryByEntryId.has(row.entryId)) {
      categoryByEntryId.set(row.entryId, categoryName);
    }
    // 报表合计 = 各行 amount 之和（已是本位币值），明细展示必须取同一个数才不打架。
    // 净额视图里支出行的 amount 是负数，只关心绝对值，符号由收支列自己判断。
    if (row.amount != null && Number.isFinite(row.amount) && !amountByEntryId.has(row.entryId)) {
      amountByEntryId.set(row.entryId, Math.abs(row.amount));
    }
    if (row.realizedProfit != null) {
      // One TxRecord can produce several report rows (for example fund
      // redemption splits). The detail table renders the record once, so the
      // first non-null row result is the display value; summing duplicates
      // would turn one realized result into a much larger fake total.
      if (!realizedProfitByEntryId.has(row.entryId)) {
        realizedProfitByEntryId.set(row.entryId, row.realizedProfit);
      }
      // Economic-return rows (fund/wealth redemption gains, dividends, and
      // bond/deposit interest) belong to the investment account. Raw entries
      // may use the receiving cash account, so details must match the report.
      const accountId = row.accountId?.trim() ?? "";
      const accountName = row.accountName?.trim() ?? "";
      if (accountId && accountName && !accountByEntryId.has(row.entryId)) {
        accountByEntryId.set(row.entryId, { accountId, accountName });
      }
    }
  }

  return { categoryByEntryId, realizedProfitByEntryId, accountByEntryId, amountByEntryId };
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

  // Economic-return details belong to the investment account in reports, while
  // raw entries may use the receiving cash account. Load override accounts once
  // so the detail list uses the same account convention.
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

  // 赎回的业务事实（到账日 / 收款资金账户）只存在 fund_transactions /
  // wealth_transactions，TxRecord 上这两列可能为空。报表下钻必须和明细表用同一份
  // 回填，否则赎回行显示的仍是申请日（2026-10-17）。
  const linkedInvestmentDisplay = await loadEntryLinkedInvestmentDisplay(
    records.map((record) => record.id),
    ctx.householdId,
  );

  // 报表是**本位币统计口径**：金额在统计阶段已经按汇率折算过，明细行只需要用本位币
  // 展示币种，不能再折一次（2026-10-18 用户报障：原币 244 USD 的流水，报表里已是
  // ¥1633.97，明细却标着 $）。账户明细页不走这里，仍按记录原币展示。
  const displayCurrency = await getHouseholdBaseCurrency(ctx.householdId);
  // 报表下钻的「时刻 → 日历日」按账簿时区换算，不能跟着容器 TZ 走。
  const reportTimeZone = await resolveHouseholdTimeZone(ctx.householdId);

  const detailEntryById = new Map<string, DetailEntry>(records.map((record) => {
    const linkedRow = rowWithLinkedInvestmentDisplayDate(
      {
        id: record.id,
        date: record.date,
        amount: record.amount,
        type: record.type,
        accountId: record.accountId,
        toAccountId: record.toAccountId,
        fundSubtype: record.fundSubtype,
        source: record.source,
        fundArrivalDate: record.fundArrivalDate,
      },
      linkedInvestmentDisplay.fund.get(record.id) ?? null,
      linkedInvestmentDisplay.wealth.get(record.id) ?? null,
    );
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

    // Match the report's display account: prefer the override. If the raw entry
    // only has a receiving-side account and no toAccount, preserve that cash
    // destination as the counter-side account.
    const overrideAccount = overrideAccountById.get(
      overrides?.accountByEntryId.get(record.id)?.accountId ?? "",
    );
    const displayAccount = overrideAccount ?? record.account;
    const backfillCashSide = !!overrideAccount && !record.toAccountId;

    // 展示口径：赎回本金不计收支（置 0），其余取记账原值。
    const reportAmount = record.type === "investment" && (record.fundSubtype === "redeem" || record.fundSubtype === "switch_out")
      ? 0
      : toNumber(record.amount);

    // 明细金额优先用报表自己的行金额（统计时已折成本位币），批次里没有对应行时
    // 才退回记账原值 —— 无论哪种都不再做汇率换算，避免二次折算。
    const reportRowAmount = overrides?.amountByEntryId.get(record.id);
    const displayAmount = reportRowAmount == null ? reportAmount : Math.abs(reportRowAmount);

    return [record.id, {
    id: record.id,
    date: formatDateUtc(record.date),
    postedAt: record.postedAt ? formatDateInTimeZone(record.postedAt, reportTimeZone) : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
    entryOrigin: record.entryOrigin ?? null,
    dayOrder: record.dayOrder,
    // Redemption principal is a transfer between investment and cash accounts;
    // only the realized result belongs in income/expense detail.
    amount: reportAmount,
    // 记账原值：上面的 amount 是报表展示口径（赎回本金会被抹成 0），
    // 编辑窗要用这一列还原「取出本金 / 到账金额」。
    bookAmount: toNumber(record.amount),
    // Legacy income rows have no currency: the edit dialog restores it from the posting
    // account instead of defaulting to CNY.
    currency: record.currency ?? displayAccount?.currency ?? "CNY",
    displayAmount,
    displayRealizedProfit: realizedProfit,
    displayCurrency,
    runningBalance: null,
    type: record.type,
    categoryId: record.categoryId,
    categoryName,
    accountId: displayAccount?.id ?? record.accountId,
    accountName: displayAccount?.name ?? record.accountName,
    accountKind: displayAccount?.kind ?? null,
    accountLiabilityDirection: displayAccount?.liabilityDirection ?? null,
    accountInstitutionName: displayAccount?.Institution?.name ?? "",
    counterpartyInstitutionId: record.counterpartyInstitutionId,
    counterpartyInstitutionName: record.counterpartyInstitutionName,
    originalCurrency: record.originalCurrency,
    originalAmount: record.originalAmount == null ? null : toNumber(record.originalAmount),
    locationId: record.locationId,
    locationName: record.locationName,
    toAccountId: backfillCashSide ? record.accountId : linkedRow.toAccountId ?? record.toAccountId,
    toAccountName: backfillCashSide
      ? (record.account?.name ?? record.accountName)
      : (record.toAccount?.name ?? record.toAccountName),
    toAccountKind: backfillCashSide ? (record.account?.kind ?? null) : (record.toAccount?.kind ?? null),
    toAccountLiabilityDirection: backfillCashSide
      ? (record.account?.liabilityDirection ?? null)
      : (record.toAccount?.liabilityDirection ?? null),
    toAccountInstitutionName: backfillCashSide
      ? (record.account?.Institution?.name ?? "")
      : (record.toAccount?.Institution?.name ?? ""),
    note: record.note,
    toNote: record.toNote,
    fundSubtype: linkedRow.fundSubtype ?? record.fundSubtype,
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
    fundConfirmDate: record.fundConfirmDate ? formatDateUtc(record.fundConfirmDate) : null,
    fundArrivalDate: linkedRow.fundArrivalDate ? formatDateUtc(linkedRow.fundArrivalDate) : null,
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
