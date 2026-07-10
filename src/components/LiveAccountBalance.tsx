"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/format";
import { FINANCE_DATA_CHANGED_EVENT, LEGACY_FINANCE_REFRESH_EVENT } from "@/lib/client/refresh";

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
}: {
  accountId?: string | null;
  initialValue: number;
  isRedUp: boolean;
  mode: "total" | "account";
  semantic?: "default" | "liability";
  displayMultiplier?: 1 | -1;
}) {
  const [value, setValue] = useState(initialValue);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshBusy = useRef(false);

  useEffect(() => {
    setValue(initialValue);
  }, [accountId, initialValue, mode]);

  useEffect(() => {
    const refresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(async () => {
        if (refreshBusy.current) return;
        refreshBusy.current = true;
        try {
          const res = await fetch("/api/v1/accounts/internal", { cache: "no-store" });
          const data = await res.json();
          if (!data?.ok || !Array.isArray(data.accounts)) return;
          const accounts = data.accounts as Array<{ id?: string | null; balance?: number | string | null }>;
          if (mode === "total") {
            setValue(accounts.reduce((sum, account) => sum + Number(account.balance ?? 0), 0));
            return;
          }
          const matched = accounts.find((account) => account.id === accountId);
          if (matched) {
            setValue(Number(matched.balance ?? 0));
          }
        } catch {
        } finally {
          refreshBusy.current = false;
        }
      }, 80);
    };

    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    window.addEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      window.removeEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [accountId, mode]);

  const displayValue = value * displayMultiplier;
  const cls = semantic === "liability" ? liabilityCls(displayValue, isRedUp) : pnlCls(displayValue, isRedUp);
  return <span className={`tabular-nums font-semibold ${cls}`}>{formatMoney(displayValue)}</span>;
}
