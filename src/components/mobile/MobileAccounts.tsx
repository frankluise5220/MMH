"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Banknote,
  ChevronDown,
  ChevronRight,
  Coins,
  CreditCard,
  HandCoins,
  Landmark,
  PiggyBank,
  Wallet,
} from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";

type AccountRow = {
  id: string;
  name: string;
  hoverTitle?: string;
  kind: string;
  groupName: string;
  balance: number;
};

type CreditRow = AccountRow & {
  creditLimit: number;
  availableLimit: number;
  currentBill: number;
};

type AccountGroup = {
  kind: string;
  label: string;
  accounts: AccountRow[];
};

export function MobileAccounts({
  assetTotal,
  groups,
  creditAccounts,
  isRedUp,
}: {
  assetTotal: number;
  groups: AccountGroup[];
  creditAccounts: CreditRow[];
  isRedUp: boolean;
}) {
  const [hideZero, setHideZero] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const visibleGroups = useMemo(() => {
    const base = groups.map((group) => ({
      ...group,
      accounts: hideZero ? group.accounts.filter((account) => Math.abs(account.balance) >= 0.005) : group.accounts,
    }));
    const visibleCredit = hideZero
      ? creditAccounts.filter((account) => Math.abs(account.balance) >= 0.005 || Math.abs(account.currentBill) >= 0.005)
      : creditAccounts;
    if (visibleCredit.length > 0) {
      base.push({ kind: "bank_credit", label: "信用卡", accounts: visibleCredit });
    }
    return base.filter((group) => group.accounts.length > 0);
  }, [creditAccounts, groups, hideZero]);

  const accountCount = visibleGroups.reduce((sum, group) => sum + group.accounts.length, 0);

  function toggleGroup(kind: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-100 px-3 py-2">
      <div className="space-y-2.5 pb-4">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-center text-white shadow-sm">
          <div className="text-sm font-medium text-indigo-100">资金合计</div>
          <div className="mt-1 break-all text-[26px] font-bold tabular-nums">{formatMoneyYuan(assetTotal)}</div>
          <div className="mt-3 flex items-center justify-center gap-5 text-xs text-indigo-100">
            <span>{visibleGroups.length} 个分类</span>
            <span>{accountCount} 个账户</span>
          </div>
        </section>

        <label className="flex min-h-14 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">隐藏零余额账户</span>
            <span className="mt-0.5 block text-xs text-slate-500">仅影响当前手机列表</span>
          </span>
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(event) => setHideZero(event.target.checked)}
            className="h-5 w-5 accent-indigo-600"
          />
        </label>

        {visibleGroups.length > 0 ? visibleGroups.map((group) => {
          const total = group.accounts.reduce((sum, account) => sum + account.balance, 0);
          const isCollapsed = collapsed.has(group.kind);
          return (
            <section key={group.kind} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => toggleGroup(group.kind)}
                className="flex min-h-16 w-full items-center gap-3 bg-slate-50 px-3 py-2 text-left"
              >
                <AccountKindIcon kind={group.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{group.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{group.accounts.length} 个账户</span>
                </span>
                <span className={`shrink-0 text-sm font-semibold tabular-nums ${moneyClass(group.kind, total, isRedUp)}`}>{formatMoneyYuan(total)}</span>
                <ChevronDown size={19} className={`shrink-0 text-slate-400 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
              </button>
              {!isCollapsed ? (
                <div className="divide-y divide-slate-100">
                  {group.accounts.map((account) => {
                    const detailView = account.kind === "bank_credit" ? "bill" : account.kind === "deposit" ? "deposit" : account.kind === "loan" ? "debt" : "detail";
                    return (
                      <Link
                        key={account.id}
                        href={`/?accountId=${account.id}&view=${detailView}`}
                        title={account.hoverTitle}
                        className="flex min-h-16 items-center gap-3 px-3 py-2.5"
                      >
                        <AccountKindIcon kind={account.kind} compact />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-900">{account.name}</span>
                          <span className="mt-0.5 block truncate text-xs text-slate-500">{account.groupName}</span>
                        </span>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${moneyClass(account.kind, account.balance, isRedUp)}`}>{formatMoneyYuan(account.balance)}</span>
                        <ChevronRight size={18} className="shrink-0 text-slate-400" />
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        }) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
            暂无非零余额账户
          </div>
        )}
      </div>
    </div>
  );
}

function AccountKindIcon({ kind, compact = false }: { kind: string; compact?: boolean }) {
  const config = kind === "bank_debit"
    ? { icon: Landmark, className: "bg-blue-50 text-blue-700" }
    : kind === "bank_credit"
      ? { icon: CreditCard, className: "bg-rose-50 text-rose-700" }
      : kind === "ewallet"
        ? { icon: Coins, className: "bg-cyan-50 text-cyan-700" }
        : kind === "cash"
          ? { icon: Banknote, className: "bg-emerald-50 text-emerald-700" }
          : kind === "deposit"
            ? { icon: PiggyBank, className: "bg-amber-50 text-amber-700" }
            : kind === "loan"
              ? { icon: HandCoins, className: "bg-red-50 text-red-700" }
              : { icon: Wallet, className: "bg-slate-100 text-slate-700" };
  const Icon = config.icon;
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${compact ? "h-9 w-9" : "h-10 w-10"} ${config.className}`}>
      <Icon size={compact ? 18 : 20} />
    </span>
  );
}

function moneyClass(kind: string, value: number, isRedUp: boolean) {
  if (kind === "bank_credit" || (kind === "loan" && value < 0)) return isRedUp ? "text-emerald-700" : "text-red-700";
  if (value < 0) return "text-red-600";
  return "text-slate-900";
}
