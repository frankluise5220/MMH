"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatCurrencyMoney } from "@/lib/format";

type FxRateRow = {
  fromCurrency?: string | null;
  toCurrency?: string | null;
  rate?: number | string | null;
  rateDate?: string | null;
  source?: string | null;
  refreshed?: boolean | null;
};

type Props = {
  fromCurrency: string;
  toCurrency: string;
  accountBalance: number;
  initialRate: number | null;
  initialRateDate: string | null;
  initialSource?: string | null;
};

function normalizeCurrency(value: string | null | undefined) {
  return String(value ?? "CNY").trim().toUpperCase() || "CNY";
}

function parseRate(value: unknown) {
  const rate = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function formatRate(value: number | null) {
  return value && Number.isFinite(value)
    ? value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")
    : "";
}

function formatQuoteAmount(value: number) {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getTodayText() {
  return new Date().toISOString().slice(0, 10);
}

export function AccountFxRateInline({
  fromCurrency,
  toCurrency,
  accountBalance,
  initialRate,
  initialRateDate,
  initialSource,
}: Props) {
  const sourceCurrency = normalizeCurrency(fromCurrency);
  const targetCurrency = normalizeCurrency(toCurrency);
  const [rate, setRate] = useState<number | null>(() => parseRate(initialRate));
  const [rateDate, setRateDate] = useState<string | null>(initialRateDate);
  const [source, setSource] = useState<string | null>(initialSource ?? null);
  const [editing, setEditing] = useState(false);
  const [draftRate, setDraftRate] = useState(() => formatRate(parseRate(initialRate)));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const nextRate = parseRate(initialRate);
    setRate(nextRate);
    setRateDate(initialRateDate);
    setSource(initialSource ?? null);
    setDraftRate(formatRate(nextRate));
  }, [initialRate, initialRateDate, initialSource]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const convertedBalance = useMemo(() => (
    rate && Number.isFinite(accountBalance) ? accountBalance * rate : null
  ), [accountBalance, rate]);

  const quoteText = useMemo(() => {
    if (!rate) return "";
    return `100 ${sourceCurrency} = ${formatQuoteAmount(rate * 100)} ${targetCurrency}`;
  }, [rate, sourceCurrency, targetCurrency]);

  async function saveManualRate(nextDraft = draftRate) {
    if (saving) return false;
    const nextRate = parseRate(nextDraft);
    if (!nextRate) {
      setError("请输入正数汇率");
      return false;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/v1/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromCurrency: sourceCurrency,
          toCurrency: targetCurrency,
          rate: nextRate,
          rateDate: rateDate || getTodayText(),
          source: "manual",
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "汇率保存失败");
      const row = data.rate as FxRateRow | null;
      setRate(parseRate(row?.rate) ?? nextRate);
      setRateDate(row?.rateDate ?? rateDate ?? getTodayText());
      setSource(row?.source ?? "manual");
      setDraftRate(formatRate(parseRate(row?.rate) ?? nextRate));
      setEditing(false);
      dispatchFinanceDataChanged({ reason: "fx-rate-save" });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "汇率保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function fetchLatestRate() {
    if (loading || sourceCurrency === targetCurrency) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        from: sourceCurrency,
        to: targetCurrency,
        refresh: "1",
      });
      const res = await fetch(`/api/v1/fx-rates?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !Array.isArray(data.rates)) {
        throw new Error(data?.error || "汇率获取失败");
      }
      const row = (data.rates as FxRateRow[]).find((item) =>
        normalizeCurrency(item.fromCurrency) === sourceCurrency
        && normalizeCurrency(item.toCurrency) === targetCurrency
      );
      const nextRate = parseRate(row?.rate);
      if (!nextRate) throw new Error("未获取到可用汇率");
      if (row?.refreshed !== true) throw new Error("未获取到最新汇率，已保留原汇率");
      setRate(nextRate);
      setRateDate(row?.rateDate ?? getTodayText());
      setSource(row?.source ?? "external");
      setDraftRate(formatRate(nextRate));
      setEditing(false);
      dispatchFinanceDataChanged({ reason: "fx-rate-refresh" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "汇率获取失败");
    } finally {
      setLoading(false);
    }
  }

  if (sourceCurrency === targetCurrency) return null;
  const convertedText = convertedBalance == null ? "" : `折合 ${formatCurrencyMoney(convertedBalance, targetCurrency)} · `;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs tabular-nums text-slate-500">
      {editing ? (
        <span className="inline-flex items-center gap-1">
          <span className="shrink-0">{convertedText}1 {sourceCurrency} =</span>
          <input
            ref={inputRef}
            value={draftRate}
            onChange={(event) => setDraftRate(event.target.value)}
            onBlur={() => void saveManualRate()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveManualRate();
              if (event.key === "Escape") {
                setDraftRate(formatRate(rate));
                setEditing(false);
                setError("");
              }
            }}
            className="h-6 w-24 rounded border border-slate-300 bg-white px-1.5 text-right text-xs text-slate-700 shadow-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
            disabled={saving}
          />
          <span className="shrink-0">{targetCurrency}</span>
        </span>
      ) : (
        <button
          type="button"
          onDoubleClick={() => {
            setDraftRate(formatRate(rate));
            setEditing(true);
            setError("");
          }}
          className="min-w-0 truncate rounded px-1 py-0.5 text-left hover:bg-slate-100"
          title={`双击修改汇率${source ? `；来源：${source}` : ""}`}
        >
          {convertedText}{quoteText || `缺少 ${sourceCurrency}/${targetCurrency} 汇率`}
          {rateDate ? ` · ${rateDate}` : ""}
        </button>
      )}
      <button
        type="button"
        onClick={() => void fetchLatestRate()}
        disabled={loading || saving}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-slate-200 bg-white px-1.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        title="获取最新汇率"
      >
        <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        获取汇率
      </button>
      {error ? <span className="shrink-0 text-[11px] text-red-600">{error}</span> : null}
    </span>
  );
}
