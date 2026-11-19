"use client";

import { useEffect, useRef, useState } from "react";
import { resolveAccountCurrencyDisplayValue } from "@/lib/account-currency-display";
import { formatCurrencyMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { FINANCE_DATA_CHANGED_EVENT, type FinanceDataChangedDetail } from "@/lib/client/refresh";
import {
  fetchInternalAccountBalances,
  fetchScopedAccountBalances,
  seedTotalConvertedBalance,
} from "@/lib/client/account-balances-fetch";

function pnlCls(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-red-700" : "text-emerald-800";
  if (value < 0) return isRedUp ? "text-emerald-800" : "text-red-700";
  return "text-slate-800";
}

function liabilityCls(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-emerald-800" : "text-red-700";
  if (value < 0) return isRedUp ? "text-red-700" : "text-emerald-800";
  return "text-slate-800";
}

export function LiveAccountBalance({
  accountId,
  initialValue,
  isRedUp,
  mode,
  semantic = "default",
  displayMultiplier = 1,
  baseCurrency = "CNY",
  accountDisplayMode = "converted",
}: {
  accountId?: string | null;
  initialValue: number;
  isRedUp: boolean;
  mode: "total" | "account";
  semantic?: "default" | "liability";
  displayMultiplier?: 1 | -1;
  baseCurrency?: string;
  accountDisplayMode?: "converted" | "original";
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [displayCurrency, setDisplayCurrency] = useState(baseCurrency);
  const [missingFxRate, setMissingFxRate] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshBusy = useRef(false);
  const refreshPending = useRef(false);
  const pendingScopedAccountIds = useRef<string[] | "full" | null>(null);

  useEffect(() => {
    if (mode === "total") seedTotalConvertedBalance(initialValue);
    setValue(initialValue);
    setDisplayCurrency(baseCurrency);
    setMissingFxRate(false);
  }, [accountId, baseCurrency, initialValue, mode]);

  useEffect(() => {
    const debouncedRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(async () => {
        if (refreshBusy.current) {
          refreshPending.current = true;
          return;
        }
        const pendingIds = pendingScopedAccountIds.current;
        pendingScopedAccountIds.current = null;
        refreshBusy.current = true;
        try {
          if (Array.isArray(pendingIds) && pendingIds.length > 0) {
            if (mode === "account" && accountId && !pendingIds.includes(accountId)) return;
            const scoped = await fetchScopedAccountBalances(pendingIds);
            if (scoped?.ok) {
              if (mode === "total") {
                if (scoped.totalConvertedBalance != null) {
                  setDisplayCurrency(String(scoped.baseCurrency || baseCurrency));
                  setMissingFxRate(false);
                  setValue(scoped.totalConvertedBalance);
                  return;
                }
                // Seed is incomplete (first load / missing account). Fall through to full recompute.
              } else {
                const matched = scoped.data.find((account) => account.id === accountId);
                if (matched) {
                  const resolved = resolveAccountCurrencyDisplayValue(matched, String(scoped.baseCurrency || baseCurrency), accountDisplayMode);
                  setDisplayCurrency(resolved.currency);
                  setMissingFxRate(resolved.value == null);
                  setValue(resolved.value ?? 0);
                }
                return;
              }
            }
          }
          const data = await fetchInternalAccountBalances();
          if (!data?.ok || !Array.isArray(data.accounts)) return;
          const accounts = data.accounts as Array<{
            id?: string | null;
            balance?: number | string | null;
            convertedBalance?: number | string | null;
            currency?: string | null;
            baseCurrency?: string | null;
            fxRateMissing?: boolean;
          }>;
          if (mode === "total") {
            const total = Number(data.totalConvertedBalance);
            setDisplayCurrency(String(data.baseCurrency || baseCurrency));
            setMissingFxRate(false);
            setValue(Number.isFinite(total)
              ? total
              : accounts.reduce((sum, account) => {
                  const resolved = resolveAccountCurrencyDisplayValue(account, String(data.baseCurrency || baseCurrency), "converted");
                  return sum + (resolved.value ?? 0);
                }, 0));
            return;
          }
          const matched = accounts.find((account) => account.id === accountId);
          if (matched) {
            const resolved = resolveAccountCurrencyDisplayValue(matched, String(data.baseCurrency || baseCurrency), accountDisplayMode);
            setDisplayCurrency(resolved.currency);
            setMissingFxRate(resolved.value == null);
            setValue(resolved.value ?? 0);
          }
        } catch {
        } finally {
          refreshBusy.current = false;
          if (refreshPending.current) {
            refreshPending.current = false;
            debouncedRefresh();
          }
        }
      }, 80);
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail;
      // Remark-only edits do not change balances: skip the top-summary refresh.
      if (detail?.balanceChanged === false) return;
      const scopedIds = Array.from(new Set((detail?.accountIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
      if (mode === "account" && accountId && scopedIds.length > 0 && !scopedIds.includes(accountId)) return;
      if (scopedIds.length > 0) {
        if (pendingScopedAccountIds.current !== "full") {
          const current = pendingScopedAccountIds.current;
          pendingScopedAccountIds.current = Array.from(new Set([...(Array.isArray(current) ? current : []), ...scopedIds]));
        }
      } else {
        pendingScopedAccountIds.current = "full";
      }
      debouncedRefresh();
    };

    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshPending.current = false;
    };
  }, [accountDisplayMode, accountId, baseCurrency, mode]);

  const displayValue = value * displayMultiplier;
  const cls = missingFxRate ? "text-amber-700" : semantic === "liability" ? liabilityCls(displayValue, isRedUp) : pnlCls(displayValue, isRedUp);
  return <span className={`tabular-nums font-semibold ${cls}`}>{missingFxRate ? t("sidebar.balance.missingFxRate") : formatCurrencyMoney(displayValue, displayCurrency)}</span>;
}
