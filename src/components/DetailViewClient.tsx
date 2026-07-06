"use client";

import { useState, useEffect, useMemo, type ReactNode } from "react";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { EntryRowActions } from "./EntryRowActions";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "./AdvancedDataTable";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchReplaceButton,
  useBasicDetailSelection,
} from "./BasicDetailSelection";
import { useI18n } from "@/lib/i18n";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, getBalanceReconcileTarget } from "@/lib/balance-reconcile";

/* Types */

export type DetailEntry = {
  id: string;
  date: string;
  createdAt?: string | null;
  amount: number;
  runningBalance?: number | null;
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  accountInstitutionName?: string | null;
  counterpartyInstitutionId?: string | null;
  counterpartyInstitutionName?: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  toAccountInstitutionName?: string | null;
  note: string | null;
  toNote?: string | null;
  fundSubtype: string | null;
  fundCode: string | null;
  fundName: string | null;
  source: string | null;
  fundProductType: string | null;
  insuranceProductId?: string | null;
  insuranceAction?: string | null;
  insuranceProductName?: string | null;
  debtPrincipalAmount?: number | null;
  debtInterestAmount?: number | null;
  debtFeeAmount?: number | null;
  cashAccountId?: string | null;
  coverageAmount?: number | null;
  paymentTermYears?: number | null;
  fundUnits: number | null;
  fundNav: number | null;
  depositAnnualRate?: number | null;
  depositInterest?: number | null;
  depositSourceEntryId?: string | null;
  fundFee: number | null;
  fundConfirmDate: string | null;
  fundArrivalDate: string | null;
  fundArrivalAmount: number | null;
  entryTags: Array<{
    tagId: string;
    Tag: { name: string; color: string } | null;
  }>;
};

/* Helpers */

function subtypeLabelInfo(
  subtype: string | null | undefined,
  source: string | null | undefined,
  t: (key: string) => string,
): { label: string; cls: string; textCls?: string } | { label: string } | null {
  if (!subtype) return null;
  if (source === "deposit" || source === "deposit_manual") {
    const depositLabels: Record<string, { label: string; cls: string }> = {
      buy: { label: t("deposit.subtype.buy"), cls: "bg-blue-50 text-blue-600" },
      redeem: { label: t("deposit.subtype.redeem"), cls: "bg-amber-50 text-amber-600" },
    };
    const deposit = depositLabels[subtype];
    if (deposit) return deposit;
  }
  if (source === "insurance") {
    const insuranceLabels: Record<string, { label: string; cls: string }> = {
      buy: { label: "保险续期", cls: "bg-blue-50 text-blue-600" },
      redeem: { label: "保险回款", cls: "bg-emerald-50 text-emerald-600" },
      switch_out: { label: "保险回款", cls: "bg-emerald-50 text-emerald-600" },
    };
    const insurance = insuranceLabels[subtype];
    if (insurance) return insurance;
  }
  const baseLabels: Record<string, { label: string; cls: string }> = {
    buy: { label: t("fund.subtype.buy"), cls: "bg-blue-50 text-blue-600" },
    redeem: { label: t("fund.subtype.redeem"), cls: "bg-amber-50 text-amber-600" },
    switch_out: { label: t("fund.subtype.switch_out"), cls: "bg-purple-50 text-purple-600" },
    dividend_cash: { label: t("fund.subtype.dividend_cash"), cls: "bg-emerald-50 text-emerald-600" },
    dividend_reinvest: { label: t("fund.subtype.dividend_reinvest"), cls: "bg-emerald-50 text-emerald-600" },
    buy_failed: { label: t("fund.subtype.buy_failed"), cls: "bg-red-50 text-red-600" },
  };
  const base = baseLabels[subtype];
  if (!base) return base;
  if (subtype === "buy" && source) {
    const srcLabels: Record<string, { label: string; cls: string; textCls?: string }> = {
      regular_invest: { label: t("fund.subtype.regular_invest"), cls: "bg-blue-50 text-blue-600" },
      dividend: { label: t("fund.subtype.dividend"), cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
      switch: { label: t("fund.subtype.switch"), cls: "bg-blue-50 text-blue-600" },
    };
    return srcLabels[source] ?? base;
  }
  return base;
}

function formatType(type: string, t: (key: string) => string) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return type;
}

function debtActivityLabel(entry: {
  type: string;
  source: string | null;
  note: string | null;
  debtPrincipalAmount?: number | null;
  debtInterestAmount?: number | null;
  debtFeeAmount?: number | null;
}) {
  const hasDebtSplit =
    entry.debtPrincipalAmount != null ||
    entry.debtInterestAmount != null ||
    entry.debtFeeAmount != null;
  const source = String(entry.source ?? "");
  if (source === "debt_prepay_out") return "提前还款";
  if (source === "debt_collect_in") return "收回";
  if (
    hasDebtSplit ||
    source === "debt_repay_out" ||
    (source === "scheduled_task" && String(entry.note ?? "").includes("还贷款"))
  ) {
    return "贷款还款";
  }
  return null;
}

function isDebtRepaymentEntry(entry: {
  type: string;
  source: string | null;
  note: string | null;
  debtPrincipalAmount?: number | null;
  debtInterestAmount?: number | null;
  debtFeeAmount?: number | null;
}) {
  if (entry.type !== "transfer") return false;
  const source = String(entry.source ?? "");
  if (source === "debt_repay_out" || source === "debt_prepay_out" || source === "debt_collect_in") return true;
  if (entry.debtPrincipalAmount != null || entry.debtInterestAmount != null || entry.debtFeeAmount != null) return true;
  return source === "scheduled_task" && String(entry.note ?? "").includes("还贷款");
}

function activityLabel(type: string, fundSubtype: string | null, source: string | null, t: (key: string) => string, balanceTarget: number | null = null): string {
  if (balanceTarget != null && source === BALANCE_INITIALIZATION_SOURCE) return "初始";
  if (source === BALANCE_RECONCILE_SOURCE) return "校准";
  if (type === "investment" && fundSubtype) {
    const info = subtypeLabelInfo(fundSubtype, source, t);
    return info?.label ?? formatType(type, t);
  }
  return formatType(type, t);
}

/* Component */

export function DetailViewClient({
  accountId,
  initialEntries,
  accountOptions,
  investmentProductTypeByAccountId,
  compactRows = false,
  storageKey = "mmh_basic_detail_table_v1",
  refreshOnGlobalEvent = true,
  toolbarMode = "default",
  toolbarTitle,
  toolbarRightContent,
  emptyText = "暂无记录",
}: {
  accountId: string;
  isInvestAccount: boolean;
  initialEntries: DetailEntry[];
  accountOptions: Array<{ id: string; label: string }>;
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  storageKey?: string;
  refreshOnGlobalEvent?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarTitle?: ReactNode;
  toolbarRightContent?: ReactNode;
  emptyText?: string;
}) {
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const [refreshedEntries, setRefreshedEntries] = useState<{ accountId: string; entries: DetailEntry[] } | null>(null);
  const entries = refreshedEntries?.accountId === accountId ? refreshedEntries.entries : initialEntries;
  const colorScheme =
    typeof document === "undefined"
      ? "red_up_green_down"
      : getColorSchemeFromCookie(document.cookie ?? null);
  const inflowCls = pnlColor(1, colorScheme);
  const outflowCls = pnlColor(-1, colorScheme);
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;

  useEffect(() => {
    setRefreshedEntries((current) => (current?.accountId === accountId ? current : null));
  }, [accountId]);

  // Listen for mmh:fund:refresh → re-fetch from detail API
  useEffect(() => {
    if (!refreshOnGlobalEvent) return;
    const handler = (event: Event) => {
      const deletedEntryIds = (event as CustomEvent<{ deletedEntryIds?: string[] }>).detail?.deletedEntryIds ?? [];
      if (deletedEntryIds.length > 0) {
        const deletedSet = new Set(deletedEntryIds);
        setRefreshedEntries({ accountId, entries: entries.filter((entry) => !deletedSet.has(entry.id)) });
        setSelection(new Set());
      }
      const url = new URL(window.location.href);
      const detailAll = url.searchParams.get("detailAll") === "1";
      const detailPage = url.searchParams.get("detailPage") ?? "1";
      const pageSize = url.searchParams.get("pageSize") ?? "20";
      const params = new URLSearchParams({
        accountId,
        page: detailAll ? "1" : detailPage,
        pageSize: detailAll ? "5000" : pageSize,
      });
      fetch(`/api/v1/transactions/detail?${params.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (data?.ok && Array.isArray(data?.data?.entries)) {
            setRefreshedEntries({ accountId, entries: data.data.entries });
            setSelection(new Set());
          }
        })
        .catch(() => {});
    };
    window.addEventListener("mmh:fund:refresh", handler);
    return () => window.removeEventListener("mmh:fund:refresh", handler);
  }, [accountId, entries, refreshOnGlobalEvent, setSelection]);

  const columns = useMemo<AdvancedDataTableColumn<DetailEntry>[]>(() => [
    {
      key: "date",
      label: t("detail.column.date"),
      width: 96,
      minWidth: 78,
      filterKind: "dateRange",
      filterText: (e) => (e.date ?? "").slice(0, 10),
      render: (e) => <span className="tabular-nums text-slate-600">{(e.date ?? "").slice(0, 10)}</span>,
    },
    {
      key: "inflow",
      label: t("detail.column.inflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      render: (e) => {
        const amount = toNumber(e.amount);
        const effectiveAmount = !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
        const inflow = effectiveAmount > 0 ? effectiveAmount : null;
        return <span className={`tabular-nums ${inflow !== null ? inflowCls : "text-slate-700"}`}>{inflow !== null ? formatMoney(inflow) : ""}</span>;
      },
    },
    {
      key: "outflow",
      label: t("detail.column.outflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      render: (e) => {
        const amount = toNumber(e.amount);
        const effectiveAmount = !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
        const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
        return <span className={`tabular-nums ${outflow !== null ? outflowCls : "text-slate-700"}`}>{outflow !== null ? formatMoney(outflow) : ""}</span>;
      },
    },
    {
      key: "type",
      label: t("detail.column.activityType"),
      width: 96,
      minWidth: 74,
      filterText: (e) => {
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const debtLabel = debtActivityLabel(e);
        if (debtLabel) return debtLabel;
        const balanceTarget = getBalanceReconcileTarget(e);
        const subtypeLabel = e.type === "investment" && e.fundSubtype
          ? subtypeLabelInfo(e.fundSubtype, displaySource, t)
          : null;
        return e.type === "investment" && e.fundSubtype
          ? (subtypeLabel?.label ?? activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget))
          : activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
      },
      render: (e) => {
        const dateStr = (e.date ?? "").slice(0, 10);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const balanceTarget = getBalanceReconcileTarget(e);
        const debtLabel = debtActivityLabel(e);
        const subtypeLabel = e.type === "investment" && e.fundSubtype
          ? subtypeLabelInfo(e.fundSubtype, displaySource, t)
          : null;
        const actLabel = debtLabel ?? (e.type === "investment" && e.fundSubtype
          ? (subtypeLabel?.label ?? activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget))
          : activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget));
        return (
          <>
            <span className="sr-only">{dateStr}</span>
              {debtLabel ? (
                <span className="rounded bg-cyan-50 px-1 py-0.5 text-[10px] font-medium text-cyan-700">
                  {debtLabel}
                </span>
              ) : balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE ? (
                <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600">
                  初始
                </span>
              ) : e.source === BALANCE_RECONCILE_SOURCE ? (
                <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700">
                  校准
                </span>
              ) : e.type === "investment" && subtypeLabel && "cls" in subtypeLabel ? (
                <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${subtypeLabel.cls}`}>
                  {subtypeLabel.label}
                </span>
              ) : (
                <span className="text-xs text-slate-700">{actLabel}</span>
              )}
          </>
        );
      },
    },
    {
      key: "category",
      label: t("detail.column.category"),
      width: 140,
      minWidth: 90,
      filterText: (e) => getInsuranceDetailCategoryName(e),
      render: (e) => {
        const text = getInsuranceDetailCategoryName(e);
        return <span className="block truncate text-slate-500" title={text}>{text || <span className="text-slate-300">-</span>}</span>;
      },
    },
    {
      key: "counterpartyInstitution",
      label: t("detail.column.counterparty"),
      width: 140,
      minWidth: 96,
      hideable: true,
      defaultHidden: true,
      filterText: (e) => e.counterpartyInstitutionName ?? "",
      render: (e) => <span className="block truncate text-slate-500" title={e.counterpartyInstitutionName ?? ""}>{e.counterpartyInstitutionName || <span className="text-slate-300">-</span>}</span>,
    },
    {
      key: "related",
      label: t("detail.column.relatedAccount"),
      width: 150,
      minWidth: 100,
      filterText: (e) => {
        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccountLabel = accountOptions.find((a) => a.id === e.accountId)?.label ?? e.accountName;
        const targetAccountLabel = e.toAccountId ? accountOptions.find((a) => a.id === e.toAccountId)?.label ?? e.toAccountName : null;
        return isToAccount ? sourceAccountLabel ?? "" : targetAccountLabel ?? "";
      },
      render: (e) => {
        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccountLabel = accountOptions.find((a) => a.id === e.accountId)?.label ?? e.accountName;
        const targetAccountLabel = e.toAccountId ? accountOptions.find((a) => a.id === e.toAccountId)?.label ?? e.toAccountName : null;
        const relatedAccountLabel = isToAccount ? sourceAccountLabel : targetAccountLabel;
        return <span className="block truncate text-slate-500" title={relatedAccountLabel ?? ""}>{relatedAccountLabel ?? <span className="text-slate-300">-</span>}</span>;
      },
    },
    { key: "balance", label: t("detail.column.balance"), width: 110, minWidth: 82, align: "right", render: (e) => <span className="text-xs tabular-nums text-slate-700">{e.runningBalance != null ? formatMoney(toNumber(e.runningBalance)) : ""}</span> },
    {
      key: "tags",
      label: t("detail.column.tags"),
      width: 150,
      minWidth: 90,
      hideable: true,
      filterText: (e) => e.entryTags?.map((et) => et.Tag?.name ?? "").join(" ") ?? "",
      render: (e) => e.entryTags && e.entryTags.length > 0 ? (
        <span className="inline-flex flex-wrap gap-0.5">
          {e.entryTags.map((et) => {
            const c = et.Tag?.color || "#3B82F6";
            return (
              <span
                key={et.tagId}
                className="rounded-full border px-1 py-0.5 text-[10px] leading-none"
                style={{ backgroundColor: c + "18", color: c, borderColor: c + "60" }}
              >
                {et.Tag?.name}
              </span>
            );
          })}
        </span>
      ) : null,
    },
    {
      key: "remark",
      label: t("detail.column.remark"),
      width: 220,
      minWidth: 120,
      hideable: true,
      filterText: (e) => getInsuranceDetailNote(e),
      render: (e) => {
        const text = getInsuranceDetailNote(e);
        return <span className="block truncate text-slate-500" title={text}>{text}</span>;
      },
    },
    {
      key: "secondRemark",
      label: t("detail.column.secondRemark"),
      width: 180,
      minWidth: 110,
      hideable: true,
      defaultHidden: true,
      filterText: (e) => e.toNote ?? "",
      render: (e) => <span className="block truncate text-slate-500" title={e.toNote ?? ""}>{e.toNote || <span className="text-slate-300">-</span>}</span>,
    },
    { key: "attachment", label: t("detail.column.attachment"), width: 60, minWidth: 46, align: "center", hideable: true, render: () => <span className="text-slate-400" /> },
    {
      key: "actions",
      label: t("detail.column.actions"),
      width: 92,
      minWidth: 76,
      align: "right",
      render: (e) => {
        const dateStr = (e.date ?? "").slice(0, 10);
        const amount = toNumber(e.amount);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const isRedeemEditEntry = e.fundSubtype === "redeem" || e.fundSubtype === "switch_out";
        const editPayload =
          e.type !== "investment"
            ? undefined
            : {
                id: e.id,
                transactionId: e.id,
                date: dateStr,
                confirmDate: e.fundConfirmDate?.slice(0, 10),
                type: e.type,
                amount,
                note: e.note ?? "",
                fundCode: e.fundCode,
                fundName: e.fundName,
                insuranceProductId: e.insuranceProductId ?? null,
                insuranceAction: e.insuranceAction ?? null,
                insuranceProductName: e.insuranceProductName ?? null,
                fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
                fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
                depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
                depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,
                depositSourceEntryId: e.depositSourceEntryId ?? null,
                fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
                fundProductType: entryFundProductType,
                fundSubtype: e.fundSubtype,
                source: e.source,
                accountId: e.accountId,
                toAccountId: e.toAccountId,
                cashAccountId: isRedeemEditEntry ? e.toAccountId : e.accountId,
                toAccountName: e.toAccountName,
                fundArrivalDate: e.fundArrivalDate?.slice(0, 10),
                fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
              };
        const otherEditPayload =
          e.type === "investment"
            ? undefined
            : {
                id: e.id,
                transactionId: e.id,
                date: dateStr,
                type: e.type,
                amount,
                note: e.note ?? "",
                toNote: e.toNote ?? "",
                categoryId: e.categoryId,
                categoryName: e.categoryName,
                accountId: e.accountId,
                accountName: e.accountName,
                counterpartyInstitutionId: e.counterpartyInstitutionId,
                counterpartyInstitutionName: e.counterpartyInstitutionName,
                fromAccountId: e.type === "transfer" ? e.accountId : undefined,
                toAccountId: e.toAccountId,
                toAccountName: e.toAccountName,
                tagIds: e.entryTags?.map((et) => et.tagId) ?? [],
              };
        const balanceReconcileTarget = getBalanceReconcileTarget(e);
        const balanceReconcileEditEvent = balanceReconcileTarget == null || (e.source !== BALANCE_RECONCILE_SOURCE && e.source !== BALANCE_INITIALIZATION_SOURCE) ? undefined : {
          name: "mmh:balance-reconcile:edit",
          detail: {
            entryId: e.id,
            accountId: e.accountId,
            accountName: e.accountName,
            date: dateStr,
            amount: balanceReconcileTarget,
            source: e.source,
          },
        };
        const isDebtRepayment = isDebtRepaymentEntry(e);
        const debtPrincipalAmount = Math.abs(toNumber(e.debtPrincipalAmount ?? e.amount));
        const debtInterestAmount = Math.abs(toNumber(e.debtInterestAmount ?? 0));
        const debtFeeAmount = Math.abs(toNumber(e.debtFeeAmount ?? 0));
        const debtSource = String(e.source ?? "");
        const isDebtCollectIn = debtSource === "debt_collect_in";
        const debtAccountIdForEdit = isDebtCollectIn ? (e.accountId ?? "") : (e.toAccountId ?? "");
        const cashAccountIdForEdit = isDebtCollectIn ? (e.toAccountId ?? "") : (e.accountId ?? "");
        const debtEditEvent =
          !balanceReconcileEditEvent && isDebtRepayment
            ? {
                name: "mmh:debt:create",
                detail: {
                  editEntryId: e.id,
                  mode: isDebtCollectIn ? ("collect_in" as const) : e.source === "debt_prepay_out" ? ("prepay_out" as const) : ("repay_out" as const),
                  defaultDebtAccountId: debtAccountIdForEdit,
                  defaultCashAccountId: cashAccountIdForEdit,
                  defaultDate: dateStr,
                  defaultPrincipal: debtPrincipalAmount,
                  defaultInterest: debtInterestAmount,
                  defaultPenalty: debtFeeAmount,
                },
              }
            : undefined;

        return (
          <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
            <EntryRowActions
              entryId={e.id}
              edit={(balanceReconcileEditEvent || debtEditEvent) ? undefined : (e.type !== "investment" ? otherEditPayload : editPayload) as any}
              customEditEvent={balanceReconcileEditEvent ?? debtEditEvent}
            />
          </div>
        );
      },
    },
  ], [accountId, accountOptions, inflowCls, investmentProductTypeByAccountId, outflowCls, t]);

  const customToolbarLeft = toolbarMode === "custom" ? (
    <div className="flex min-w-0 items-center gap-2">
      {toolbarTitle ? <div className="text-sm font-semibold text-slate-800">{toolbarTitle}</div> : null}
      {selectedCount > 0 ? <span className="text-xs text-slate-500">{tf("detail.selectedCount", { count: selectedCount })}</span> : null}
      {selectedCount > 0 ? <BasicDetailBatchReplaceButton accountOptions={accountOptions} /> : null}
      {selectedCount > 0 ? <BasicDetailBatchDeleteButton /> : null}
    </div>
  ) : undefined;

  return (
    <AdvancedDataTable
      storageKey={storageKey}
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1160}
      emptyText={emptyText === "暂无记录" ? t("detail.empty") : emptyText}
      selectable
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      batchActionSlot={toolbarMode === "default" ? (
        <>
          <BasicDetailBatchReplaceButton accountOptions={accountOptions} />
          <BasicDetailBatchDeleteButton />
        </>
      ) : undefined}
      rowClassName={() => "hover:bg-blue-50/40"}
      fillHeight
      compactRows={compactRows}
      toolbarMode={toolbarMode}
      toolbarLeftContent={customToolbarLeft}
      toolbarRightContent={toolbarRightContent}
    />
  );
}
