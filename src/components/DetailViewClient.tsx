"use client";

import { useState, useEffect, useMemo } from "react";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { EntryRowActions } from "./EntryRowActions";
import { BasicDetailRowCheckbox } from "./BasicDetailSelection";

/* Types */

export type DetailEntry = {
  id: string;
  date: string;
  amount: number;
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  note: string | null;
  fundSubtype: string | null;
  fundCode: string | null;
  fundName: string | null;
  source: string | null;
  fundProductType: string | null;
  fundUnits: number | null;
  fundNav: number | null;
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

function activityLabel(type: string, fundSubtype: string | null, source: string | null, amount: number): string {
  if (type === "investment" && fundSubtype) {
    const info = subtypeLabelInfo(fundSubtype, source, amount);
    return info?.label ?? formatType(type);
  }
  return formatType(type);
}

function subtypeLabelInfo(subtype: string | null | undefined, source: string | null | undefined, _amount: number): { label: string; cls: string; textCls?: string } | { label: string } | null {
  if (!subtype) return null;
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
  isInvestAccount,
  initialEntries,
  accountOptions,
  investmentProductTypeByAccountId,
}: {
  accountId: string;
  isInvestAccount: boolean;
  initialEntries: DetailEntry[];
  accountOptions: Array<{ id: string; label: string }>;
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
}) {
  const [entries, setEntries] = useState<DetailEntry[]>(() => []);
  const [entriesKey, setEntriesKey] = useState(0);

  // When initialEntries change (account switch), reset entries
  useEffect(() => {
    setEntries(initialEntries);
    setEntriesKey(k => k + 1);
  }, [initialEntries]);

  // Listen for mmh:fund:refresh → re-fetch from detail API
  useEffect(() => {
    const handler = () => {
      fetch(`/api/v1/transactions/detail?accountId=${encodeURIComponent(accountId)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setEntries(data.data.entries);
          }
        });
    };
    window.addEventListener("mmh:fund:refresh", handler);
    return () => window.removeEventListener("mmh:fund:refresh", handler);
  }, [accountId]);

  // Compute running balance from entries (ascending order)
  const balanceByEntryId = useMemo(() => {
    const map = new Map<string, number>();
    const asc = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const e of asc) {
      const amount = toNumber(e.amount);
      const isToAccount = !!accountId && e.toAccountId === accountId;
      running += isToAccount ? Math.abs(amount) : amount;
      map.set(e.id, running);
    }
    return map;
  }, [entries, accountId]);

  if (!entries.length) {
    return (
      <tbody className="text-sm">
        <tr>
          <td
            className="px-4 py-6 text-xs text-slate-500"
            colSpan={isInvestAccount ? 9 : 10}
          >
            暂无记录
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody className="text-sm">
      {entries.map((e) => {
        const dateStr = (e.date ?? "").slice(0, 10);
        const amount = toNumber(e.amount);
        const effectiveAmount =
          !accountId ? amount : e.toAccountId === accountId ? Math.abs(amount) : amount;
        const inflow = effectiveAmount > 0 ? effectiveAmount : null;
        const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
        const bal = balanceByEntryId.get(e.id) ?? null;
        const subtypeLabel = e.type === "investment" && e.fundSubtype
          ? subtypeLabelInfo(e.fundSubtype, e.source, amount)
          : null;
        const actLabel = e.type === "investment" && e.fundSubtype
          ? (subtypeLabel?.label ?? activityLabel(e.type, e.fundSubtype, e.source, amount))
          : activityLabel(e.type, e.fundSubtype, e.source, amount);

        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const isRedeemEditEntry =
          e.fundSubtype === "redeem" || e.fundSubtype === "switch_out";

        // Edit payload for EntryRowActions
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
                fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
                fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
                fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
                fundProductType: entryFundProductType,
                fundSubtype: e.fundSubtype,
                source: e.source,
                accountId: e.accountId,
                toAccountId: e.toAccountId,
                cashAccountId: isRedeemEditEntry ? e.toAccountId : e.accountId,
                toAccountName: e.toAccountName,
                fundArrivalDate: e.fundArrivalDate?.slice(0, 10),
                fundArrivalAmount:
                  e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
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
                categoryId: e.categoryId,
                categoryName: e.categoryName,
                accountId: e.accountId,
                accountName: e.accountName,
                fromAccountId: e.type === "transfer" ? e.accountId : undefined,
                toAccountId: e.toAccountId,
                toAccountName: e.toAccountName,
                tagIds: e.entryTags?.map((et) => et.tagId) ?? [],
              };

        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccountLabel =
          accountOptions.find((a) => a.id === e.accountId)?.label ?? e.accountName;
        const targetAccountLabel = e.toAccountId
          ? accountOptions.find((a) => a.id === e.toAccountId)?.label ?? e.toAccountName
          : null;
        const relatedAccountLabel = isToAccount ? sourceAccountLabel : targetAccountLabel;

        return (
          <tr key={e.id} className="hover:bg-blue-50/40">
            <td className="px-3 py-1 border-b border-slate-100">
              <BasicDetailRowCheckbox id={e.id} />
            </td>
            <td className="px-4 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-600">
              {dateStr}
            </td>
            <td className="px-3 py-1 border-b border-slate-100 text-right tabular-nums text-slate-700">
              {inflow !== null ? formatMoney(inflow) : ""}
            </td>
            <td className="px-3 py-1 border-b border-slate-100 text-right tabular-nums text-slate-700">
              {outflow !== null ? formatMoney(outflow) : ""}
            </td>
            <td className="px-3 py-1 border-b border-slate-100">
              {e.type === "investment" && subtypeLabel && "cls" in subtypeLabel ? (
                <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${subtypeLabel.cls}`}>
                  {subtypeLabel.label}
                </span>
              ) : (
                <span className="text-xs text-slate-700">{actLabel}</span>
              )}
            </td>
            {!isInvestAccount && (
              <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">
                {relatedAccountLabel ?? <span className="text-slate-300">-</span>}
              </td>
            )}
            <td className="px-3 py-1 border-b border-slate-100 text-right tabular-nums text-slate-700">
              <span className="text-xs">{bal !== null ? formatMoney(bal) : ""}</span>
            </td>
            <td
              className="px-3 py-1 border-b border-slate-100 text-slate-500 truncate max-w-[240px]"
              title={e.note ?? ""}
            >
              {e.entryTags && e.entryTags.length > 0 && (
                <span className="inline-flex flex-wrap gap-0.5 mr-1">
                  {e.entryTags.map((et) => {
                    const c = et.Tag?.color || "#3B82F6";
                    return (
                      <span
                        key={et.tagId}
                        className="text-[10px] px-1 py-0.5 rounded-full border leading-none"
                        style={{ backgroundColor: c + "18", color: c, borderColor: c + "60" }}
                      >
                        {et.Tag?.name}
                      </span>
                    );
                  })}
                </span>
              )}
              <span className="text-xs text-slate-500">{e.note ?? ""}</span>
            </td>
            <td className="px-3 py-1 border-b border-slate-100 text-slate-400"></td>
            <td className="w-24 px-2 py-1 border-b border-slate-100">
              <div className="flex justify-end">
                <EntryRowActions
                  entryId={e.id}
                  edit={(e.type !== "investment" ? otherEditPayload : editPayload) as any}
                />
              </div>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
