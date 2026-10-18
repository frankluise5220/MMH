"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Lock, Trash2 } from "lucide-react";

import { DateStepper } from "@/components/DateStepper";
import { useI18n } from "@/lib/i18n";

const EFFECTIVE_DATE_INPUT_CLASS = "!min-h-0 !h-6 !w-32 !rounded !border-slate-200 !px-1.5 !text-xs tabular-nums";

export type ConfirmDayRow = {
  fundCode: string;
  fundName: string | null;
  days: number;
  arrivalDays: number;
  /** 赎回成本天数：赎回侧单独保存的天数，默认 1。 */
  redeemCostDays: number;
  /** 规则生效日期（YYYY-MM-DD）；规则尚未保存过时为空串。 */
  effectiveDate: string;
  /** 已在设置页保存过：其它界面只读，不再覆盖这些天数。 */
  manualOverride?: boolean;
};

type ConfirmDaysListResponse = {
  ok?: boolean;
  rows?: ConfirmDayRow[];
  error?: string;
};

type MutationResponse = {
  ok?: boolean;
  error?: string;
};

type ConfirmDayPayloadRow = {
  fundCode: string;
  days: number;
  arrivalDays: number;
  redeemCostDays: number;
  /** null = 清空生效日期（与重构前口径一致）。 */
  effectiveDate: string | null;
};

const DEFAULT_REDEEM_COST_DAYS = 1;

function normalizeDaysValue(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

/** 接口返回的生效日期可能是 ISO 时间串，统一裁成 YYYY-MM-DD；非法值当空。 */
function normalizeEffectiveDateInput(value?: string | null): string {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function defaultConfirmDayRow(fundCode: string, fundName: string | null | undefined): ConfirmDayRow {
  return {
    fundCode,
    fundName: fundName ?? null,
    days: 0,
    arrivalDays: 2,
    redeemCostDays: DEFAULT_REDEEM_COST_DAYS,
    effectiveDate: "",
    manualOverride: false,
  };
}

function normalizeRow(row: ConfirmDayRow, fallbackFundName?: string | null): ConfirmDayRow {
  return {
    ...row,
    fundName: row.fundName ?? fallbackFundName ?? null,
    days: normalizeDaysValue(String(row.days)),
    arrivalDays: normalizeDaysValue(String(row.arrivalDays)),
    redeemCostDays: normalizeDaysValue(String(row.redeemCostDays ?? DEFAULT_REDEEM_COST_DAYS)),
    effectiveDate: normalizeEffectiveDateInput(row.effectiveDate),
    manualOverride: Boolean(row.manualOverride),
  };
}

function draftDaysValue(value: string, fallback: number) {
  return value.trim() === "" ? fallback : normalizeDaysValue(value);
}

/**
 * Editable fund confirm-day rule list (the single T+N store). Renders the table
 * body only (no modal overlay), so it can be embedded into an account edit
 * dialog or the fund profile settings card.
 */
export function FundConfirmDaysPanel({
  accountId,
  initialFundCode,
  fundName,
  onSaved,
  preloadedRows,
  compact = false,
  hideFundColumn = false,
}: {
  accountId: string;
  /** When set, the panel edits only this fund's rule (row-action entry point). */
  initialFundCode?: string | null;
  /** Display name for the single-fund mode. */
  fundName?: string | null;
  onSaved?: (result: { fundCode: string; rows: ConfirmDayRow[] }) => void;
  /** Preloaded account rules used by the fund profile dialog to avoid refetching on navigation. */
  preloadedRows?: ConfirmDayRow[];
  /** Compact variant for embedding inside a dialog. */
  compact?: boolean;
  /** Hide repeated fund identity columns when the surrounding card already identifies the fund. */
  hideFundColumn?: boolean;
}) {
  const { t } = useI18n();
  const singleFundMode = Boolean(initialFundCode);
  const [rows, setRows] = useState<ConfirmDayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingRowKey, setSavingRowKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [draftFundCode, setDraftFundCode] = useState(initialFundCode ?? "");
  const [draftDays, setDraftDays] = useState("");
  const [draftArrivalDays, setDraftArrivalDays] = useState("");
  const [draftRedeemCostDays, setDraftRedeemCostDays] = useState("");
  const [draftEffectiveDate, setDraftEffectiveDate] = useState("");

  const applyRows = useCallback((list: ConfirmDayRow[]) => {
    let selected = initialFundCode
      ? list.filter((row) => row.fundCode === initialFundCode)
      : list;
    selected = selected.map((row) => normalizeRow(row, row.fundCode === initialFundCode ? fundName : null));
    if (initialFundCode && selected.length === 0) {
      selected = [defaultConfirmDayRow(initialFundCode, fundName)];
    }
    setRows(selected);
    return selected;
  }, [fundName, initialFundCode]);

  const fetchRowsFromServer = useCallback(async () => {
    const url = `/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&list=1`;
    const response = await fetch(url, { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as ConfirmDaysListResponse | null;
    if (!response.ok || !data?.ok || !Array.isArray(data.rows)) {
      throw new Error(data?.error || t("fundConfirmDays.loadFailed"));
    }
    return data.rows;
  }, [accountId, t]);

  const loadRows = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      if (singleFundMode && initialFundCode) {
        if (preloadedRows) {
          applyRows(preloadedRows);
          return;
        }
        const url = `/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(initialFundCode)}`;
        const response = await fetch(url, { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          days?: number;
          arrivalDays?: number;
          redeemCostDays?: number;
          effectiveDate?: string | null;
          manualOverride?: boolean;
          error?: string;
        } | null;
        if (!data?.ok) {
          setError(data?.error || t("fundConfirmDays.loadFailed"));
          return;
        }
        setRows([normalizeRow({
          fundCode: initialFundCode,
          fundName: fundName ?? null,
          days: data.days ?? 0,
          arrivalDays: data.arrivalDays ?? 2,
          redeemCostDays: data.redeemCostDays ?? DEFAULT_REDEEM_COST_DAYS,
          effectiveDate: normalizeEffectiveDateInput(data.effectiveDate),
          manualOverride: Boolean(data.manualOverride),
        }, fundName)]);
        return;
      }
      if (preloadedRows) {
        applyRows(preloadedRows);
        return;
      }
      applyRows(await fetchRowsFromServer());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountId, applyRows, fetchRowsFromServer, initialFundCode, singleFundMode, fundName, preloadedRows, t]);

  useEffect(() => {
    setDraftFundCode(initialFundCode ?? "");
    setDraftDays("");
    setDraftArrivalDays("");
    void loadRows();
  }, [initialFundCode, loadRows]);

  const displayRows = useMemo(() => rows.map((row, index) => ({ row, index })), [rows]);

  const updateRow = useCallback((index: number, patch: Partial<ConfirmDayRow>) => {
    setRows((current) => current.map((row, rowIndex) => (
      rowIndex === index ? normalizeRow({ ...row, ...patch }, row.fundCode === initialFundCode ? fundName : null) : row
    )));
    setError("");
  }, [fundName, initialFundCode]);

  const buildPayloadRow = useCallback((row: ConfirmDayRow, fundCodeOverride?: string | null): ConfirmDayPayloadRow => ({
    fundCode: (fundCodeOverride ?? row.fundCode).trim(),
    days: normalizeDaysValue(String(row.days)),
    arrivalDays: normalizeDaysValue(String(row.arrivalDays)),
    redeemCostDays: normalizeDaysValue(String(row.redeemCostDays ?? DEFAULT_REDEEM_COST_DAYS)),
    effectiveDate: normalizeEffectiveDateInput(row.effectiveDate) || null,
  }), []);

  const saveRule = useCallback(async (nextRows: ConfirmDayRow[], row: ConfirmDayRow, rowKey: string) => {
    const payloadRow = buildPayloadRow(row, initialFundCode ?? row.fundCode);
    if (!accountId || !payloadRow.fundCode) return false;

    setSavingRowKey(rowKey);
    setError("");
    try {
      const response = await fetch("/api/v1/fund/confirm-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, rows: [payloadRow] }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error || t("fundConfirmDays.saveFailed"));

      let selectedRows: ConfirmDayRow[];
      try {
        selectedRows = applyRows(await fetchRowsFromServer());
      } catch {
        selectedRows = applyRows(nextRows);
      }
      onSaved?.({ fundCode: payloadRow.fundCode, rows: selectedRows.filter((item) => item.fundCode === payloadRow.fundCode) });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.saveFailed"));
      return false;
    } finally {
      setSavingRowKey(null);
    }
  }, [accountId, applyRows, buildPayloadRow, fetchRowsFromServer, initialFundCode, onSaved, t]);

  const deleteRule = useCallback(async (index: number) => {
    const row = rows[index];
    if (!row?.fundCode.trim()) return;
    if (rows.length <= 1) {
      setError(t("fundConfirmDays.keepOneRecord"));
      return;
    }
    setSavingRowKey(`delete:${index}`);
    setError("");
    try {
      const response = await fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(row.fundCode)}`, {
        method: "DELETE",
      });
      const data = (await response.json().catch(() => null)) as MutationResponse | null;
      if (!response.ok || !data?.ok) throw new Error(data?.error || t("fundConfirmDays.deleteFailed"));
      let selectedRows: ConfirmDayRow[];
      try {
        selectedRows = applyRows(await fetchRowsFromServer());
      } catch {
        selectedRows = applyRows(rows.filter((_, rowIndex) => rowIndex !== index));
      }
      onSaved?.({ fundCode: row.fundCode, rows: selectedRows.filter((item) => item.fundCode === row.fundCode) });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.deleteFailed"));
    } finally {
      setSavingRowKey(null);
    }
  }, [accountId, applyRows, fetchRowsFromServer, onSaved, rows, t]);

  const saveExistingRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row?.fundCode.trim()) return;
    void saveRule(rows, row, `row:${index}`);
  }, [rows, saveRule]);

  const saveDraftRow = useCallback(() => {
    const code = (initialFundCode ?? draftFundCode).trim();
    if (!code) return;
    if (!initialFundCode && rows.some((row) => row.fundCode === code)) {
      setError(t("fundConfirmDays.duplicateFund", { code }));
      return;
    }
    if (!draftDays.trim() && !draftArrivalDays.trim() && !draftRedeemCostDays.trim() && !draftEffectiveDate.trim()) return;

    const draftRow = normalizeRow({
      fundCode: code,
      fundName: initialFundCode ? fundName ?? null : null,
      days: draftDaysValue(draftDays, 0),
      arrivalDays: draftDaysValue(draftArrivalDays, 2),
      redeemCostDays: draftDaysValue(draftRedeemCostDays, DEFAULT_REDEEM_COST_DAYS),
      effectiveDate: normalizeEffectiveDateInput(draftEffectiveDate),
    }, fundName);
    const nextRows = [...rows.filter((row) => row.fundCode !== code), draftRow];
    void (async () => {
      const saved = await saveRule(nextRows, draftRow, "draft");
      if (!saved) return;
      setDraftFundCode(initialFundCode ?? "");
      setDraftDays("");
      setDraftArrivalDays("");
      setDraftRedeemCostDays("");
      setDraftEffectiveDate("");
    })();
  }, [draftArrivalDays, draftDays, draftEffectiveDate, draftFundCode, draftRedeemCostDays, fundName, initialFundCode, rows, saveRule, t]);

  const draftCanSave = Boolean(
    (initialFundCode ?? draftFundCode).trim()
    && (draftDays.trim() || draftArrivalDays.trim() || draftRedeemCostDays.trim() || draftEffectiveDate.trim()),
  );
  const anySaving = savingRowKey !== null;

  return (
    <div className={compact ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-1 flex-col"}>
      <div className={`min-h-0 overflow-auto rounded-md border border-slate-200 ${compact ? "max-h-[170px]" : "flex-1"}`} style={{ scrollbarGutter: "stable" }}>
        {loading ? (
          <div className="flex h-24 items-center justify-center text-sm text-slate-400">{t("fundConfirmDays.loading")}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                {!hideFundColumn ? (
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.fund")}</th>
                ) : null}
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.confirmDays")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.arrivalDays")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.redeemCostDays")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.effectiveDate")}</th>
                <th className="w-40 border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("detail.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ row, index }) => {
                const rowKey = `row:${index}`;
                const saving = savingRowKey === rowKey;
                const canDelete = rows.length > 1;
                return (
                  <tr key={`${row.fundCode}-${index}`} className="hover:bg-slate-50">
                    {!hideFundColumn ? (
                      <td className="border-b border-slate-100 px-2 py-1">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-slate-800" title={row.fundName ?? undefined}>
                            {row.fundName || "-"}
                          </div>
                          <div className="flex items-center gap-1 text-[11px] tabular-nums text-slate-400">
                            <span>{row.fundCode}</span>
                            {row.manualOverride ? (
                              <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500" title={t("fundConfirmDays.manualLockHint")}>
                                <Lock className="h-2.5 w-2.5" />
                                {t("fundConfirmDays.locked")}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    ) : null}
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="number"
                        min={0}
                        value={row.days}
                        onChange={(e) => updateRow(index, { days: normalizeDaysValue(e.target.value) })}
                        className="h-6 w-12 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="number"
                        min={0}
                        value={row.arrivalDays}
                        onChange={(e) => updateRow(index, { arrivalDays: normalizeDaysValue(e.target.value) })}
                        className="h-6 w-12 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="number"
                        min={0}
                        value={row.redeemCostDays}
                        onChange={(e) => updateRow(index, { redeemCostDays: normalizeDaysValue(e.target.value) })}
                        className="h-6 w-12 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <DateStepper
                        compact
                        value={row.effectiveDate}
                        onChange={(value) => updateRow(index, { effectiveDate: normalizeEffectiveDateInput(value) })}
                        className={EFFECTIVE_DATE_INPUT_CLASS}
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => saveExistingRow(index)}
                          disabled={anySaving || !row.fundCode.trim()}
                          className="inline-flex h-6 items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          {t("common.save")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteRule(index)}
                          disabled={anySaving || !canDelete}
                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                          title={canDelete ? t("common.delete") : t("fundConfirmDays.keepOneRecord")}
                          aria-label={canDelete ? t("common.delete") : t("fundConfirmDays.keepOneRecord")}
                        >
                          {savingRowKey === `delete:${index}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50/60">
                {!hideFundColumn ? (
                  <td className="border-b border-slate-100 px-2 py-1">
                    <input
                      type="text"
                      value={draftFundCode}
                      onChange={(e) => setDraftFundCode(e.target.value)}
                      placeholder={t("fundConfirmDays.newFundCodePlaceholder")}
                      className="h-6 w-24 rounded border border-slate-200 bg-white px-1.5 text-xs outline-none focus:border-blue-400"
                    />
                  </td>
                ) : null}
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="number"
                    min={0}
                    value={draftDays}
                    onChange={(e) => setDraftDays(e.target.value)}
                    className="h-6 w-12 rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="number"
                    min={0}
                    value={draftArrivalDays}
                    onChange={(e) => setDraftArrivalDays(e.target.value)}
                    className="h-6 w-12 rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="number"
                    min={0}
                    value={draftRedeemCostDays}
                    placeholder={String(DEFAULT_REDEEM_COST_DAYS)}
                    onChange={(e) => setDraftRedeemCostDays(e.target.value)}
                    className="h-6 w-12 rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <DateStepper
                    compact
                    value={draftEffectiveDate}
                    onChange={setDraftEffectiveDate}
                    className={EFFECTIVE_DATE_INPUT_CLASS}
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <div className="inline-flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={saveDraftRow}
                      disabled={anySaving || !draftCanSave}
                      className="inline-flex h-6 items-center gap-1 rounded border border-blue-200 bg-white px-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {savingRowKey === "draft" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      {t("common.save")}
                    </button>
                    <span className="h-6 w-6" aria-hidden="true" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      {error ? <div className="mt-2 text-right text-xs text-rose-600">{error}</div> : null}
      <div className="mt-1 text-[11px] leading-4 text-slate-400">{t("fundConfirmDays.manualLockHint")}</div>
    </div>
  );
}
