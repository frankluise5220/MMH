"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

/**
 * 贵金属账户的「刷新最新价格」按钮（与基金账户的 RefreshNavButton 同一处工具条位置）。
 *
 * 与基金的差别：贵金属按「品种 + 计量单位」计价，没有净值序列，所以服务端一次刷新
 * 整个账户的持仓，客户端只需要把 shell-data 重新拉一遍。
 */
export function RefreshMetalPriceButton({ accountId }: { accountId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<number | null>(null);
  const { t } = useI18n();

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  function showResult(message: string, isError: boolean) {
    setResult(message);
    setFailed(isError);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setResult(null);
      setFailed(false);
    }, 6000);
  }

  async function refresh() {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/precious-metals/prices/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        showResult(String(data?.error ?? t("refreshNav.refreshFailed")), true);
        return;
      }
      const refreshed = Number(data.data?.refreshed ?? 0);
      const failedCount = Number(data.data?.failed?.length ?? 0);
      const message = refreshed === 0
        ? t("refreshNav.metalNone")
        : failedCount > 0
          ? t("refreshNav.metalPartial", { count: String(refreshed), failed: String(failedCount) })
          : t("refreshNav.metalDone", { count: String(refreshed) });
      showResult(message, refreshed === 0);
      if (refreshed > 0) {
        dispatchFinanceDataChanged({ reason: "metal-price-refresh", accountIds: [accountId] });
      }
    } catch (e) {
      showResult(e instanceof Error ? e.message : t("refreshNav.refreshFailed"), true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result ? (
        <span className={`max-w-[16rem] truncate text-[11px] ${failed ? "text-amber-600" : "text-slate-500"}`}>{result}</span>
      ) : null}
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        title={loading ? t("refreshNav.fetching") : t("refreshNav.fetchLatestMetalPrice")}
        aria-label={loading ? t("refreshNav.fetching") : t("refreshNav.fetchLatestMetalPrice")}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}
