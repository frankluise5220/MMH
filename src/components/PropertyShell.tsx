"use client";

import { Home, Plus, RefreshCcw } from "lucide-react";

import { formatCurrencyMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

type PropertyPosition = {
  fundCode: string;
  propertyAssetId?: string | null;
  name: string;
  holdingDate: string;
  cost: number;
  marketValue: number;
  navDate: string;
  floatingPnL: number;
  floatingPnLRate: number;
};

type Props = {
  accountId: string;
  accountLabel: string;
  currency: string;
  baseCurrency: string;
  positions: PropertyPosition[];
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
};

function rate(value: number) {
  return formatPercent(value);
}

export function PropertyShell({
  accountId,
  accountLabel,
  currency,
  baseCurrency,
  positions,
  totalMarketValue,
  totalCost,
  isRedUp,
}: Props) {
  const { t } = useI18n();
  const displayCurrency = currency || baseCurrency || "CNY";
  const floatingPnL = totalMarketValue - totalCost;
  const floatingRate = totalCost > 0 ? floatingPnL / totalCost : 0;
  const pnlCls = (value: number) => pnlClassFromRedUp(value, isRedUp);

  function openPurchase() {
    window.dispatchEvent(new CustomEvent("mmh:property:create", {
      detail: { defaultPropertyAccountId: accountId },
    }));
  }

  function openValuation(position: PropertyPosition) {
    window.dispatchEvent(new CustomEvent("mmh:property:valuation", {
      detail: {
        defaultPropertyAccountId: accountId,
        propertyAssetId: position.propertyAssetId ?? position.fundCode,
        propertyName: position.name,
        currentMarketValue: position.marketValue,
      },
    }));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent p-4 md:p-5">
      <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-slate-500">{t("propertyShell.accountLabel")}</div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-semibold text-slate-900">{accountLabel}</h2>
                <button type="button" onClick={openPurchase} className="secondary-button h-8 gap-1 px-2.5 text-xs">
                  <Plus className="h-3.5 w-3.5" />
                  {t("propertyShell.buyProperty")}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-6 text-right text-xs">
              <div>
                <div className="text-slate-500">{t("propertyShell.marketValue")}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatCurrencyMoney(totalMarketValue, displayCurrency)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">{t("propertyShell.totalCost")}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatCurrencyMoney(totalCost, displayCurrency)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">{t("propertyShell.floatingPnL")}</div>
                <div className={`mt-1 text-sm font-semibold tabular-nums ${pnlCls(floatingPnL)}`}>
                  {formatCurrencyMoney(floatingPnL, displayCurrency)} · {rate(floatingRate)}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {positions.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="px-4 py-2 text-left font-medium">{t("propertyShell.column.property")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("propertyShell.column.purchaseDate")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("propertyShell.column.cost")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("propertyShell.column.marketValue")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("propertyShell.column.valuationDate")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("propertyShell.floatingPnL")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("detail.column.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.propertyAssetId ?? position.fundCode} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Home className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-slate-900">{position.name}</div>
                          <div className="truncate text-xs text-slate-400">{position.propertyAssetId ?? position.fundCode}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{position.holdingDate || "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(position.cost, displayCurrency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(position.marketValue, displayCurrency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{position.navDate || "-"}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pnlCls(position.floatingPnL)}`}>
                      {formatCurrencyMoney(position.floatingPnL, displayCurrency)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button type="button" onClick={() => openValuation(position)} className="secondary-button h-7 gap-1 px-2 text-xs">
                        <RefreshCcw className="h-3.5 w-3.5" />
                        {t("propertyShell.updateValuation")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
              <div className="text-sm font-medium text-slate-900">{t("propertyShell.emptyTitle")}</div>
              <div className="mt-2 max-w-md text-xs leading-5 text-slate-500">
                {t("propertyShell.emptyDesc")}
              </div>
              <button type="button" onClick={openPurchase} className="primary-button mt-4 h-8 gap-1 px-3 text-xs">
                <Plus className="h-3.5 w-3.5" />
                {t("propertyShell.buyProperty")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
