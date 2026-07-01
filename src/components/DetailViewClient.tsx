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

function activityLabel(type: string, fundSubtype: string | null, source: string | null): string {
  if (type === "investment" && fundSubtype) {
    const info = subtypeLabelInfo(fundSubtype, source);
    return info?.label ?? formatType(type);
  }
  return formatType(type);
}

function subtypeLabelInfo(subtype: string | null | undefined, source: string | null | undefined): { label: string; cls: string; textCls?: string } | { label: string } | null {
  if (!subtype) return null;
  if (source === "deposit" || source === "deposit_manual") {
    const depositLabels: Record<string, { label: string; cls: string }> = {
      buy: { label: "存入", cls: "bg-blue-50 text-blue-600" },
      redeem: { label: "取出", cls: "bg-amber-50 text-amber-600" },
    };
    const deposit = depositLabels[subtype];
    if (deposit) return deposit;
  }
  const baseLabels: Record<string, { label: string; cls: string }> = {
    buy: { label: "买入", cls: "bg-blue-50 text-blue-600" },
    redeem: { label: "赎回", cls: "bg-amber-50 text-amber-600" },
    switch_out: { label: "转出", cls: "bg-purple-50 text-purple-600" },
    dividend_cash: { label: "现金分红", cls: "bg-emerald-50 text-emerald-600" },
    dividend_reinvest: { label: "红利再投", cls: "bg-emerald-50 text-emerald-600" },
    buy_failed: { label: "认购失败", cls: "bg-red-50 text-red-600" },
  };
  const base = baseLabels[subtype];
  if (!base) return base;
  if (subtype === "buy" && source) {
    const srcLabels: Record<string, { label: string; cls: string; textCls?: string }> = {
      regular_invest: { label: "定投", cls: "bg-blue-50 text-blue-600" },
      dividend: { label: "红利转投", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
      switch: { label: "转入", cls: "bg-blue-50 text-blue-600" },
    };
    return srcLabels[source] ?? base;
  }
  return base;
}

function formatType(type: string) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
  return type;
}

/* Component */

export function DetailViewClient({
  accountId,
  initialEntries,
  accountOptions,
  investmentProductTypeByAccountId,
  compactRows = false,
  toolbarMode = "default",
  toolbarTitle,
  toolbarRightContent,
}: {
  accountId: string;
  isInvestAccount: boolean;
  initialEntries: DetailEntry[];
  accountOptions: Array<{ id: string; label: string }>;
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarTitle?: ReactNode;
  toolbarRightContent?: ReactNode;
}) {
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
    const handler = () => {
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
  }, [accountId, setSelection]);

  const columns = useMemo<AdvancedDataTableColumn<DetailEntry>[]>(() => [
    {
      key: "date",
      label: "日期",
      width: 96,
      minWidth: 78,
      filterKind: "dateRange",
      filterText: (e) => (e.date ?? "").slice(0, 10),
      render: (e) => <span className="tabular-nums text-slate-600">{(e.date ?? "").slice(0, 10)}</span>,
    },
    {
      key: "inflow",
      label: "流入",
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
      label: "流出",
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
      label: "活动类型",
      width: 96,
      minWidth: 74,
      filterText: (e) => {
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const subtypeLabel = e.type === "investment" && e.fundSubtype
          ? subtypeLabelInfo(e.fundSubtype, displaySource)
          : null;
        return e.type === "investment" && e.fundSubtype
          ? (subtypeLabel?.label ?? activityLabel(e.type, e.fundSubtype, displaySource))
          : activityLabel(e.type, e.fundSubtype, displaySource);
      },
      render: (e) => {
        const dateStr = (e.date ?? "").slice(0, 10);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const subtypeLabel = e.type === "investment" && e.fundSubtype
          ? subtypeLabelInfo(e.fundSubtype, displaySource)
          : null;
        const actLabel = e.type === "investment" && e.fundSubtype
          ? (subtypeLabel?.label ?? activityLabel(e.type, e.fundSubtype, displaySource))
          : activityLabel(e.type, e.fundSubtype, displaySource);
        return (
          <>
            <span className="sr-only">{dateStr}</span>
              {e.type === "investment" && subtypeLabel && "cls" in subtypeLabel ? (
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
      label: "分类",
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
      label: "收支机构",
      width: 140,
      minWidth: 96,
      hideable: true,
      defaultHidden: true,
      filterText: (e) => e.counterpartyInstitutionName ?? "",
      render: (e) => <span className="block truncate text-slate-500" title={e.counterpartyInstitutionName ?? ""}>{e.counterpartyInstitutionName || <span className="text-slate-300">-</span>}</span>,
    },
    {
      key: "related",
      label: "关联账户",
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
    { key: "balance", label: "余额", width: 110, minWidth: 82, align: "right", render: (e) => <span className="text-xs tabular-nums text-slate-700">{e.runningBalance != null ? formatMoney(toNumber(e.runningBalance)) : ""}</span> },
    {
      key: "tags",
      label: "标签",
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
      label: "备注",
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
      label: "第二备注",
      width: 180,
      minWidth: 110,
      hideable: true,
      defaultHidden: true,
      filterText: (e) => e.toNote ?? "",
      render: (e) => <span className="block truncate text-slate-500" title={e.toNote ?? ""}>{e.toNote || <span className="text-slate-300">-</span>}</span>,
    },
    { key: "attachment", label: "附件", width: 60, minWidth: 46, align: "center", hideable: true, render: () => <span className="text-slate-400" /> },
    {
      key: "actions",
      label: "操作",
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
                insuranceProductId: (e as { insuranceProductId?: string | null }).insuranceProductId ?? null,
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

        return (
          <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
            <EntryRowActions
              entryId={e.id}
              edit={(e.type !== "investment" ? otherEditPayload : editPayload) as any}
            />
          </div>
        );
      },
    },
  ], [accountId, accountOptions, inflowCls, investmentProductTypeByAccountId, outflowCls]);

  const customToolbarLeft = toolbarMode === "custom" ? (
    <div className="flex min-w-0 items-center gap-2">
      {toolbarTitle ? <div className="text-sm font-semibold text-slate-800">{toolbarTitle}</div> : null}
      {selectedCount > 0 ? <span className="text-xs text-slate-500">已选 {selectedCount}</span> : null}
      {selectedCount > 0 ? <BasicDetailBatchReplaceButton accountOptions={accountOptions} /> : null}
      {selectedCount > 0 ? <BasicDetailBatchDeleteButton /> : null}
    </div>
  ) : undefined;

  return (
    <AdvancedDataTable
      storageKey="mmh_basic_detail_table_v1"
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1160}
      emptyText="暂无记录"
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
