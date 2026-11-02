"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Coins, Landmark, Library, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  ADVANCED_TABLE_HEAD_SURFACE_CLASS,
  AdvancedDataTable,
  type AdvancedDataTableColumn,
  type AdvancedDataTableSummaryRow,
} from "./AdvancedDataTable";
import { DetailTablePaginationControls } from "./DetailTablePaginationControls";
import { EntryRowActions, type EditPayload } from "./EntryRowActions";
import { ProductLibraryModal } from "./ProductLibraryModal";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { recordRecentAccounts } from "@/lib/client/recentAccounts";
import { useEntryReconcileState } from "@/lib/client/use-entry-reconcile-state";
import { parseDepositInterestPayout } from "@/lib/deposit-interest-payout";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useDetailPagination } from "@/lib/client/use-detail-pagination";

/**
 * 债券视图。
 *
 * 债券是「债单 + 票面利率 + 到期日 + 付息」模型，与基金的份额/净值模型不同，
 * 因此不复用 FundShell：这里只出现债券自己的口径——起息日、到期日、付息方式、
 * 票面利率、持仓本金、累计已付利息、预计利息、下次付息、已实现收益。
 */
export type BondShellLot = {
  id: string;
  name: string;
  /** 同一债单内的存单序号（按起息日排序，从 1 开始）—— 一张存单 = 一个持仓。 */
  certificateIndex: number;
  startDate: string | null;
  clearedDate: string | null;
  maturityDate: string | null;
  payoutFrequency: string | null;
  annualRate: number | null;
  principal: number;
  paidInterest: number;
  expectedInterest: number | null;
  nextPayoutDate: string | null;
  nextExpectedInterest: number | null;
  realizedProfit: number;
  status: "open" | "closed";
  relatedEntryIds: string[];
};

export type BondShellEntry = {
  id: string;
  date: string;
  typeLabel: string;
  bondName: string;
  arrivalDate?: string | null;
  cashAccountLabel: string;
  /** 账户单元格的 hover：只含标签里没显示的字段（所有人 / 账户类型）。 */
  cashAccountTitle?: string | null;
  note: string;
  amount: number;
  businessTransactionId?: string | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  edit?: Omit<EditPayload, "entryId">;
};

/**
 * 逆回购存单：与债券存单同构（本金 + 年化 + 到期日），但口径不同——
 * 到期一次还本付息、按**实际占款天数**计息、没有付息计划。
 */
export type BondShellRepoLot = {
  id: string;
  /** 品种名，如 `GC001 · 1天`。 */
  name: string;
  /** 交易代码 204001。 */
  code: string | null;
  termDays: number | null;
  annualRate: number | null;
  principal: number;
  startDate: string | null;
  maturityDate: string | null;
  clearedDate: string | null;
  occupiedDays: number | null;
  remainingDays: number | null;
  fee: number | null;
  expectedInterest: number | null;
  actualInterest: number | null;
  realizedProfit: number;
  status: "open" | "closed";
  relatedEntryIds: string[];
};

export type BondShellRepo = {
  lots: BondShellRepoLot[];
  entries: BondShellEntry[];
  totalPrincipal: number;
  totalExpectedInterest: number;
  totalRealizedProfit: number;
  openCount: number;
  defaultCashAccountId: string | null;
};

type LotTab = "held" | "cleared" | "repo-open" | "repo-closed";

const BOND_ENTRY_COLUMN_SETTINGS_EVENT = "mmh:bond-entries:column-settings";

function repoTotalPrincipalOf(lots: BondShellRepoLot[]): number {
  return Number(lots.reduce((sum, lot) => sum + lot.principal, 0).toFixed(2));
}

export function BondShell({
  accountId,
  accountLabel,
  institutionName,
  institutionId,
  lots,
  entries,
  totalPrincipal,
  totalPaidInterest,
  totalExpectedInterest,
  repo,
}: {
  accountId: string;
  accountLabel: string;
  institutionName?: string;
  /** 当前债券账户所属机构，用作产品库新建债券时的默认机构 */
  institutionId?: string | null;
  lots: BondShellLot[];
  entries: BondShellEntry[];
  totalPrincipal: number;
  totalPaidInterest: number;
  totalExpectedInterest: number;
  /** 逆回购（同一张 bond_transactions 表里 instrumentKind = "repo" 的存单）。 */
  repo?: BondShellRepo | null;
}) {
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [selectedRepoLotId, setSelectedRepoLotId] = useState<string | null>(null);
  const [productLibraryOpen, setProductLibraryOpen] = useState(false);
  const [lotTab, setLotTab] = useState<LotTab>("held");
  const [entryRowCount, setEntryRowCount] = useState(0);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());

  const { t } = useI18n();
  const router = useRouter();

  const formatText = useCallback((key: string, values?: Record<string, string | number>) => {
    let text = t(key) as string;
    if (!values) return text;
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }, [t]);

  const payoutFrequencyLabel = useCallback((frequency: string | null | undefined) => {
    const parsed = parseDepositInterestPayout(frequency);
    if (parsed.kind !== "periodic") return t("bondShell.payout.maturity");
    const unitKey =
      parsed.unit === "week"
        ? "bondShell.unit.week"
        : parsed.unit === "year"
          ? "bondShell.unit.year"
          : "bondShell.unit.month";
    return formatText("bondShell.payout.everyN", {
      interval: String(parsed.interval),
      unit: t(unitKey),
    });
  }, [formatText, t]);

  const isRepoView = lotTab === "repo-open" || lotTab === "repo-closed";
  const heldLots = useMemo(() => lots.filter((lot) => lot.status === "open"), [lots]);
  const clearedLots = useMemo(() => lots.filter((lot) => lot.status === "closed"), [lots]);
  const visibleLots = lotTab === "held" ? heldLots : clearedLots;

  const repoLots = useMemo(() => repo?.lots ?? [], [repo]);
  const repoOpenLots = useMemo(() => repoLots.filter((lot) => lot.status === "open"), [repoLots]);
  const repoClosedLots = useMemo(() => repoLots.filter((lot) => lot.status === "closed"), [repoLots]);
  const repoVisibleLots = lotTab === "repo-open" ? repoOpenLots : repoClosedLots;

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId],
  );
  const selectedRepoLot = useMemo(
    () => repoLots.find((lot) => lot.id === selectedRepoLotId) ?? null,
    [repoLots, selectedRepoLotId],
  );

  function switchLotTab(tab: LotTab) {
    setLotTab(tab);
    setSelectedLotId(null);
    setSelectedRepoLotId(null);
  }

  const activeEntries = useMemo(
    () => (isRepoView ? (repo?.entries ?? []) : entries),
    [entries, isRepoView, repo],
  );
  const visibleEntries = useMemo(() => {
    const related = isRepoView ? selectedRepoLot : selectedLot;
    if (!related) return activeEntries;
    const relatedIds = new Set(related.relatedEntryIds);
    return activeEntries.filter((entry) => relatedIds.has(entry.id));
  }, [activeEntries, selectedLot, selectedRepoLot, isRepoView]);
  const visibleEntryIds = useMemo(() => visibleEntries.map((entry) => entry.id), [visibleEntries]);
  // 债券明细行就是背后的现金流水：现金明细页锁定的记录，这里同样要显示锁并能就地解锁。
  const { isReconciled } = useEntryReconcileState(visibleEntryIds);

  // 换一只债券要回到第一页，effect 挪到分页状态点之后声明（见下方 entryPager）。

  useEffect(() => {
    setSelectedEntryIds(new Set());
    setSelectedRepoLotId(null);
  }, [accountId]);

  useEffect(() => {
    setSelectedEntryIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(visibleEntryIds);
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [visibleEntryIds]);

  // 债券视图走服务端渲染 + router.refresh()，与存款视图同一刷新契约。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean; reason?: string }>).detail;
      // 对账锁定/解锁只改 reconciledAt / reconciledBalance：业务明细不变，行内锁标记由
      // `useEntryReconcileState` 就地更新；不重取服务端数据，避免整表替换。
      if (detail?.reason === "entry-reconcile") return;
      if (detail?.balanceChanged === false) return;
      router.refresh();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [router]);

  // 页码 / 每页行数 / 全部只有这一个状态点（与存款视图同一实现）。
  // 「自适应」是页大小的来源，不是独立开关，所以手选固定行数后表格再回报容量
  // 也不会把手选值改掉。
  const entryPager = useDetailPagination({
    scopeKey: "bond",
    rowCount: entryRowCount,
  });

  // 换一只债券：回到第一页（每页行数保持用户或视口当前的选择）。
  const goEntryPage = entryPager.goPage;
  useEffect(() => {
    goEntryPage(1);
  }, [selectedLotId, selectedRepoLotId, goEntryPage]);

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    const entryIds = Array.from(selectedEntryIds);
    const data = await deleteEntriesWithLinkedPrompt({
      entryIds,
      confirmMessage: t("basicDetailSelection.deleteConfirm", { count: entryIds.length, label: t("bondShell.entriesTitle") }),
      t,
    });
    if (!data.ok) {
      if (data.code === "DELETE_CANCELLED" || data.error === "已取消删除") return;
      window.alert(data.error || t("stockPanel.error.batchDeleteFailed"));
      return;
    }
    setSelectedEntryIds(new Set());
    const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
    const batchDeleteAccountIds = getDeleteRefreshAccountIds(data);
    recordRecentAccounts(batchDeleteAccountIds);
    dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: batchDeleteAccountIds, deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
  }

  const moneyCell = useCallback((value: number | null, tone?: string) => (
    value == null
      ? <span className="tabular-nums text-slate-400">-</span>
      : <span className={`font-semibold tabular-nums ${tone ?? "text-slate-700"}`}>{formatMoney(value)}</span>
  ), []);

  const heldColumns = useMemo<AdvancedDataTableColumn<BondShellLot>[]>(() => [
    {
      key: "bond",
      label: t("bondShell.colBond"),
      width: 240,
      minWidth: 150,
      filterText: (lot) => lot.name,
      filterSearchText: (lot) => lot.name,
      sortValue: (lot) => lot.name,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.name}>{lot.name || "-"}</span>
          <span
            className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            title={t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          >
            {t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          </span>
        </div>
      ),
    },
    { key: "startDate", label: t("bondShell.colStartDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("bondShell.colMaturityDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "payoutFrequency", label: t("bondShell.colPayoutFrequency"), width: 128, minWidth: 96, hideable: true, filterText: (lot) => payoutFrequencyLabel(lot.payoutFrequency), sortValue: (lot) => lot.payoutFrequency ?? "", render: (lot) => <span className="text-slate-600">{payoutFrequencyLabel(lot.payoutFrequency)}</span> },
    { key: "annualRate", label: t("bondShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.annualRate != null ? String(lot.annualRate) : null), filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "principal", label: t("bondShell.colPrincipal"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.principal), filterNumber: (lot) => lot.principal, sortValue: (lot) => lot.principal, render: (lot) => moneyCell(lot.principal) },
    { key: "paidInterest", label: t("bondShell.colPaidInterest"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.paidInterest), filterNumber: (lot) => lot.paidInterest, sortValue: (lot) => lot.paidInterest, render: (lot) => (lot.paidInterest > 0 ? moneyCell(lot.paidInterest, "text-emerald-600") : moneyCell(null)) },
    { key: "expectedInterest", label: t("bondShell.colExpectedInterest"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.expectedInterest != null ? String(lot.expectedInterest) : null), filterNumber: (lot) => lot.expectedInterest ?? null, sortValue: (lot) => lot.expectedInterest ?? 0, render: (lot) => moneyCell(lot.expectedInterest, "text-emerald-700") },
    { key: "nextPayoutDate", label: t("bondShell.colNextPayout"), width: 116, minWidth: 88, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.nextPayoutDate ?? "", sortValue: (lot) => lot.nextPayoutDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.nextPayoutDate || "-"}</span> },
    { key: "realizedProfit", label: t("bondShell.colRealizedProfit"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.realizedProfit), filterNumber: (lot) => Math.abs(lot.realizedProfit), sortValue: (lot) => lot.realizedProfit, render: (lot) => (lot.realizedProfit !== 0 ? moneyCell(lot.realizedProfit, amountClass(lot.realizedProfit)) : moneyCell(null)) },
  ], [moneyCell, payoutFrequencyLabel, t]);

  const clearedColumns = useMemo<AdvancedDataTableColumn<BondShellLot>[]>(() => [
    {
      key: "bond",
      label: t("bondShell.colBond"),
      width: 240,
      minWidth: 150,
      filterText: (lot) => lot.name,
      filterSearchText: (lot) => lot.name,
      sortValue: (lot) => lot.name,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.name}>{lot.name || "-"}</span>
          <span
            className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            title={t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          >
            {t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          </span>
        </div>
      ),
    },
    { key: "startDate", label: t("bondShell.colStartDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "clearedDate", label: t("bondShell.colClearedDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.clearedDate ?? "", sortValue: (lot) => lot.clearedDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.clearedDate || "-"}</span> },
    { key: "annualRate", label: t("bondShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.annualRate != null ? String(lot.annualRate) : null), filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "paidInterest", label: t("bondShell.colPaidInterest"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.paidInterest), filterNumber: (lot) => lot.paidInterest, sortValue: (lot) => lot.paidInterest, render: (lot) => (lot.paidInterest > 0 ? moneyCell(lot.paidInterest, "text-emerald-600") : moneyCell(null)) },
    { key: "realizedProfit", label: t("bondShell.colRealizedProfit"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.realizedProfit), filterNumber: (lot) => Math.abs(lot.realizedProfit), sortValue: (lot) => lot.realizedProfit, render: (lot) => (lot.realizedProfit !== 0 ? moneyCell(lot.realizedProfit, amountClass(lot.realizedProfit)) : moneyCell(null)) },
  ], [moneyCell, t]);

  const lotColumns = lotTab === "held" ? heldColumns : clearedColumns;

  const repoNameColumn = useMemo<AdvancedDataTableColumn<BondShellRepoLot>>(() => ({
    key: "name",
    label: t("repoShell.colProduct"),
    width: 200,
    minWidth: 140,
    filterText: (lot) => `${lot.name} ${lot.code ?? ""}`,
    filterSearchText: (lot) => `${lot.name} ${lot.code ?? ""}`,
    sortValue: (lot) => lot.name,
    render: (lot) => (
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-slate-700" title={`${lot.name}${lot.code ? ` ${lot.code}` : ""}`}>{lot.name || "-"}</span>
        {lot.termDays ? (
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
            {lot.termDays}{t("repoShell.dayUnit")}
          </span>
        ) : null}
      </div>
    ),
  }), [t]);

  const repoOpenColumns = useMemo<AdvancedDataTableColumn<BondShellRepoLot>[]>(() => [
    repoNameColumn,
    { key: "startDate", label: t("repoShell.colLendDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("repoShell.colMaturityDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    {
      key: "remainingDays",
      label: t("repoShell.colRemainingDays"),
      width: 96,
      minWidth: 76,
      align: "right",
      hideable: true,
      filterKind: "numberRange",
      filterText: (lot) => (lot.remainingDays != null ? String(lot.remainingDays) : null),
      filterNumber: (lot) => lot.remainingDays ?? null,
      sortValue: (lot) => lot.remainingDays ?? 0,
      render: (lot) => {
        if (lot.remainingDays == null) return <span className="text-slate-400">-</span>;
        const overdue = lot.remainingDays < 0;
        return (
          <span className={`tabular-nums ${overdue ? "font-semibold text-rose-600" : "text-slate-600"}`}>
            {overdue ? t("repoShell.overdue") : lot.remainingDays}
          </span>
        );
      },
    },
    { key: "annualRate", label: t("repoShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.annualRate != null ? String(lot.annualRate) : null), filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "principal", label: t("repoShell.colPrincipal"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.principal), filterNumber: (lot) => lot.principal, sortValue: (lot) => lot.principal, render: (lot) => moneyCell(lot.principal) },
    { key: "expectedInterest", label: t("repoShell.colExpectedInterest"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.expectedInterest != null ? String(lot.expectedInterest) : null), filterNumber: (lot) => lot.expectedInterest ?? null, sortValue: (lot) => lot.expectedInterest ?? 0, render: (lot) => moneyCell(lot.expectedInterest, "text-emerald-700") },
    { key: "fee", label: t("repoShell.colFee"), width: 96, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.fee != null ? String(lot.fee) : null), filterNumber: (lot) => lot.fee ?? null, sortValue: (lot) => lot.fee ?? 0, render: (lot) => moneyCell(lot.fee) },
    { key: "realizedProfit", label: t("repoShell.colRealizedProfit"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.realizedProfit), filterNumber: (lot) => Math.abs(lot.realizedProfit), sortValue: (lot) => lot.realizedProfit, render: (lot) => (lot.realizedProfit !== 0 ? moneyCell(lot.realizedProfit, amountClass(lot.realizedProfit)) : moneyCell(null)) },
  ], [moneyCell, repoNameColumn, t]);

  const repoClosedColumns = useMemo<AdvancedDataTableColumn<BondShellRepoLot>[]>(() => [
    repoNameColumn,
    { key: "startDate", label: t("repoShell.colLendDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "clearedDate", label: t("repoShell.colClearedDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.clearedDate ?? "", sortValue: (lot) => lot.clearedDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.clearedDate || "-"}</span> },
    { key: "occupiedDays", label: t("repoShell.colOccupiedDays"), width: 100, minWidth: 78, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.occupiedDays != null ? String(lot.occupiedDays) : null), filterNumber: (lot) => lot.occupiedDays ?? null, sortValue: (lot) => lot.occupiedDays ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.occupiedDays ?? "-"}</span> },
    { key: "annualRate", label: t("repoShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.annualRate != null ? String(lot.annualRate) : null), filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "principal", label: t("repoShell.colPrincipal"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.principal), filterNumber: (lot) => lot.principal, sortValue: (lot) => lot.principal, render: (lot) => moneyCell(lot.principal) },
    { key: "actualInterest", label: t("repoShell.colActualInterest"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.actualInterest != null ? String(lot.actualInterest) : null), filterNumber: (lot) => lot.actualInterest ?? null, sortValue: (lot) => lot.actualInterest ?? 0, render: (lot) => moneyCell(lot.actualInterest, "text-emerald-600") },
    { key: "fee", label: t("repoShell.colFee"), width: 96, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.fee != null ? String(lot.fee) : null), filterNumber: (lot) => lot.fee ?? null, sortValue: (lot) => lot.fee ?? 0, render: (lot) => moneyCell(lot.fee) },
    { key: "realizedProfit", label: t("repoShell.colRealizedProfit"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.realizedProfit), filterNumber: (lot) => Math.abs(lot.realizedProfit), sortValue: (lot) => lot.realizedProfit, render: (lot) => (lot.realizedProfit !== 0 ? moneyCell(lot.realizedProfit, amountClass(lot.realizedProfit)) : moneyCell(null)) },
  ], [moneyCell, repoNameColumn, t]);

  const repoColumns = lotTab === "repo-open" ? repoOpenColumns : repoClosedColumns;

  const repoSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (repoVisibleLots.length === 0) return undefined;
    const cells: Record<string, ReactNode> = {
      name: <span className="font-semibold text-slate-800">{t("liabilityShell.summaryRow")}</span>,
      principal: <span className="font-semibold tabular-nums text-slate-800">{formatMoney(repoTotalPrincipalOf(repoVisibleLots))}</span>,
    };
    if (lotTab === "repo-open") {
      const expected = repoVisibleLots.reduce((sum, lot) => sum + (lot.expectedInterest ?? 0), 0);
      if (expected > 0) cells.expectedInterest = <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(expected)}</span>;
    } else {
      const interest = repoVisibleLots.reduce((sum, lot) => sum + (lot.actualInterest ?? 0), 0);
      if (interest > 0) cells.actualInterest = <span className="font-semibold tabular-nums text-emerald-600">{formatMoney(interest)}</span>;
    }
    const realized = repoVisibleLots.reduce((sum, lot) => sum + lot.realizedProfit, 0);
    if (realized !== 0) cells.realizedProfit = <span className={`font-semibold tabular-nums ${amountClass(realized)}`}>{formatMoney(realized)}</span>;
    return { cells, rowClassName: "bg-slate-50/80" };
  }, [lotTab, repoVisibleLots, t]);

  const lotsSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (visibleLots.length === 0) return undefined;
    const cells: Record<string, ReactNode> = {
      bond: <span className="font-semibold text-slate-800">{t("liabilityShell.summaryRow")}</span>,
    };
    if (lotTab === "held") {
      cells.principal = <span className="font-semibold tabular-nums text-slate-800">{formatMoney(totalPrincipal)}</span>;
      if (totalPaidInterest > 0) {
        cells.paidInterest = <span className="font-semibold tabular-nums text-emerald-600">{formatMoney(totalPaidInterest)}</span>;
      }
      if (totalExpectedInterest > 0) {
        cells.expectedInterest = <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(totalExpectedInterest)}</span>;
      }
    }
    return { cells, rowClassName: "bg-slate-50/80" };
  }, [lotTab, t, totalExpectedInterest, totalPaidInterest, totalPrincipal, visibleLots.length]);

  const entryColumns = useMemo<AdvancedDataTableColumn<BondShellEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterKind: "dateRange", filterText: (entry) => entry.date, sortValue: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "action", label: t("bondShell.colAction"), width: 96, minWidth: 72, filterText: (entry) => entry.typeLabel, sortValue: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "bond", label: t("bondShell.colBond"), width: 190, minWidth: 120, filterText: (entry) => entry.bondName, filterSearchText: (entry) => entry.bondName, sortValue: (entry) => entry.bondName, render: (entry) => <span className="truncate text-slate-700" title={entry.bondName}>{entry.bondName || "-"}</span> },
    { key: "arrivalDate", label: t("bondShell.colArrivalDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (entry) => entry.arrivalDate ?? "", sortValue: (entry) => entry.arrivalDate ?? "", render: (entry) => <span className="tabular-nums text-slate-600">{entry.arrivalDate || "-"}</span> },
    { key: "cashAccount", label: t("bondShell.colCashAccount"), width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, filterSearchText: (entry) => entry.cashAccountLabel, sortValue: (entry) => entry.cashAccountLabel, render: (entry) => <span className="truncate text-slate-600" title={entry.cashAccountTitle || undefined}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: t("detail.column.remark"), width: 220, minWidth: 120, hideable: true, filterText: (entry) => entry.note, filterSearchText: (entry) => entry.note, sortValue: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: t("bondShell.colAmount"),
      width: 120,
      minWidth: 86,
      align: "right",
      filterKind: "numberRange",
      filterText: (entry) => String(entry.amount),
      filterNumber: (entry) => Math.abs(entry.amount),
      sortValue: (entry) => entry.amount,
      render: (entry) => (
        <span className={`inline-flex items-center justify-end gap-1 font-semibold tabular-nums ${amountClass(entry.amount)}`}>
          {entry.amount >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
          {formatMoney(entry.amount)}
        </span>
      ),
    },
  ], [t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey="mmh:bond:split-height"
        hasLowerPane
        defaultUpperHeight={360}
        separatorLabel={t("bondShell.resizeLabel")}
        separatorTitle={t("bondShell.resizeTitle")}
      >
        <section className="paper-card flex h-full min-h-0 flex-col overflow-hidden">
          <div className={`paper-card-header ${ADVANCED_TABLE_HEAD_SURFACE_CLASS}`}>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              {isRepoView ? <Coins className="h-4 w-4 text-emerald-600" /> : <Landmark className="h-4 w-4 text-amber-600" />}
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => switchLotTab("held")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "held" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("bondShell.holdingsTitle")}
                </button>
                <button
                  type="button"
                  onClick={() => switchLotTab("cleared")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "cleared" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("bondShell.clearedTitle")}
                </button>
                <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => switchLotTab("repo-open")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "repo-open" ? "bg-emerald-50 text-emerald-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("repoShell.holdingsTitle")}
                </button>
                <button
                  type="button"
                  onClick={() => switchLotTab("repo-closed")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "repo-closed" ? "bg-emerald-50 text-emerald-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("repoShell.clearedTitle")}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {isRepoView
                  ? selectedRepoLot
                    ? formatText("repoShell.lotSelectedHint", { name: selectedRepoLot.name })
                    : lotTab === "repo-open"
                      ? formatText("repoShell.holdingsHint", {
                          count: repoOpenLots.length,
                          amount: formatMoney(repo?.totalPrincipal ?? 0),
                          scope: institutionName || accountLabel,
                        })
                      : formatText("repoShell.clearedHint", { count: repoClosedLots.length })
                  : selectedLot
                    ? formatText("bondShell.lotSelectedHint", { name: selectedLot.name })
                    : lotTab === "held"
                      ? formatText("bondShell.holdingsHint", {
                          count: heldLots.length,
                          amount: formatMoney(totalPrincipal),
                          scope: institutionName || accountLabel,
                        })
                      : formatText("bondShell.clearedHint", { count: clearedLots.length })}
              </span>
              {isRepoView ? null : (
                <button
                  type="button"
                  onClick={() => setProductLibraryOpen(true)}
                  className="secondary-button h-7 gap-1 px-2 text-xs"
                  title={t("productLibrary.title.bond")}
                >
                  <Library className="h-3.5 w-3.5" />
                  {t("productLibrary.entryButton")}
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {isRepoView ? (
              <AdvancedDataTable
                key={`repo-${lotTab}`}
                storageKey="mmh_repo_lots_table_v1"
                columns={repoColumns}
                rows={repoVisibleLots}
                rowKey={(lot) => lot.id}
                minTableWidth={1080}
                emptyText={lotTab === "repo-open" ? t("repoShell.emptyHoldings") : t("repoShell.emptyCleared")}
                showFilters
                fillHeight
                toolbarMode="none"
                defaultSort={{ key: "principal", direction: "desc" }}
                summaryRow={repoSummaryRow}
                summaryRowPlacement="footer"
                onRowClick={(lot) => setSelectedRepoLotId((current) => current === lot.id ? null : lot.id)}
                rowClassName={(lot) => `cursor-pointer ${selectedRepoLotId === lot.id ? "bg-emerald-50 hover:bg-emerald-50" : "hover:bg-slate-50"}`}
              />
            ) : (
              <AdvancedDataTable
                key={lotTab}
                storageKey="mmh_bond_lots_table_v1"
                columns={lotColumns}
                rows={visibleLots}
                rowKey={(lot) => lot.id}
                minTableWidth={1120}
                emptyText={lotTab === "held" ? t("bondShell.emptyHoldings") : t("bondShell.emptyCleared")}
                showFilters
                fillHeight
                toolbarMode="none"
                defaultSort={{ key: "principal", direction: "desc" }}
                summaryRow={lotsSummaryRow}
                summaryRowPlacement="footer"
                onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
                rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
              />
            )}
          </div>
        </section>

        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-slate-800">
              {selectedEntryIds.size > 0 ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={batchDeleteEntries}
                    className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <span
                    className="h-6 rounded border border-blue-200 bg-blue-50 px-2 text-xs font-medium leading-6 tabular-nums text-blue-700"
                    title={t("fundShell.selectedTitle", { count: selectedEntryIds.size })}
                  >
                    {t("table.selectedCount", { count: selectedEntryIds.size })}
                  </span>
                  <span className="mx-1 h-4 w-px bg-slate-200" />
                </div>
              ) : null}
              <span className="flex h-6 shrink-0 items-center">{t("bondShell.entriesTitle")}</span>
              <span className="ml-2 shrink-0 text-xs font-normal text-slate-400">
                {selectedLot
                  ? formatText("bondShell.entryCountHint", { count: visibleEntries.length })
                  : formatText("bondShell.allEntryCountHint", { count: visibleEntries.length })}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
              <span className="mx-1 h-4 w-px bg-slate-200" />
              <DetailTablePaginationControls pager={entryPager} />
              <span className="text-slate-300">|</span>
              <button
                type="button"
                data-advanced-table-column-settings
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  window.dispatchEvent(new CustomEvent(BOND_ENTRY_COLUMN_SETTINGS_EVENT, {
                    detail: { anchorRect: { right: rect.right, bottom: rect.bottom } },
                  }));
                }}
                className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                title={t("basicDetail.guide.columnSettings.title")}
                aria-label={t("basicDetail.guide.columnSettings.title")}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_bond_entries_table_v1"
              columns={entryColumns}
              rows={visibleEntries}
              rowKey={(entry) => entry.id}
              minTableWidth={1020}
              emptyText={selectedLot ? t("bondShell.emptyRelatedEntries") : t("bondShell.emptyEntries")}
              fillHeight
              toolbarMode="none"
              columnVisibilityTriggerId={BOND_ENTRY_COLUMN_SETTINGS_EVENT}
              showColumnVisibilityButton={false}
              showFilters
              selectable
              selectOnRowClick
              selectAllScope="renderedRows"
              selectedKeys={selectedEntryIds}
              onSelectionChange={setSelectedEntryIds}
              rowActions={(entry) => (
                <EntryRowActions entryId={entry.id} edit={entry.edit} reconciled={isReconciled(entry.id)} />
              )}
              rowActionsWidth={112}
              rowActionsMinWidth={100}
              rowClassName={(entry) => (selectedEntryIds.has(entry.id) ? "bg-blue-50/70 hover:bg-blue-50/70" : "hover:bg-blue-50/40")}
              pagination={{
                page: entryPager.safePage,
                pageSize: entryPager.rows,
                all: entryPager.all,
                onPageChange: entryPager.goPage,
                onRowCountChange: setEntryRowCount,
              }}
              onRowsFitChange={entryPager.autoFit ? entryPager.fit : undefined}
            />
          </div>
        </section>
      </ResizableVerticalSplit>

      <ProductLibraryModal
        open={productLibraryOpen}
        family="bond"
        defaultInstitutionId={institutionId ?? null}
        onClose={() => setProductLibraryOpen(false)}
        onChanged={() => dispatchFinanceDataChanged({ reason: "product-library-save", accountIds: [accountId] })}
      />

    </div>
  );
}
