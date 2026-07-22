"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ChevronRight,
  CreditCard,
  Eye,
  EyeOff,
  Landmark,
  PiggyBank,
  TrendingUp,
  Wallet,
} from "lucide-react";

import type { OverviewDashboardProps } from "@/components/OverviewDashboard";
import { formatMoneyYuan } from "@/lib/format";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";

const ZERO_TOTALS = {
  cash: 0,
  bankDebit: 0,
  ewallet: 0,
  deposit: 0,
  investmentMarketValue: 0,
  investmentCost: 0,
  investmentFloatingPnL: 0,
  creditUsed: 0,
  creditLimit: 0,
  creditAvailable: 0,
  creditCurrentBill: 0,
  loan: 0,
  loanReceivable: 0,
  other: 0,
  liquidAssets: 0,
  liabilities: 0,
  dailyNetWorth: 0,
  totalNetWorth: 0,
};

export function MobileOverviewDashboard({
  netWorth,
  accountTypeTotals,
  monthIncome,
  monthExpense,
  accountList,
  creditAccountList,
  topPositions = [],
  investmentMarketValue,
  isRedUp,
}: OverviewDashboardProps) {
  const [showAmounts, setShowAmounts] = useState(true);
  const totals = { ...ZERO_TOTALS, ...(accountTypeTotals ?? {}) };
  const investMarketValue = investmentMarketValue ?? totals.investmentMarketValue;
  const monthNet = monthIncome - monthExpense;
  const creditUsed = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.balance), 0);
  const creditAvailable = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.availableLimit), 0);
  const creditBill = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.currentBill), 0);

  const amount = (value: number) => showAmounts ? formatMoneyYuan(value) : "****";
  const valueClass = (value: number) => {
    if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
    if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
    return "text-slate-700";
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-100 px-3 py-2">
      <div className="space-y-2.5 pb-4">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-white shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-indigo-100">总资产</span>
            <button
              type="button"
              onClick={() => setShowAmounts((visible) => !visible)}
              className="flex h-10 w-10 items-center justify-center text-indigo-100"
              aria-label={showAmounts ? "隐藏金额" : "显示金额"}
            >
              {showAmounts ? <Eye size={19} /> : <EyeOff size={19} />}
            </button>
          </div>
          <div className="mt-1 break-all text-[28px] font-bold tabular-nums">{amount(netWorth)}</div>
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/15 pt-3">
            <HeaderMetric label="日常" value={amount(totals.dailyNetWorth)} />
            <HeaderMetric label="投资" value={amount(investMarketValue)} />
            <HeaderMetric label="负债" value={amount(totals.liabilities)} liability />
          </div>
        </section>

        <section className="grid grid-cols-3 rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
          <CompactMetric label="本月收入" value={amount(Math.abs(monthIncome))} className={isRedUp ? "text-red-600" : "text-emerald-600"} />
          <CompactMetric label="本月支出" value={amount(Math.abs(monthExpense))} className={isRedUp ? "text-emerald-600" : "text-red-600"} />
          <CompactMetric label="结余" value={amount(monthNet)} className={valueClass(monthNet)} align="right" />
        </section>

        <section className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
          <div className="grid grid-cols-3 gap-x-2 gap-y-4">
            <CompactMetric label="现金" value={amount(totals.cash)} />
            <CompactMetric label="借记卡" value={amount(totals.bankDebit)} />
            <CompactMetric label="第三方" value={amount(totals.ewallet)} align="right" />
            <CompactMetric label="存款" value={amount(totals.deposit)} />
            <CompactMetric label="债权" value={amount(totals.loanReceivable)} />
            <CompactMetric label="负债" value={amount(totals.liabilities)} className="text-red-600" align="right" />
          </div>
        </section>

        {creditAccountList.length > 0 ? (
          <section className="grid grid-cols-3 rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
            <CompactMetric label="信用卡已用" value={amount(creditUsed)} className="text-red-600" />
            <CompactMetric label="可用额度" value={amount(creditAvailable)} />
            <CompactMetric label="本期账单" value={amount(creditBill)} align="right" />
          </section>
        ) : null}

        {topPositions.length > 0 ? (
          <section>
            <MobileSectionHeader label="投资账户" href="/investments" />
            <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              {topPositions.slice(0, 6).map((position) => (
                <Link
                  key={`${position.accountId ?? ""}:${position.fundCode}`}
                  href={position.accountId ? `/?accountId=${position.accountId}&view=${getInvestmentAccountView(position)}` : "/investments"}
                  className="flex min-h-16 items-center gap-3 px-3 py-2.5"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                    <TrendingUp size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{position.name || position.fundCode}</span>
                    <span className="mt-0.5 block text-xs tabular-nums text-slate-500">{amount(position.marketValue)}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={`block text-sm font-semibold tabular-nums ${valueClass(position.floatingPnL)}`}>{amount(position.floatingPnL)}</span>
                    <span className="mt-0.5 block text-[11px] tabular-nums text-slate-500">{showAmounts ? `${position.floatingPnLRate >= 0 ? "+" : ""}${(position.floatingPnLRate * 100).toFixed(2)}%` : "****"}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {accountList.length > 0 ? (
          <section>
            <MobileSectionHeader label="资金账户" href="/accounts" />
            <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              {accountList.slice(0, 8).map((account) => (
                <Link
                  key={account.id}
                  href={`/?accountId=${account.id}&view=${account.kind === "bank_credit" ? "bill" : "detail"}`}
                  className="flex min-h-16 items-center gap-3 px-3 py-2.5"
                >
                  <AccountIcon kind={account.kind} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{account.name}</span>
                  <span className={`shrink-0 text-sm font-semibold tabular-nums ${account.balance < 0 ? "text-red-600" : "text-slate-900"}`}>{amount(account.balance)}</span>
                  <ChevronRight size={18} className="shrink-0 text-slate-400" />
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function HeaderMetric({ label, value, liability = false }: { label: string; value: string; liability?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-indigo-200">{label}</div>
      <div className={`mt-0.5 truncate text-xs font-semibold tabular-nums ${liability ? "text-rose-200" : "text-white"}`}>{value}</div>
    </div>
  );
}

function CompactMetric({ label, value, className = "text-slate-900", align = "left" }: { label: string; value: string; className?: string; align?: "left" | "right" }) {
  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : "text-left"}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-[13px] font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function MobileSectionHeader({ label, href }: { label: string; href: string }) {
  return (
    <div className="flex h-9 items-center justify-between px-1">
      <h2 className="text-sm font-semibold text-slate-900">{label}</h2>
      <Link href={href} className="flex h-9 items-center gap-0.5 text-xs font-medium text-indigo-600">
        查看全部 <ChevronRight size={15} />
      </Link>
    </div>
  );
}

function AccountIcon({ kind }: { kind: string }) {
  const config = kind === "bank_credit"
    ? { icon: CreditCard, className: "bg-rose-50 text-rose-700" }
    : kind === "ewallet"
      ? { icon: Wallet, className: "bg-cyan-50 text-cyan-700" }
      : kind === "cash"
        ? { icon: PiggyBank, className: "bg-emerald-50 text-emerald-700" }
        : { icon: Landmark, className: "bg-blue-50 text-blue-700" };
  const Icon = config.icon;
  return (
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${config.className}`}>
      <Icon size={18} />
    </span>
  );
}
