"use client";

import Link from "next/link";
import type { ElementType } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  CreditCard,
  HandCoins,
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
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  creditUsed: number;
  creditLimit: number;
  creditAvailable: number;
  creditCurrentBill: number;
  loan: number;
  loanReceivable: number;
  other: number;
  liquidAssets: number;
  liabilities: number;
  dailyNetWorth: number;
  totalNetWorth: number;
};

type InvestmentOverviewItem = {
  accountId?: string;
  fundCode: string;
  name: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
};

type OverviewDashboardProps = {
  netWorth: number;
  accountTypeTotals?: Partial<AccountTypeTotals> | null;
  assetDistribution: AssetDistItem[];
  monthIncome: number;
  monthExpense: number;
  accountList: AccountItem[];
  creditAccountList: CreditAccountItem[];
  debtAccountList?: AccountItem[];
  topPositions?: InvestmentOverviewItem[];
  investmentMarketValue?: number;
  investmentCost?: number;
  investmentFloatingPnL?: number;
  investmentFloatingPnLRate?: number;
  isRedUp: boolean;
};

const ZERO_TOTALS: AccountTypeTotals = {
  cash: 0,
  bankDebit: 0,
  ewallet: 0,
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

function directionalClass(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
  if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
  return "text-slate-500";
}

function distributionBarClass(index: number) {
  const palette = ["bg-blue-500", "bg-cyan-500", "bg-emerald-500", "bg-amber-500", "bg-slate-400"];
  return palette[index % palette.length];
}

function formatRate(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

export function OverviewDashboard({
  netWorth,
  accountTypeTotals,
  assetDistribution,
  monthIncome,
  monthExpense,
  accountList,
  creditAccountList,
  debtAccountList = [],
  topPositions = [],
  investmentMarketValue,
  investmentCost,
  investmentFloatingPnL,
  investmentFloatingPnLRate,
  isRedUp,
}: OverviewDashboardProps) {
  const totals: AccountTypeTotals = { ...ZERO_TOTALS, ...(accountTypeTotals ?? {}) };
  const investMarketValue = investmentMarketValue ?? totals.investmentMarketValue;
  const investCost = investmentCost ?? totals.investmentCost;
  const investFloatingPnL = investmentFloatingPnL ?? totals.investmentFloatingPnL;
  const investFloatingRate = investmentFloatingPnLRate ?? (investCost > 0 ? investFloatingPnL / investCost : 0);
  const monthNet = monthIncome - monthExpense;
  const topAccounts = accountList.slice().sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).slice(0, 5);
  const creditCards = creditAccountList.filter((account) => account.creditLimit > 0 || account.balance !== 0 || account.currentBill !== 0);
  const debtAccounts = debtAccountList.filter((account) => account.balance !== 0);
  const overviewModuleCount = 2 + (creditCards.length > 0 ? 1 : 0) + (debtAccounts.length > 0 ? 1 : 0);
  const moduleClass = (index: number) =>
    `panel-surface ${overviewModuleCount === 3 && index === 0 ? "xl:col-span-2" : ""}`;

  return (
    <div className="page-body bg-transparent">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(220px,1fr)_2.2fr] md:items-center md:px-6">
            <div>
              <div className="text-xs font-medium tracking-[0.18em] text-slate-400 uppercase">Overview</div>
              <div className="mt-1 text-sm text-slate-500">总净值</div>
              <div className={`mt-1 text-3xl font-semibold tracking-tight md:text-4xl ${directionalClass(netWorth, isRedUp)}`}>
                {formatMoneyYuan(netWorth)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <MetricCard label="流动资产" value={formatMoneyYuan(totals.liquidAssets)} valueClass={directionalClass(totals.liquidAssets, isRedUp)} />
              <MetricCard label="总负债" value={formatMoneyYuan(totals.liabilities)} valueClass={directionalClass(totals.liabilities, isRedUp)} />
              <MetricCard label="本月净流入" value={formatMoneyYuan(monthNet)} valueClass={directionalClass(monthNet, isRedUp)} />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className={moduleClass(0)}>
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <PiggyBank className="h-4 w-4 text-emerald-500" />
                投资总览
              </div>
              <Link href="/invest" className="text-xs text-blue-600 hover:text-blue-800">进入投资</Link>
            </div>
            <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
              <MetricCard label="投资市值" value={formatMoneyYuan(investMarketValue)} valueClass={directionalClass(investMarketValue, isRedUp)} />
              <MetricCard label="持仓成本" value={formatMoneyYuan(investCost)} />
              <MetricCard label="浮动盈亏" value={formatMoneyYuan(investFloatingPnL)} valueClass={directionalClass(investFloatingPnL, isRedUp)} />
              <MetricCard label="浮盈率" value={formatRate(investFloatingRate)} valueClass={directionalClass(investFloatingRate, isRedUp)} />
            </div>
            <InvestmentCostProfitBar
              cost={investCost}
              floatingPnL={investFloatingPnL}
              floatingRate={investFloatingRate}
            />
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {topPositions.length > 0 ? (
                topPositions.slice(0, 5).map((item) => (
                  <Link
                    key={item.accountId ?? item.fundCode}
                    href={item.accountId ? `/?accountId=${item.accountId}&view=investfund` : "/invest"}
                    className="grid grid-cols-[minmax(0,1fr)_96px_96px_72px] items-center gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="truncate text-sm font-semibold text-slate-800">{item.name}</div>
                    <div className={`text-right text-xs font-semibold tabular-nums ${directionalClass(item.marketValue, isRedUp)}`}>{formatMoney(item.marketValue)}</div>
                    <div className={`text-right text-xs font-semibold tabular-nums ${directionalClass(item.floatingPnL, isRedUp)}`}>{formatMoney(item.floatingPnL)}</div>
                    <div className={`text-right text-xs font-semibold tabular-nums ${directionalClass(item.floatingPnLRate, isRedUp)}`}>{formatRate(item.floatingPnLRate)}</div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-8 text-center text-sm text-slate-400">暂无投资持仓</div>
              )}
            </div>
          </div>

          <div className={moduleClass(1)}>
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Wallet className="h-4 w-4 text-blue-500" />
                日常账户
              </div>
              <Link href="/accounts" className="text-xs text-blue-600 hover:text-blue-800">查看全部</Link>
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
                    <div className={`text-xs font-medium tabular-nums ${directionalClass(item.value, isRedUp)}`}>{formatMoney(item.value)}</div>
                  </div>
                ))}
                {assetDistribution.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-400 sm:col-span-2">
                    暂无可统计的日常账户
                  </div>
                )}
              </div>
            </div>
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {topAccounts.length > 0 ? (
                topAccounts.slice(0, 4).map((account) => (
                  <Link key={account.id} href={`/?accountId=${account.id}&view=detail`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{account.name}</div>
                      <div className="mt-1 text-[11px] text-slate-400">{account.kind}</div>
                    </div>
                    <div className={`shrink-0 text-sm font-semibold tabular-nums ${directionalClass(account.balance, isRedUp)}`}>{formatMoney(account.balance)}</div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">暂无日常账户</div>
              )}
            </div>
          </div>

          {creditCards.length > 0 && (
            <div className={moduleClass(2)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CreditCard className="h-4 w-4 text-amber-500" />
                  信用卡
                </div>
                <Link href="/accounts?tab=credit" className="text-xs text-blue-600 hover:text-blue-800">查看全部</Link>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
                <MetricCard label="已用额度" value={formatMoneyYuan(totals.creditUsed)} valueClass={directionalClass(totals.creditUsed, isRedUp)} />
                <MetricCard label="可用额度" value={formatMoneyYuan(totals.creditAvailable)} valueClass={directionalClass(totals.creditAvailable, isRedUp)} />
                <MetricCard label="本期账单" value={formatMoneyYuan(totals.creditCurrentBill)} valueClass={directionalClass(totals.creditCurrentBill, isRedUp)} />
              </div>
              <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2">
                {creditCards.slice(0, 4).map((account) => (
                  <Link
                    key={account.id}
                    href={`/?accountId=${account.id}&view=bill`}
                    className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-3 transition-colors hover:border-amber-200 hover:bg-amber-50/30"
                  >
                    <div className="truncate text-sm font-semibold text-slate-800">{account.name}</div>
                    <div className="mt-3 text-[11px] text-slate-400">已用</div>
                    <div className={`mt-0.5 text-base font-semibold tabular-nums ${directionalClass(account.balance, isRedUp)}`}>{formatMoney(account.balance)}</div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-[11px] text-slate-400">可用</div>
                        <div className="mt-0.5 font-semibold tabular-nums text-slate-700">{formatMoney(account.availableLimit)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">账单</div>
                        <div className={`mt-0.5 font-semibold tabular-nums ${directionalClass(account.currentBill, isRedUp)}`}>{formatMoney(account.currentBill)}</div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {debtAccounts.length > 0 && (
            <div className={moduleClass(creditCards.length > 0 ? 3 : 2)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <HandCoins className="h-4 w-4 text-rose-500" />
                  债务/债权
                </div>
                <Link href="/liabilities" className="text-xs text-blue-600 hover:text-blue-800">查看全部</Link>
              </div>
              <div className="grid grid-cols-3 gap-3 px-4 py-4">
                <MetricCard label="我欠别人" value={formatMoneyYuan(totals.loan)} valueClass={directionalClass(-totals.loan, isRedUp)} />
                <MetricCard label="别人欠我" value={formatMoneyYuan(totals.loanReceivable)} valueClass={directionalClass(totals.loanReceivable, isRedUp)} />
                <MetricCard label="账户数" value={`${debtAccounts.length} 个`} />
              </div>
              <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2">
                {debtAccounts.slice(0, 4).map((account) => (
                  <Link
                    key={account.id}
                    href={`/?accountId=${account.id}&view=detail`}
                    className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-3 transition-colors hover:border-rose-200 hover:bg-rose-50/30"
                  >
                    <div className="line-clamp-2 min-h-[40px] text-sm font-semibold leading-5 text-slate-800">{account.name}</div>
                    <div className="mt-3 text-[11px] text-slate-400">{account.balance >= 0 ? "别人欠我" : "我欠别人"}</div>
                    <div className={`mt-0.5 text-base font-semibold tabular-nums ${directionalClass(account.balance, isRedUp)}`}>{formatMoney(Math.abs(account.balance))}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
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

function InvestmentCostProfitBar({
  cost,
  floatingPnL,
  floatingRate,
}: {
  cost: number;
  floatingPnL: number;
  floatingRate: number;
}) {
  const pnlAbs = Math.abs(floatingPnL);
  const total = cost + pnlAbs;
  const costPct = total > 0 ? Math.max(0, Math.min(100, (cost / total) * 100)) : 0;
  const pnlPct = total > 0 ? 100 - costPct : 0;
  const isLoss = floatingPnL < 0;
  const pnlLabel = isLoss ? "亏损" : "收益";
  const pnlClass = isLoss ? "bg-emerald-500" : "bg-red-500";
  const pnlTextClass = isLoss ? "text-emerald-700" : "text-red-600";

  if (total <= 0) {
    return (
      <div className="px-4 pb-4">
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-400">
          暂无成本收益比例
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 pb-4">
      <div>
        <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
          <div
            className="bg-blue-500 transition-all"
            style={{ width: `${Math.max(costPct, cost > 0 ? 2 : 0)}%` }}
            title={`成本: ${formatMoneyYuan(cost)} (${costPct.toFixed(1)}%)`}
          />
          <div
            className={`${pnlClass} transition-all`}
            style={{ width: `${Math.max(pnlPct, pnlAbs > 0 ? 2 : 0)}%` }}
            title={`${pnlLabel}: ${formatMoneyYuan(floatingPnL)} (${pnlPct.toFixed(1)}%)`}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-slate-700">成本</div>
            <div className="text-[11px] text-slate-400">{costPct.toFixed(1)}%</div>
          </div>
          <div className="text-xs font-medium tabular-nums text-slate-900">{formatMoney(cost)}</div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
          <span className={`h-2.5 w-2.5 rounded-full ${pnlClass}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-slate-700">{pnlLabel}</div>
            <div className="text-[11px] text-slate-400">{pnlPct.toFixed(1)}%</div>
          </div>
          <div className={`text-xs font-medium tabular-nums ${pnlTextClass}`}>{formatMoney(floatingPnL)}</div>
        </div>
      </div>
    </div>
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
