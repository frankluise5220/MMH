"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Database, Settings2 } from "lucide-react";

import { ManualGrabMark } from "@/components/AddNavButton";
import { DateStepper } from "@/components/DateStepper";
import { useI18n } from "@/lib/i18n";

type RowActionPosition = {
  securityId?: string | null;
  market?: string | null;
  stockCode: string;
  name: string;
  nav: number | null;
  navDate?: string | null;
};

type SecurityApiResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    security?: {
      id: string;
      market: string;
      stockCode: string;
      stockName: string | null;
      currency: string | null;
      exchange: string | null;
    } | null;
  } | null;
};

const dialogInputClassName = "h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none";
const dialogLabelClassName = "text-xs font-medium text-slate-600";
const dialogValueClassName = "rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Per-row actions at the rightmost holding column of the stock view, mirroring
 * the fund view: manually enter a closing price and edit stock attributes.
 */
export function StockHoldingRowActions({
  accountId,
  position,
  onUpdated,
}: {
  accountId: string;
  position: RowActionPosition;
  onUpdated: () => void;
}) {
  const { t } = useI18n();

  const [priceOpen, setPriceOpen] = useState(false);
  const [priceDate, setPriceDate] = useState(position.navDate || todayStr());
  const [priceValue, setPriceValue] = useState("");
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceError, setPriceError] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState("");
  const [stockName, setStockName] = useState(position.name);
  const [currency, setCurrency] = useState("");
  const [exchange, setExchange] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState("");

  function openPriceDialog() {
    setPriceDate(position.navDate || todayStr());
    setPriceValue("");
    setPriceError("");
    setPriceOpen(true);
  }

  async function submitManualPrice() {
    const value = Number(priceValue);
    if (!priceDate || !priceValue.trim() || !Number.isFinite(value) || value <= 0) return;
    setPriceSaving(true);
    setPriceError("");
    try {
      const res = await fetch("/api/v1/stocks/prices/manual", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          securityId: position.securityId || undefined,
          market: position.market || undefined,
          stockCode: position.stockCode,
          priceDate,
          closePrice: value,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.manualPriceFailed"));
      setPriceOpen(false);
      onUpdated();
    } catch (error) {
      setPriceError(error instanceof Error ? error.message : t("stockPanel.error.manualPriceFailed"));
    } finally {
      setPriceSaving(false);
    }
  }

  async function loadSecurity() {
    if (!position.stockCode) return;
    setSettingsLoading(true);
    setSettingsLoadError("");
    try {
      const params = new URLSearchParams({ code: position.stockCode, localOnly: "1" });
      if (position.market) params.set("market", position.market);
      const res = await fetch(`/api/v1/stocks/securities?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as SecurityApiResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockSecurity.loadFailed"));
      const security = data.data?.security ?? null;
      setStockName(String(security?.stockName ?? "").trim() || position.name);
      setCurrency(String(security?.currency ?? "").trim());
      setExchange(String(security?.exchange ?? "").trim());
    } catch (error) {
      setSettingsLoadError(error instanceof Error ? error.message : t("stockSecurity.loadFailed"));
    } finally {
      setSettingsLoading(false);
    }
  }

  function openSettingsDialog() {
    setStockName(position.name);
    setCurrency("");
    setExchange("");
    setSettingsLoadError("");
    setSettingsSaveError("");
    setSettingsOpen(true);
    void loadSecurity();
  }

  async function submitSecurity() {
    if (!stockName.trim()) {
      setSettingsSaveError(t("stockSecurity.nameRequired"));
      return;
    }
    setSettingsSaving(true);
    setSettingsSaveError("");
    try {
      const res = await fetch("/api/v1/stocks/securities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          securityId: position.securityId || undefined,
          market: position.market || undefined,
          stockCode: position.stockCode,
          stockName: stockName.trim(),
          currency: currency.trim(),
          exchange: exchange.trim(),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockSecurity.error.updateFailed"));
      setSettingsOpen(false);
      onUpdated();
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : t("stockSecurity.error.updateFailed"));
    } finally {
      setSettingsSaving(false);
    }
  }

  const triggerButtons = (
    <div
      data-row-double-click-ignore
      className="flex items-center justify-end gap-0.5"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openPriceDialog();
        }}
        className="relative inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100"
        title={t("stockPanel.manualPriceTitle")}
        aria-label={t("stockPanel.manualPriceTitle")}
      >
        <Database className="absolute left-1 top-1 h-3.5 w-3.5 opacity-80" />
        <span className="absolute bottom-1 right-1 text-amber-800">
          <ManualGrabMark />
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openSettingsDialog();
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
        title={t("stockSecurity.title")}
        aria-label={t("stockSecurity.title")}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  return (
    <>
      {triggerButtons}

      {priceOpen ? createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 text-left">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">{t("stockPanel.manualPriceTitle")}</div>
              <button
                type="button"
                onClick={() => setPriceOpen(false)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
              >
                {t("table.close")}
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="space-y-1">
                <div className={dialogLabelClassName}>{t("stockHoldingReport.colStock")}</div>
                <div className={dialogValueClassName}>
                  <span className="font-medium">{position.name}</span>
                  {position.stockCode ? <span className="ml-1 text-slate-500">{position.stockCode}</span> : null}
                </div>
              </div>
              <div className="space-y-1">
                <div className={dialogLabelClassName}>{t("detail.column.date")}</div>
                <DateStepper value={priceDate} onChange={setPriceDate} className={dialogInputClassName} />
              </div>
              <div className="space-y-1">
                <div className={dialogLabelClassName}>{t("stockHoldingReport.colClosePrice")}</div>
                <input
                  inputMode="decimal"
                  value={priceValue}
                  onChange={(event) => setPriceValue(event.target.value)}
                  placeholder={position.nav != null ? String(position.nav) : "0.0000"}
                  className={dialogInputClassName}
                />
              </div>
              {priceError ? <div className="text-xs text-rose-600">{priceError}</div> : null}
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => void submitManualPrice()}
                  disabled={priceSaving || !priceValue.trim()}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {priceSaving ? t("addNav.saving") : t("common.save")}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {settingsOpen ? createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 text-left">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">{t("stockSecurity.title")}</div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
              >
                {t("table.close")}
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className={dialogLabelClassName}>{t("reports.stock.market")}</div>
                  <div className={dialogValueClassName}>{position.market || "-"}</div>
                </div>
                <div className="space-y-1">
                  <div className={dialogLabelClassName}>{t("stockTx.stockCodeLabel")}</div>
                  <div className={dialogValueClassName}>{position.stockCode || "-"}</div>
                </div>
              </div>
              <div className="space-y-1">
                <div className={dialogLabelClassName}>{t("stockSecurity.stockName")}</div>
                <input
                  value={stockName}
                  onChange={(event) => setStockName(event.target.value)}
                  className={dialogInputClassName}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className={dialogLabelClassName}>{t("stockSecurity.exchange")}</div>
                  <input
                    value={exchange}
                    onChange={(event) => setExchange(event.target.value)}
                    placeholder="SSE / SZSE / HKEX / NASDAQ"
                    className={dialogInputClassName}
                  />
                </div>
                <div className="space-y-1">
                  <div className={dialogLabelClassName}>{t("stockSecurity.currency")}</div>
                  <input
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                    placeholder="CNY / HKD / USD"
                    className={dialogInputClassName}
                  />
                </div>
              </div>
              {settingsLoading ? <div className="text-xs text-slate-500">{t("stockPanel.detailLoading")}</div> : null}
              {settingsLoadError ? <div className="text-xs text-rose-600">{settingsLoadError}</div> : null}
              {settingsSaveError ? <div className="text-xs text-rose-600">{settingsSaveError}</div> : null}
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => void submitSecurity()}
                  disabled={settingsSaving || settingsLoading || !stockName.trim()}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {settingsSaving ? t("addNav.saving") : t("common.save")}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
