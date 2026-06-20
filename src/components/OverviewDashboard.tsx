"use client";

import Link from "next/link";
import type { ElementType } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  CreditCard,
  Landmark,
  PiggyBank,
  Wallet,
} from "lucide-react";

import { formatMoney, formatMoneyYuan } from "@/lib/format";

type AssetDistItem = {
  kind: string;
  label: string;
  value: number;
  pct: number;
};

type AccountItem = {
  id: string;
  name: string;
  kind: string;
  balance: number;
};

type CreditAccountItem = AccountItem & {
  creditLimit: number;
  availableLimit: number;
  currentBill: number;
};

type AccountTypeTotals = {
  cash: number;
  bankDebit: number;
  ewallet: number;
  creditUsed: number;
  creditLimit: number;
  creditAvailable: number;
  creditCurrentBill: number;
  loan: number;
  other: number;
  liquidAssets: number;
  liabilities: number;
  dailyNetWorth: number;
};

type OverviewDashboardProps = {
  netWorth: number;
  accountTypeTotals?: Partial<AccountTypeTotals> | null;
  assetDistribution: AssetDistItem[];
  monthIncome: number;
  monthExpense: number;
  accountList: AccountItem[];
  creditAccountList: CreditAccountItem[];
  isRedUp: boolean;
};

const ZERO_TOTALS: AccountTypeTotals = {
  cash: 0,
  bankDebit: 0,
  ewallet: 0,
  creditUsed: 0,
  creditLimit: 0,
  creditAvailable: 0,
  creditCurrentBill: 0,
  loan: 0,
  other: 0,
  liquidAssets: 0,
  liabilities: 0,
  dailyNetWorth: 0,
};

function directionalClass(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
  if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
  return "text-slate-500";
}

function distributionBarClass(index: number) {
  const palette = ["bg-blue-500", "bg-cyan-500", "bg-emerald-500", "bg-amber-500", "bg-slate-400"];
  return palette[index % palette.length];
}

export function OverviewDashboard({
  netWorth,
  accountTypeTotals,
  assetDistribution,
  monthIncome,
  monthExpense,
  accountList,
  creditAccountList,
  isRedUp,
}: OverviewDashboardProps) {
  const totals: AccountTypeTotals = { ...ZERO_TOTALS, ...(accountTypeTotals ?? {}) };
  const monthNet = monthIncome - monthExpense;
  const topAccounts = accountList.slice().sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).slice(0, 5);
  const typeCards = [
    { label: "现金余额", value: totals.cash, href: "/accounts", tone: "neutral" },
    { label: "借记卡", value: totals.bankDebit, href: "/accounts", tone: "neutral" },
    { label: "第三方余额", value: totals.ewallet, href: "/accounts", tone: "neutral" },
    { label: "信用卡余额", value: totals.creditUsed, href: "/accounts?tab=credit", tone: "liability", sub: `可用 ${formatMoney(totals.creditAvailable)}` },
    { label: "负债", value: totals.liabilities, href: "/accounts", tone: "liability", sub: `贷款 ${formatMoney(totals.loan)}` },
    { label: "其他账户", value: totals.other, href: "/accounts", tone: "neutral" },
  ];

  return (
    <div className="page-body bg-transparent">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="flex flex-col gap-5 px-5 py-5 md:flex-row md:items-end md:justify-between md:px-6">
            <div className="space-y-2">
              <div className="text-xs font-medium tracking-[0.18em] text-slate-400 uppercase">Home Overview</div>
              <div className="text-[13px] text-slate-500">现金、银行卡、第三方余额、信用卡和负债一眼看清</div>
              <div className="text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">
                {formatMoneyYuan(netWorth)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:min-w-[380px]">
              <MetricCard label="流动资产" value={formatMoneyYuan(totals.liquidAssets)} />
              <MetricCard label="总负债" value={formatMoneyYuan(totals.liabilities)} valueClass="text-slate-700" />
              <MetricCard label="本月净流入" value={formatMoneyYuan(monthNet)} valueClass={directionalClass(monthNet, isRedUp)} />
              <MetricCard label="本期信用卡账单" value={formatMoneyYuan(totals.creditCurrentBill)} />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {typeCards.map((card) => (
            <Link
              key={card.label}
              href={card.href}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors hover:border-blue-200 hover:bg-blue-50/30"
            >
              <div className="text-xs text-slate-500">{card.label}</div>
              <div className={`mt-2 text-base font-semibold tabular-nums ${card.tone === "liability" ? "text-slate-700" : "text-slate-900"}`}>
                {formatMoney(card.value)}
              </div>
              {card.sub && <div className="mt-1 text-[11px] text-slate-400">{card.sub}</div>}
            </Link>
          ))}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <EntryCard href="/accounts" icon={Landmark} title="资金账户" desc="现金、借记卡、钱包、贷款" value={`${accountList.length} 个账户`} />
          <EntryCard href="/accounts?tab=credit" icon={CreditCard} title="信用卡" desc="额度、账单、还款日" value={`${creditAccountList.length} 张卡`} />
          <EntryCard href="/invest" icon={PiggyBank} title="投资" desc="持仓、市值、盈亏" value="进入投资总览" />
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="panel-surface">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Wallet className="h-4 w-4 text-blue-500" />
                日常账户分布
              </div>
              <div className="text-xs text-slate-400">不包含投资持仓</div>
            </div>
            <div className="space-y-4 px-4 py-4">
              <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
                {assetDistribution.map((item, index) => (
                  <div
                    key={item.kind}
                    className={`${distributionBarClass(index)} transition-all`}
                    style={{ width: `${Math.max(item.pct, 2)}%` }}
                    title={`${item.label}: ${formatMoneyYuan(item.value)} (${item.pct.toFixed(1)}%)`}
                  />
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {assetDistribution.map((item, index) => (
                  <div key={item.kind} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${distributionBarClass(index)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-slate-700">{item.label}</div>
                      <div className="text-[11px] text-slate-400">{item.pct.toFixed(1)}%</div>
                    </div>
                    <div className="text-xs font-medium tabular-nums text-slate-800">{formatMoney(item.value)}</div>
                  </div>
                ))}
                {assetDistribution.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-400 sm:col-span-2">
                    暂无可统计的日常账户
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="panel-surface">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Banknote className="h-4 w-4 text-cyan-500" />
                重点日常账户
              </div>
              <Link href="/accounts" className="text-xs text-blue-600 hover:text-blue-800">查看全部</Link>
            </div>
            <div className="divide-y divide-slate-100">
              {topAccounts.length > 0 ? (
                topAccounts.map((account) => (
                  <Link key={account.id} href={`/?accountId=${account.id}&view=detail`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{account.name}</div>
                      <div className="mt-1 text-[11px] text-slate-400">{account.kind}</div>
                    </div>
                    <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{formatMoney(account.balance)}</div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">暂无日常账户</div>
              )}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <CashFlowCard
            label="本月收入"
            value={formatMoneyYuan(monthIncome)}
            icon={ArrowUpRight}
            className={isRedUp ? "text-red-600" : "text-emerald-600"}
          />
          <CashFlowCard
            label="本月支出"
            value={formatMoneyYuan(-monthExpense)}
            icon={ArrowDownRight}
            className={isRedUp ? "text-emerald-600" : "text-red-600"}
          />
          <CashFlowCard
            label="本月净流入"
            value={formatMoneyYuan(monthNet)}
            icon={Wallet}
            className={directionalClass(monthNet, isRedUp)}
          />
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value, valueClass = "text-slate-900" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function EntryCard({
  href,
  icon: Icon,
  title,
  desc,
  value,
}: {
  href: string;
  icon: ElementType;
  title: string;
  desc: string;
  value: string;
}) {
  return (
    <Link href={href} className="panel-surface px-4 py-4 transition-colors hover:bg-white">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="mt-0.5 text-xs text-slate-500">{desc}</div>
        </div>
      </div>
      <div className="mt-4 text-xs font-medium text-slate-500">{value}</div>
    </Link>
  );
}

function CashFlowCard({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  icon: ElementType;
  className: string;
}) {
  return (
    <div className="panel-surface px-4 py-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        <Icon className={`h-4 w-4 ${className}`} />
      </div>
      <div className={`mt-2 text-lg font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}
