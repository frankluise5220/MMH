"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Landmark, Library, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  AdvancedDataTable,
  type AdvancedDataTableColumn,
  type AdvancedDataTableSummaryRow,
} from "./AdvancedDataTable";
import { DetailTablePaginationControls } from "./DetailTablePaginationControls";
import { EntryRowActions, type EditPayload } from "./EntryRowActions";
import { ProductLibraryModal } from "./ProductLibraryModal";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { FOLDER_TAB_STRIP, FolderTabRuler, folderTabClass, folderTabNeighbors } from "@/app/login/FolderTabs";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import {
  dispatchFinanceDataChanged,
  financeChangeAffectsAccount,
  financeChangeNeedsRowRefresh,
  FINANCE_DATA_CHANGED_EVENT,
  type FinanceDataChangedDetail,
} from "@/lib/client/refresh";
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

type LotTab = "held" | "cleared";

const BOND_ENTRY_COLUMN_SETTINGS_EVENT = "mmh:bond-entries:column-settings";

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
}) {
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
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

  const heldLots = useMemo(() => lots.filter((lot) => lot.status === "open"), [lots]);
  const clearedLots = useMemo(() => lots.filter((lot) => lot.status === "closed"), [lots]);
  const visibleLots = lotTab === "held" ? heldLots : clearedLots;

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId],
  );

  function switchLotTab(tab: LotTab) {
    setLotTab(tab);
    setSelectedLotId(null);
  }

  const activeEntries = entries;
  const visibleEntries = useMemo(() => {
    if (!selectedLot) return activeEntries;
    const relatedIds = new Set(selectedLot.relatedEntryIds);
    return activeEntries.filter((entry) => relatedIds.has(entry.id));
  }, [activeEntries, selectedLot]);
  const visibleEntryIds = useMemo(() => visibleEntries.map((entry) => entry.id), [visibleEntries]);
  // 债券明细行就是背后的现金流水：现金明细页锁定的记录，这里同样要显示锁并能就地解锁。
  const { isReconciled } = useEntryReconcileState(visibleEntryIds);

  // 换一只债券要回到第一页，effect 挪到分页状态点之后声明（见下方 entryPager）。

  useEffect(() => {
    setSelectedEntryIds(new Set());
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
      const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail ?? {};
      // 只排除明确不动行文本的事件（行情 / 净值、对账锁）。balanceChanged === false
      // 只说明余额字段没变，备注 / 分类 / 标签仍可能改了，不能整表跳过。
      if (!financeChangeNeedsRowRefresh(detail)) return;
      if (!financeChangeAffectsAccount(detail, accountId)) return;
      router.refresh();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [accountId, router]);

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
  }, [selectedLotId, goEntryPage]);

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

  // 两个 FT 页签（「持有债券 / 已了结」，与股票视图的「持仓 / 清仓」同构）：
  // 持有与了结同属「这个债券账户里的东西」，共用一条页签条 + 一张 FT 卡片，
  // 切换只换卡片里的表格（列、空态、汇总行都跟着 lotTab 走）。
  // 逆回购已移到股票视图（股票页签下的「逆回购」）。
  const lotTabItems = [
    { id: "held" as const, label: t("bondShell.holdingsTitle") },
    { id: "cleared" as const, label: t("bondShell.clearedTitle") },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey="mmh:bond:split-height"
        hasLowerPane
        defaultUpperHeight={360}
        separatorLabel={t("bondShell.resizeLabel")}
        separatorTitle={t("bondShell.resizeTitle")}
      >
        {/* FT 卡片：页签条是**流内**元素（高 = 页签内容，底边 = 卡片上缘、不随窗格伸缩），
            页签组靠左、等宽（隐形量尺按最长标签定宽），几何见 `@/app/login/FolderTabs` 文件头。 */}
        <div className="relative flex h-full min-h-0 flex-col">
          <div className={FOLDER_TAB_STRIP}>
            <div className="flex h-full max-w-[calc(100%-9rem)] items-start gap-1.5">
              {lotTabItems.map((tab, index) => {
                const active = tab.id === lotTab;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => switchLotTab(tab.id)}
                    className={folderTabClass(
                      active,
                      index === lotTabItems.length - 1,
                      "stretch",
                      index === 0,
                      folderTabNeighbors(lotTabItems.map((item) => item.id), tab.id, lotTab),
                    )}
                  >
                    {/* 活动页签不能 overflow-hidden（下缘凹角画在按钮盒外），裁切交给内层 span。 */}
                    <span className="relative block overflow-hidden whitespace-nowrap">
                      <FolderTabRuler labels={lotTabItems.map((item) => item.label)} />
                      {tab.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 内容板：`ft-card-surface-fill` 撑满窗格。信息条挂 `data-advanced-table-toolbar`：
              顶部 12px 留白归零、底色取卡片色，于是「页签条 → 信息条 → 表头灰带」同一块底色。 */}
          <div className="ft-card-surface ft-card-surface-fill">
            <div data-advanced-table-toolbar className="flex shrink-0 flex-wrap items-center justify-between gap-2">
              {/* 不再显示「机构 共 N 只持有中债券，持仓本金 X」这类汇总句：页签已经写明
                  「持有债券 / 已了结」，只数与本金由表格表头汇总、底部合计行给出，
                  空账户时这句话只剩 0 和 0.00。保留「已选中」提示（与下方明细收窄联动）。 */}
              {selectedLot ? (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-left text-xs text-slate-500">
                  <span className="flex h-6 min-w-0 items-center gap-1.5">
                    <Landmark className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span className="min-w-0 truncate">
                      {formatText("bondShell.lotSelectedHint", { name: selectedLot.name })}
                    </span>
                  </span>
                </div>
              ) : null}
              {/* `ml-auto`：左侧提示不渲染时按钮仍贴右，不跟着 justify-between 滑到左边。 */}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setProductLibraryOpen(true)}
                  className="secondary-button h-7 gap-1 px-2 text-xs"
                  title={t("productLibrary.title.bond")}
                >
                  <Library className="h-3.5 w-3.5" />
                  {t("productLibrary.entryButton")}
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
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
                summaryRow={lotsSummaryRow}
                summaryRowPlacement="footer"
                onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
                rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
              />
            </div>
          </div>
        </div>

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
