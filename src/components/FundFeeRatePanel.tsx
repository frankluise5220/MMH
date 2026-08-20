"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Percent, Plus, X } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export type FeeRateRecord = {
  fundCode: string;
  fundName: string | null;
  buyRate: number | null;
  redeemRate: number | null;
  buyEffectiveDate: string | null;
  redeemEffectiveDate: string | null;
  effectiveDate: string | null;
  placeholder?: boolean;
};

type FeeRateListResponse = {
  ok?: boolean;
  rows?: FeeRateRecord[];
  error?: string;
};

function normalizeRateValue(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

/**
 * Editable fund fee-rate table. Each row is one stored rate record (a fund can
 * have multiple historical rates keyed by effectiveDate). Renders the table
 * body only, so it can be embedded into the rules dialog's "fee rates" tab.
 */
export function FundFeeRatePanel({
  accountId,
  initialFundCode,
  onSaved,
  compact = false,
}: {
  accountId: string;
  /** When set, the panel edits only this fund's rates (row-action entry point). */
  initialFundCode?: string | null;
  onSaved?: () => void;
  /** Compact variant for embedding inside a dialog. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const todayStr = (() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  })();
  const [rows, setRows] = useState<FeeRateRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [newFundCode, setNewFundCode] = useState(initialFundCode ?? "");
  const [newBuyRate, setNewBuyRate] = useState("");
  const [newRedeemRate, setNewRedeemRate] = useState("");
  const [newEffectiveDate, setNewEffectiveDate] = useState(todayStr);

  const loadRows = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      const url = `/api/v1/fund/fee-rate?accountId=${encodeURIComponent(accountId)}&list=1`;
      const response = await fetch(url, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as FeeRateListResponse | null;
      if (!data?.ok) {
        setError(data?.error || t("fundFeeRates.loadFailed"));
        return;
      }
      let list = Array.isArray(data.rows) ? data.rows : [];
      if (initialFundCode) {
        list = list.filter((row) => row.fundCode === initialFundCode);
      }
      setRows(list);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundFeeRates.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountId, initialFundCode, t]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  const updateRow = useCallback((index: number, patch: Partial<FeeRateRecord>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch, placeholder: false } : row)));
    setDirty(true);
  }, []);

  const removeRow = useCallback((index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
    setDirty(true);
  }, []);

  const addRow = useCallback(() => {
    // The fund code comes from the panel context (single-fund mode); no manual
    // code entry is needed. In account-level mode fall back to the input value.
    const code = (initialFundCode ?? newFundCode).trim();
    if (!code) return;
    const hasBuyRate = newBuyRate.trim() !== "";
    const hasRedeemRate = newRedeemRate.trim() !== "";
    if (!hasBuyRate && !hasRedeemRate) return;
    const buyRate = hasBuyRate ? normalizeRateValue(newBuyRate) : null;
    const redeemRate = hasRedeemRate ? normalizeRateValue(newRedeemRate) : null;
    if (newEffectiveDate.trim()) {
      setRows((current) => [
        ...current,
        {
          fundCode: code,
          fundName: null,
          buyRate,
          redeemRate,
          buyEffectiveDate: hasBuyRate ? newEffectiveDate.trim() : null,
          redeemEffectiveDate: hasRedeemRate ? newEffectiveDate.trim() : null,
          effectiveDate: newEffectiveDate.trim(),
        },
      ]);
    } else {
      // Without a date, update the latest row for this fund or create a
      // date-less placeholder that will receive today's date when saved.
      const lastIndex = rows.map((r, i) => ({ r, i })).reverse().find(({ r }) => r.fundCode === code)?.i;
      if (lastIndex != null) {
        setRows((current) => current.map((row, i) => (i === lastIndex
          ? {
              ...row,
              buyRate: buyRate ?? row.buyRate,
              redeemRate: redeemRate ?? row.redeemRate,
              buyEffectiveDate: buyRate != null ? null : row.buyEffectiveDate,
              redeemEffectiveDate: redeemRate != null ? null : row.redeemEffectiveDate,
              effectiveDate: null,
            }
          : row)));
      } else {
        setRows((current) => [
          ...current,
          {
            fundCode: code,
            fundName: null,
            buyRate,
            redeemRate,
            buyEffectiveDate: null,
            redeemEffectiveDate: null,
            effectiveDate: null,
          },
        ]);
      }
    }
    setNewFundCode(initialFundCode ?? "");
    setNewBuyRate("");
    setNewRedeemRate("");
    setNewEffectiveDate(todayStr);
    setError("");
    setDirty(true);
  }, [initialFundCode, newFundCode, newBuyRate, newRedeemRate, newEffectiveDate, rows, todayStr]);

  const saveRows = useCallback(async () => {
    if (!accountId) return;
    setSaving(true);
    setError("");
    try {
      const payloadRows: Array<{
        fundCode: string;
        feeType: "buy" | "redeem";
        rate: number;
        effectiveDate?: string;
      }> = [];
      for (const row of rows) {
        if (row.placeholder) continue;
        if (row.buyRate != null) {
          payloadRows.push({
            fundCode: row.fundCode,
            feeType: "buy",
            rate: row.buyRate,
            effectiveDate: row.buyEffectiveDate ?? row.effectiveDate ?? undefined,
          });
        }
        if (row.redeemRate != null) {
          payloadRows.push({
            fundCode: row.fundCode,
            feeType: "redeem",
            rate: row.redeemRate,
            effectiveDate: row.redeemEffectiveDate ?? row.effectiveDate ?? undefined,
          });
        }
      }
      const payload = {
        accountId,
        replace: true,
        fundCode: initialFundCode || undefined,
        rows: payloadRows,
      };
      const response = await fetch("/api/v1/fund/fee-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error || t("fundFeeRates.saveFailed"));
      setDirty(false);
      onSaved?.();
      void loadRows();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundFeeRates.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [accountId, initialFundCode, rows, onSaved, t, loadRows]);

  return (
    <div className={compact ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-1 flex-col"}>
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
        {initialFundCode ? (
          <span className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-700">
            {initialFundCode}
          </span>
        ) : (
          <input
            type="text"
            value={newFundCode}
            onChange={(e) => setNewFundCode(e.target.value)}
            placeholder={t("fundFeeRates.newFundCodePlaceholder")}
            className="h-8 w-28 rounded-md border border-slate-200 px-2 text-xs outline-none focus:border-blue-400"
          />
        )}
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            step="0.01"
            value={newBuyRate}
            onChange={(e) => setNewBuyRate(e.target.value)}
            placeholder={t("fundFeeRates.buyRatePlaceholder")}
            className="h-8 w-20 rounded-md border border-slate-200 px-2 text-right text-xs tabular-nums outline-none focus:border-blue-400"
          />
          <Percent className="h-3 w-3 shrink-0 text-slate-400" />
        </div>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            step="0.01"
            value={newRedeemRate}
            onChange={(e) => setNewRedeemRate(e.target.value)}
            placeholder={t("fundFeeRates.redeemRatePlaceholder")}
            className="h-8 w-20 rounded-md border border-slate-200 px-2 text-right text-xs tabular-nums outline-none focus:border-blue-400"
          />
          <Percent className="h-3 w-3 shrink-0 text-slate-400" />
        </div>
        <input
          type="date"
          value={newEffectiveDate}
          onChange={(e) => setNewEffectiveDate(e.target.value)}
          className="h-8 rounded-md border border-slate-200 px-1.5 text-xs outline-none focus:border-blue-400"
        />
        <button
          type="button"
          onClick={addRow}
          disabled={!newFundCode.trim() || (!newBuyRate.trim() && !newRedeemRate.trim())}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("fundFeeRates.addRate")}
        </button>
      </div>

      <div className={`min-h-0 overflow-auto rounded-md border border-slate-200 ${compact ? "max-h-[280px]" : "flex-1"}`} style={{ scrollbarGutter: "stable" }}>
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-400">{t("fundFeeRates.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-400">{t("fundFeeRates.empty")}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.fund")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundFeeRates.col.buyRate")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundFeeRates.col.redeemRate")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundFeeRates.col.effectiveDate")}</th>
                <th className="w-10 border-b border-slate-200 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.fundCode}-${row.effectiveDate ?? "latest"}-${index}`} className="hover:bg-slate-50">
                  <td className="border-b border-slate-100 px-3 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800" title={row.fundName ?? undefined}>
                        {row.fundName || "-"}
                      </div>
                      <div className="text-[11px] tabular-nums text-slate-400">{row.fundCode}</div>
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={row.buyRate ?? ""}
                        onChange={(e) => updateRow(index, { buyRate: e.target.value === "" ? null : normalizeRateValue(e.target.value), buyEffectiveDate: row.effectiveDate })}
                        className="h-7 w-20 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                      <Percent className="h-3 w-3 shrink-0 text-slate-400" />
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={row.redeemRate ?? ""}
                        onChange={(e) => updateRow(index, { redeemRate: e.target.value === "" ? null : normalizeRateValue(e.target.value), redeemEffectiveDate: row.effectiveDate })}
                        className="h-7 w-20 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                      <Percent className="h-3 w-3 shrink-0 text-slate-400" />
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <input
                      type="date"
                      value={row.effectiveDate ?? ""}
                      onChange={(e) => {
                        const effectiveDate = e.target.value || null;
                        updateRow(index, {
                          effectiveDate,
                          buyEffectiveDate: row.buyRate != null ? effectiveDate : null,
                          redeemEffectiveDate: row.redeemRate != null ? effectiveDate : null,
                        });
                      }}
                      className="h-7 rounded border border-slate-200 px-1.5 text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => removeRow(index)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                      title={t("fundFeeRates.removeRate")}
                      aria-label={t("fundFeeRates.removeRate")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-2 flex shrink-0 items-center justify-end gap-2">
        {error ? <span className="text-xs text-rose-600">{error}</span> : null}
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={saveRows}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {saving ? t("fundFeeRates.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
