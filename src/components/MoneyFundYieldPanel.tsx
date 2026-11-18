"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Coins, RefreshCw, Save } from "lucide-react";

import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";

/**
 * 货币基金「每万份收益」面板。
 *
 * 和开放式基金的净值面板完全不同：货基净值恒为 1.0000，可维护的是每日万份收益。
 * 面板同时提供「立即结转」，把万份收益按当日份额折成收益加进份额。
 */

type YieldRow = { date: string; incomePer10k: number };

export function MoneyFundYieldPanel({
  accountId,
  fundCode,
  compact = false,
}: {
  accountId: string;
  fundCode: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<YieldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [date, setDate] = useState(() => todayDateLocalYmd());
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [accruing, setAccruing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/fund/money-yield?fundCode=${encodeURIComponent(fundCode)}&days=30`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "");
      setRows(Array.isArray(payload.data?.rows) ? payload.data.rows : []);
    } catch {
      setMessage(t("moneyYield.loadFailed"));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [fundCode, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = useMemo(() => rows[0] ?? null, [rows]);

  async function handleSave() {
    const numeric = Number(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(numeric) || Math.abs(numeric) > 100) {
      setMessage(t("moneyYield.invalid"));
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/fund/money-yield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundCode, date, incomePer10k: numeric }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "");
      setValue("");
      setMessage(t("moneyYield.saved"));
      await load();
      dispatchFinanceDataChanged({ reason: "money-fund-yield:save", accountIds: [accountId] });
    } catch {
      setMessage(t("moneyYield.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleAccrue() {
    setAccruing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/fund/money-income/accrue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "");
      const days = Number(payload.data?.days ?? 0);
      const income = Number(payload.data?.totalIncome ?? 0);
      setMessage(
        days > 0
          ? `${t("moneyYield.accrued")} ${days} ${t("moneyYield.daysUnit")} · ${income.toFixed(2)}`
          : t("moneyYield.accruedNothing"),
      );
      dispatchFinanceDataChanged({ reason: "money-fund-income:accrue", accountIds: [accountId] });
    } catch {
      setMessage(t("moneyYield.accrueFailed"));
    } finally {
      setAccruing(false);
    }
  }

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      {compact ? null : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <Coins className="h-3.5 w-3.5 text-amber-600" />
            {t("moneyYield.title")}
          </div>
          <span className="text-[10px] text-slate-400">{t("moneyYield.navHint")}</span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-1.5">
        <label className="space-y-0.5">
          <span className="block text-[10px] text-slate-500">{t("moneyYield.date")}</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-blue-400"
          />
        </label>
        <label className="space-y-0.5">
          <span className="block text-[10px] text-slate-500">{t("moneyYield.value")}</span>
          <input
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="0.5123"
            className="h-7 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs tabular-nums text-slate-800 outline-none focus:border-blue-400"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? t("moneyYield.saving") : t("moneyYield.save")}
        </button>
        <button
          type="button"
          onClick={() => void handleAccrue()}
          disabled={accruing}
          className="flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${accruing ? "animate-spin" : ""}`} />
          {accruing ? t("moneyYield.accruing") : t("moneyYield.accrue")}
        </button>
      </div>

      {message ? <div className="text-[11px] text-slate-500">{message}</div> : null}

      <div className="max-h-48 overflow-auto rounded-md border border-slate-100">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">{t("moneyYield.date")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("moneyYield.value")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={2} className="px-2 py-3 text-center text-slate-400">
                  {t("moneyYield.loading")}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-2 py-3 text-center text-slate-400">
                  {t("moneyYield.empty")}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.date} className="border-t border-slate-100">
                  <td className="px-2 py-1 text-slate-600">{row.date}</td>
                  <td className="px-2 py-1 text-right text-slate-800">{row.incomePer10k.toFixed(4)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {latest ? (
        <div className="text-[10px] text-slate-400">
          {t("moneyYield.latest")} {latest.date} · {latest.incomePer10k.toFixed(4)}
        </div>
      ) : null}
    </div>
  );
}
