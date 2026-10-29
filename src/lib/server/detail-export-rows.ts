/**
 * 「按交易日期范围导出资金明细」的服务端取数。
 *
 * 表格里那份导出只是「当前显示的行」（分页 / 显示范围都会裁掉一部分），而这个
 * 函数按用户选的日期区间把**整个视图**重新读一遍：与明细列表同一条 SQL 取数链
 * （`queryDetailPage`，同一套生效日与排序口径），行内容交给
 * `@/lib/detail-export-rows` 统一生成，两条导出路径逐列一致。
 *
 * 只服务「单账户明细 / 全部收支」这两个没有额外 URL 筛选的视图；有表头筛选时
 * 客户端仍用 RSC 已经算好的行（那是完整筛选结果，不受分页影响）。
 */
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { categoryOrderBy } from "@/lib/category-order";
import { cashLedgerAccountIdsOf, cashLedgerFlowAccountId, isAllCashDetailScope } from "@/lib/all-cash-entries";
import { effectiveAmountForAccount } from "@/lib/balance-reconcile";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { compareDetailEntriesDescBy, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { DETAIL_ALL_CHUNK_SIZE } from "@/lib/detail-pagination-preference";
import {
  buildCategoryExportLabels,
  buildDetailExportRows,
  detailExportHeader,
  exportAccountLabel,
  type DetailExportEntryLike,
  type TranslateFn,
} from "@/lib/detail-export-rows";
import { rowWithLinkedInvestmentDisplayDate } from "@/lib/entry-reorder";
import { loadEntriesPageForAccount } from "@/lib/server/cached-data";
import { loadEntryLinkedInvestmentDisplay } from "@/lib/server/entry-business-display";
import { isCreditCardRepaymentTransfer } from "@/lib/transaction-semantics";

/** 分块大小与「全部」一致：5000 行 ≈ 10MB，绝大多数账户一次就读完。 */
const EXPORT_PAGE_SIZE = DETAIL_ALL_CHUNK_SIZE;
/** 兜底上限：防止总量算错时无限翻页（40 × 5000 = 20 万行）。 */
const EXPORT_MAX_PAGES = 40;

type ExportEntryRow = Awaited<ReturnType<typeof loadEntriesPageForAccount>>["entries"][number];

export type DetailExportScopeRequest = {
  /** 明细作用域账户：单账户 id，或「全部收支」的 `__all_cash__` */
  scopeAccountId: string;
  householdId: string;
  /** 导出区间；两端都空 = 全部时间 */
  dateRange: { from: string; to: string } | null;
  t: TranslateFn;
};

async function loadAllEntriesForExport(args: {
  accountIds: string[];
  householdId: string;
  rangeStr: string;
}): Promise<ExportEntryRow[]> {
  const hidFilterStr = JSON.stringify({ householdId: args.householdId });
  const scope = args.accountIds.length === 1 ? args.accountIds[0] : args.accountIds;
  const entries: ExportEntryRow[] = [];
  let totalCount = Number.NaN;
  for (let page = 1; page <= EXPORT_MAX_PAGES; page += 1) {
    const chunk = await loadEntriesPageForAccount(
      scope,
      hidFilterStr,
      page,
      EXPORT_PAGE_SIZE,
      args.rangeStr,
    );
    if (Number.isFinite(chunk.totalCount)) totalCount = chunk.totalCount;
    entries.push(...chunk.entries);
    // 短块 = 到底了；总量已知时以总量为准（按 rowNumber 区间取页，页间不重不漏）。
    if (chunk.entries.length < EXPORT_PAGE_SIZE) break;
    if (Number.isFinite(totalCount) && entries.length >= totalCount) break;
  }
  return entries;
}

function entryAmountOf(entry: DetailExportEntryLike) {
  return toNumber((entry as { readonly amount?: unknown }).amount);
}

/**
 * 生成导出用的整份行（含表头）。
 *
 * 行口径必须与明细表逐列一致：生效日按 `getDetailEntryDisplayDate`（基金 / 理财
 * 独立交易要用业务事实兜底）、金额按表格符号（转账 / 投资恒为流出方）、账户标签
 * 按导出身份串。
 */
export async function buildDetailExportRowsForScope(
  request: DetailExportScopeRequest,
): Promise<string[][]> {
  const { t } = request;
  const header = detailExportHeader(t);
  const allCashView = isAllCashDetailScope(request.scopeAccountId);
  const accounts = await prisma.account.findMany({
    where: { isPlaceholder: { not: true }, householdId: request.householdId },
    include: { Institution: true, Counterparty: true, AccountGroup: true },
  });
  const accountIds = allCashView
    ? cashLedgerAccountIdsOf(accounts)
    : [request.scopeAccountId].filter(Boolean);
  if (accountIds.length === 0) return [header];

  const cashLedgerIdSet = new Set(accountIds);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  // 导出是只读动作：分类只读一次，不走 `loadCommonData`（它在缓存未命中时会写库
  // 归一化分类层级，GET 里不该发生写）。
  const categories = await prisma.category.findMany({
    where: { householdId: request.householdId },
    orderBy: categoryOrderBy(),
  });
  const rangeStr = request.dateRange
    ? `${request.dateRange.from ?? ""}~${request.dateRange.to ?? ""}`.replace(/^~$/, "")
    : "";

  const rawEntries = await loadAllEntriesForExport({
    accountIds,
    householdId: request.householdId,
    rangeStr,
  });
  if (rawEntries.length === 0) return [header];

  const linkedInvestmentDisplay = await loadEntryLinkedInvestmentDisplay(
    rawEntries.filter((entry) => entry.type === "investment").map((entry) => entry.id),
    request.householdId,
  );
  // 基金 / 理财独立交易的 TxRecord 上没有正确日期，要用业务事实那一份兜底。
  const displayRowOf = (entry: ExportEntryRow) => rowWithLinkedInvestmentDisplayDate(
    entry,
    linkedInvestmentDisplay.fund.get(entry.id) ?? null,
    linkedInvestmentDisplay.wealth.get(entry.id) ?? null,
  );

  const flowAccountIdOf = (entry: DetailExportEntryLike): string | null | undefined =>
    allCashView ? cashLedgerFlowAccountId(entry, cashLedgerIdSet) : request.scopeAccountId;
  const tableAccountIdOf = (entry: DetailExportEntryLike): string | null | undefined => {
    if (!allCashView || !entry.toAccountId) return flowAccountIdOf(entry);
    const fromIsCash = !!entry.accountId && cashLedgerIdSet.has(entry.accountId);
    const toIsCash = !!entry.toAccountId && cashLedgerIdSet.has(entry.toAccountId);
    // 全部收支里，两侧都是资金账户时按符号取流入方；否则取流出方。
    return fromIsCash && toIsCash && entryAmountOf(entry) >= 0 ? entry.toAccountId : entry.accountId;
  };
  const flowAmountOf = (entry: DetailExportEntryLike): number => {
    const amount = entryAmountOf(entry);
    if (allCashView && entry.toAccountId) return -Math.abs(amount);
    return effectiveAmountForAccount(entry as Parameters<typeof effectiveAmountForAccount>[0], flowAccountIdOf(entry));
  };

  // 生效日先算一次：排序与日期列共用同一份，避免 `displayRowOf` 在比较函数里反复建对象。
  const displayDateMsById = new Map<string, number>();
  for (const entry of rawEntries) {
    displayDateMsById.set(
      entry.id,
      getDetailEntryDisplayDate(displayRowOf(entry), flowAccountIdOf(entry)).getTime() || 0,
    );
  }
  const ordered = [...rawEntries].sort((a, b) => compareDetailEntriesDescBy(
    a,
    b,
    (row) => new Date(displayDateMsById.get((row as { id?: string }).id ?? "") ?? 0),
  ));

  const isSettlementAccountId = (id?: string | null) => {
    if (!id) return false;
    const account = accountById.get(id);
    if (!account) return false;
    return account.kind === AccountKind.settlement
      || (account.kind === AccountKind.loan && !!account.counterpartyId);
  };

  const rows = buildDetailExportRows(ordered, {
    t,
    categoryExportLabels: buildCategoryExportLabels(t, categories),
    isCreditCardRepayment: (entry) => {
      if (isSettlementAccountId(entry.accountId) || isSettlementAccountId(entry.toAccountId)) return false;
      return isCreditCardRepaymentTransfer({
        type: entry.type,
        accountKind: entry.account?.kind ?? accountById.get(entry.accountId ?? "")?.kind ?? null,
        toAccountKind: entry.toAccount?.kind ?? accountById.get(entry.toAccountId ?? "")?.kind ?? null,
      });
    },
    flowAccountIdOf,
    tableAccountIdOf,
    flowAmountOf,
    dateOf: (entry) => formatDateUtc(new Date(displayDateMsById.get(String(entry.id ?? "")) ?? 0)),
    accountLabelOf: (accountId) => exportAccountLabel(accountById.get(accountId ?? "")),
  });

  return [header, ...rows.map((item) => item.row)];
}
