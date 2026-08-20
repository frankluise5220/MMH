"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Check, Percent, Plus, X } from "lucide-react";

import { FundFeeRatePanel } from "@/components/FundFeeRatePanel";
import { useI18n } from "@/lib/i18n";

export type ConfirmDayRow = {
  fundCode: string;
  fundName: string | null;
  days: number;
  arrivalDays: number;
  redeemCostDays: number;
  effectiveDate: string | null;
};

type ConfirmDaysListResponse = {
  ok?: boolean;
  rows?: ConfirmDayRow[];
  error?: string;
};

function normalizeDaysValue(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

/**
 * Editable fund confirm-day rule list. Renders the table body only (no modal
 * overlay), so it can be embedded into an account edit dialog or shown inside
 * the FundConfirmDaysModal shell.
 */
export function FundConfirmDaysPanel({
  accountId,
  initialFundCode,
  fundName,
  onSaved,
  compact = false,
}: {
  accountId: string;
  /** When set, the panel edits only this fund's rule (row-action entry point). */
  initialFundCode?: string | null;
  /** Display name for the single-fund mode. */
  fundName?: string | null;
  onSaved?: () => void;
  /** Compact variant for embedding inside a dialog. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const singleFundMode = Boolean(initialFundCode);
  const [rows, setRows] = useState<ConfirmDayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [newFundCode, setNewFundCode] = useState("");
  const [newFundName, setNewFundName] = useState("");

  const loadRows = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      if (singleFundMode && initialFundCode) {
        const url = `/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(initialFundCode)}`;
        const response = await fetch(url, { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          days?: number;
          arrivalDays?: number;
          redeemCostDays?: number;
          effectiveDate?: string | null;
          error?: string;
        } | null;
        if (!data?.ok) {
          setError(data?.error || t("fundConfirmDays.loadFailed"));
          return;
        }
        setRows([
          {
            fundCode: initialFundCode,
            fundName: fundName ?? null,
            days: data.days ?? 1,
            arrivalDays: data.arrivalDays ?? 2,
            redeemCostDays: data.redeemCostDays ?? 1,
            effectiveDate: data.effectiveDate ?? null,
          },
        ]);
        setDirty(false);
        return;
      }
      const url = `/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&list=1`;
      const response = await fetch(url, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as ConfirmDaysListResponse | null;
      if (!data?.ok || !Array.isArray(data.rows)) {
        setError(data?.error || t("fundConfirmDays.loadFailed"));
        return;
      }
      setRows(data.rows);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountId, initialFundCode, singleFundMode, fundName, t]);

  useEffect(() => {
    setNewFundCode("");
    setNewFundName("");
    void loadRows();
  }, [loadRows]);

  const updateRow = useCallback((fundCode: string, patch: Partial<ConfirmDayRow>) => {
    setRows((current) => current.map((row) => (row.fundCode === fundCode ? { ...row, ...patch } : row)));
    setDirty(true);
  }, []);

  const addRow = useCallback(() => {
    const code = newFundCode.trim();
    if (!code) return;
    if (rows.some((row) => row.fundCode === code)) {
      setError(t("fundConfirmDays.duplicateFund", { code }));
      return;
    }
    setRows((current) => [
      ...current,
      {
        fundCode: code,
        fundName: newFundName.trim() || null,
        days: 0,
        arrivalDays: 2,
        redeemCostDays: 1,
        effectiveDate: null,
      },
    ]);
    setNewFundCode("");
    setNewFundName("");
    setError("");
    setDirty(true);
  }, [newFundCode, newFundName, rows, t]);

  const removeRow = useCallback((fundCode: string) => {
    setRows((current) => current.filter((row) => row.fundCode !== fundCode));
    setDirty(true);
  }, []);

  const buildPayloadRows = useCallback(
    () =>
      rows.map((row) => ({
        fundCode: row.fundCode,
        days: row.days,
        arrivalDays: row.arrivalDays,
        redeemCostDays: row.redeemCostDays,
        effectiveDate: row.effectiveDate || undefined,
      })),
    [rows],
  );

  const saveRows = useCallback(async () => {
    if (!accountId || rows.length === 0) return;
    setSaving(true);
    setError("");
    try {
      const payload = { accountId, rows: buildPayloadRows() };
      const response = await fetch("/api/v1/fund/confirm-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error || t("fundConfirmDays.saveFailed"));
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [accountId, buildPayloadRows, onSaved, t]);

  return (
    <div className={compact ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-1 flex-col"}>
      {!singleFundMode ? (
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
          <input
            type="text"
            value={newFundCode}
            onChange={(e) => setNewFundCode(e.target.value)}
            placeholder={t("fundConfirmDays.newFundCodePlaceholder")}
            className="h-8 w-32 rounded-md border border-slate-200 px-2 text-xs outline-none focus:border-blue-400"
          />
          <input
            type="text"
            value={newFundName}
            onChange={(e) => setNewFundName(e.target.value)}
            placeholder={t("fundConfirmDays.newFundNamePlaceholder")}
            className="h-8 w-44 rounded-md border border-slate-200 px-2 text-xs outline-none focus:border-blue-400"
          />
          <button
            type="button"
            onClick={addRow}
            disabled={!newFundCode.trim()}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("fundConfirmDays.addRule")}
          </button>
        </div>
      ) : null}

      <div className={`min-h-0 overflow-auto rounded-md border border-slate-200 ${compact ? "max-h-[280px]" : "flex-1"}`} style={{ scrollbarGutter: "stable" }}>
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-400">{t("fundConfirmDays.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-400">{t("fundConfirmDays.empty")}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.fund")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.confirmDays")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.arrivalDays")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.redeemCostDays")}</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.effectiveDate")}</th>
                {!singleFundMode ? (
                  <th className="w-10 border-b border-slate-200 px-2 py-2" />
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.fundCode} className="hover:bg-slate-50">
                  <td className="border-b border-slate-100 px-3 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800" title={row.fundName ?? undefined}>
                        {row.fundName || "-"}
                      </div>
                      <div className="text-[11px] tabular-nums text-slate-400">{row.fundCode}</div>
                    </div>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <input
                      type="number"
                      min={0}
                      value={row.days}
                      onChange={(e) => updateRow(row.fundCode, { days: normalizeDaysValue(e.target.value) })}
                      className="h-7 w-14 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <input
                      type="number"
                      min={0}
                      value={row.arrivalDays}
                      onChange={(e) => updateRow(row.fundCode, { arrivalDays: normalizeDaysValue(e.target.value) })}
                      className="h-7 w-14 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <input
                      type="number"
                      min={0}
                      value={row.redeemCostDays}
                      onChange={(e) => updateRow(row.fundCode, { redeemCostDays: normalizeDaysValue(e.target.value) })}
                      className="h-7 w-14 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                  </td>
                  <td className="border-b border-slate-100 px-3 py-1.5 text-right">
                    <input
                      type="date"
                      value={row.effectiveDate ?? ""}
                      onChange={(e) => updateRow(row.fundCode, { effectiveDate: e.target.value || null })}
                      className="h-7 rounded border border-slate-200 px-1.5 text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                  </td>
                  {!singleFundMode ? (
                    <td className="border-b border-slate-100 px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(row.fundCode)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        title={t("fundConfirmDays.removeRule")}
                        aria-label={t("fundConfirmDays.removeRule")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  ) : null}
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
          {saving ? t("fundConfirmDays.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * Full-screen dialog with two tabs (T+N rules and fee rates). Used from the
 * fund account page (row action / toolbar entry).
 */
export function FundConfirmDaysModal({
  accountId,
  open,
  onClose,
  onSaved,
  initialFundCode,
  fundName,
  initialTab = "confirm",
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** When set, the modal edits only this fund's rule (row-action entry point). */
  initialFundCode?: string | null;
  /** Display name for the single-fund mode. */
  fundName?: string | null;
  initialTab?: "confirm" | "fee";
}) {
  const { t } = useI18n();
  const singleFundMode = Boolean(initialFundCode);
  const [activeTab, setActiveTab] = useState<"confirm" | "fee">("confirm");

  useEffect(() => {
    if (!open) return;
    setActiveTab(initialTab);
  }, [initialTab, open]);

  if (!open) return null;

  const modalTitle = singleFundMode
    ? `${fundName || initialFundCode} · ${t("fundRules.title")}`
    : t("fundRules.title");

  const tabClass = (active: boolean) =>
    active
      ? "border-blue-300 bg-blue-50 text-blue-700"
      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50";

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-800">
            <CalendarDays className="h-4 w-4 shrink-0 text-slate-500" />
            <span className="truncate">{modalTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              aria-label={t("table.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-4 pt-2.5">
          <button
            type="button"
            onClick={() => setActiveTab("confirm")}
            className={`inline-flex h-8 items-center rounded-t-md border border-b-0 px-3 text-xs font-medium ${tabClass(activeTab === "confirm")}`}
          >
            <CalendarDays className="mr-1.5 h-3.5 w-3.5" />
            {t("fundRules.tab.confirm")}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("fee")}
            className={`inline-flex h-8 items-center rounded-t-md border border-b-0 px-3 text-xs font-medium ${tabClass(activeTab === "fee")}`}
          >
            <Percent className="mr-1.5 h-3.5 w-3.5" />
            {t("fundRules.tab.fee")}
          </button>
        </div>
        <div className="min-h-0 flex-1 p-4">
          {/* Both panels stay mounted so switching tabs never re-fetches or
              resizes the dialog; only visibility changes. */}
          <div className={activeTab === "confirm" ? "h-full" : "hidden"}>
            <FundConfirmDaysPanel
              accountId={accountId}
              initialFundCode={initialFundCode}
              fundName={fundName}
              onSaved={onSaved}
            />
          </div>
          <div className={activeTab === "fee" ? "h-full" : "hidden"}>
            <FundFeeRatePanel
              accountId={accountId}
              initialFundCode={initialFundCode}
              onSaved={onSaved}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
