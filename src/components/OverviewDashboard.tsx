"use client";

import { formatMoney, formatMoneyYuan } from "@/lib/format";
import { TrendingUp, TrendingDown, Wallet, BarChart3, PieChart, CreditCard, Landmark, Banknote, Coins, HandCoins } from "lucide-react";

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

type TopPositionItem = {
  fundCode: string;
  name: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
};

const KIND_LABEL: Record<string, string> = {
  cash: "现金",
  bank_debit: "借记卡",
  bank_credit: "信用卡",
  investment: "投资",
  ewallet: "电子钱包",
  loan: "贷款",
  other: "其他",
};

const KIND_ORDER = ["bank_debit", "investment", "ewallet", "cash", "bank_credit", "loan", "other"];

const KIND_ICON: Record<string, React.ElementType> = {
  bank_debit: Landmark,
  investment: BarChart3,
  ewallet: Coins,
  cash: Banknote,
  bank_credit: CreditCard,
  loan: HandCoins,
  other: Wallet,
};

type OverviewDashboardProps = {
  netWorth: number;
  floatingPnL: number;
  totalCost: number;
  assetDistribution: AssetDistItem[];
  monthIncome: number;
  monthExpense: number;
  accountList: AccountItem[];
  topPositions: TopPositionItem[];
  isRedUp: boolean;
};

function pnlCls(n: number, isRedUp: boolean) {
  if (n > 0) return isRedUp ? "text-red-600" : "text-emerald-700";
  if (n < 0) return isRedUp ? "text-emerald-700" : "text-red-600";
  return "text-slate-500";
}

function pnlBgCls(n: number, isRedUp: boolean) {
  if (n > 0) return isRedUp ? "bg-red-50 border-red-100" : "bg-emerald-50 border-emerald-100";
  if (n < 0) return isRedUp ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100";
  return "bg-slate-50 border-slate-100";
}

function pctBarCls(n: number, isRedUp: boolean) {
  if (n > 0) return isRedUp ? "bg-red-500" : "bg-emerald-500";
  if (n < 0) return isRedUp ? "bg-emerald-500" : "bg-red-500";
  return "bg-slate-400";
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function OverviewDashboard({
  netWorth,
  floatingPnL,
  totalCost,
  assetDistribution,
  monthIncome,
  monthExpense,
  accountList,
  topPositions,
  isRedUp,
}: OverviewDashboardProps) {
  const pnlRate = totalCost > 0 ? floatingPnL / totalCost : 0;
  const monthNet = monthIncome - monthExpense;

  // 按账户类型分组
  const groupedAccounts = new Map<string, AccountItem[]>();
  for (const kind of KIND_ORDER) groupedAccounts.set(kind, []);
  for (const a of accountList) {
    const list = groupedAccounts.get(a.kind) ?? [];
    list.push(a);
    groupedAccounts.set(a.kind, list);
  }

  return (
    <div className="flex-1 min-w-0 bg-background/50 overflow-y-auto custom-scrollbar">
      <div className="p-6 pb-32 max-w-5xl mx-auto">
        {/* Bento Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

          {/* ── Net Worth (span 2 cols) ── */}
          <div className="bento-card p-6 sm:col-span-2 lg:col-span-2">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="w-4 h-4 text-foreground/60" />
              <span className="text-sm text-foreground/60 font-ui">净资产</span>
            </div>
            <div className="font-heading text-3xl sm:text-4xl text-foreground tracking-tight">
              {formatMoneyYuan(netWorth)}
            </div>
          </div>

          {/* ── Floating PnL ── */}
          <div className={`bento-card p-6 border ${pnlBgCls(floatingPnL, isRedUp)}`}>
            <div className="flex items-center gap-2 mb-1">
              {floatingPnL >= 0
                ? <TrendingUp className="w-4 h-4 text-foreground/60" />
                : <TrendingDown className="w-4 h-4 text-foreground/60" />
              }
              <span className="text-sm text-foreground/60 font-ui">浮动盈亏</span>
            </div>
            <div className={`font-heading text-2xl tracking-tight ${pnlCls(floatingPnL, isRedUp)}`}>
              {formatMoneyYuan(floatingPnL)}
            </div>
            <div className={`text-sm font-ui mt-1 ${pnlCls(pnlRate, isRedUp)}`}>
              {fmtPct(pnlRate * 100)}
            </div>
          </div>

          {/* ── 本月收支 (span 2 cols) ── */}
          <div className="bento-card p-6 sm:col-span-2 lg:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-foreground/60" />
              <span className="text-sm text-foreground/60 font-ui">本月收支</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <span className="text-xs text-foreground/50 font-ui">收入</span>
                <div className={`font-heading text-lg tracking-tight ${pnlCls(monthIncome, true)}`}>
                  {formatMoneyYuan(monthIncome)}
                </div>
              </div>
              <div>
                <span className="text-xs text-foreground/50 font-ui">支出</span>
                <div className={`font-heading text-lg tracking-tight ${pnlCls(-monthExpense, false)}`}>
                  {formatMoneyYuan(-monthExpense)}
                </div>
              </div>
              <div>
                <span className="text-xs text-foreground/50 font-ui">净额</span>
                <div className={`font-heading text-lg tracking-tight ${pnlCls(monthNet, isRedUp)}`}>
                  {formatMoneyYuan(monthNet)}
                </div>
              </div>
            </div>
          </div>

          {/* ── 资产分布 (span 2 cols) ── */}
          <div className="bento-card p-6 sm:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <PieChart className="w-4 h-4 text-foreground/60" />
              <span className="text-sm text-foreground/60 font-ui">资产分布</span>
            </div>
            {/* Distribution bar */}
            <div className="flex gap-1 h-6 rounded-lg overflow-hidden mb-4">
              {assetDistribution.map(item => (
                <div
                  key={item.kind}
                  className={`${pctBarCls(item.value, isRedUp)} rounded-sm transition-all`}
                  style={{ width: `${Math.max(item.pct, 2)}%` }}
                  title={`${item.label}: ${formatMoneyYuan(item.value)} (${item.pct.toFixed(1)}%)`}
                />
              ))}
            </div>
            {/* Labels */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
              {assetDistribution.map(item => (
                <div key={item.kind} className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${pctBarCls(item.value, isRedUp)}`} />
                  <span className="text-xs text-foreground/60 font-ui truncate">{item.label}</span>
                  <span className="text-xs text-foreground font-ui ml-auto">{formatMoney(item.value)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── 账户余额 (span 1 col) ── */}
          <div className="bento-card p-6">
            <div className="flex items-center gap-2 mb-3">
              <Landmark className="w-4 h-4 text-foreground/60" />
              <span className="text-sm text-foreground/60 font-ui">账户余额</span>
            </div>
            <div className="space-y-3">
              {KIND_ORDER.filter(k => (groupedAccounts.get(k) ?? []).length > 0).map(kind => {
                const Icon = KIND_ICON[kind] ?? Wallet;
                const items = (groupedAccounts.get(kind) ?? []).filter(a => a.balance !== 0);
                if (items.length === 0) return null;
                const kindTotal = items.reduce((s, a) => s + a.balance, 0);
                return (
                  <div key={kind}>
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-3.5 h-3.5 text-foreground/50" />
                      <span className="text-xs font-ui text-foreground/50">{KIND_LABEL[kind] ?? kind}</span>
                      <span className="text-xs font-ui text-foreground ml-auto">{formatMoney(kindTotal)}</span>
                    </div>
                    <div className="ml-5 space-y-0.5">
                      {items.map(a => (
                        <div key={a.id} className="flex items-center text-xs font-ui">
                          <span className="text-foreground/40 truncate">{a.name}</span>
                          <span className={`ml-auto ${pnlCls(a.balance, true)}`}>{formatMoney(a.balance)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── 投资持仓摘要 (span 3 cols if has positions) ── */}
          {topPositions.length > 0 && (
            <div className="bento-card p-6 sm:col-span-2 lg:col-span-3">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="w-4 h-4 text-foreground/60" />
                <span className="text-sm text-foreground/60 font-ui">持仓摘要</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {topPositions.map(p => (
                  <div key={p.fundCode} className={`p-3 rounded-ui border ${pnlBgCls(p.floatingPnL, isRedUp)}`}>
                    <div className="text-xs font-ui text-foreground/50 truncate mb-1">{p.name}</div>
                    <div className={`font-heading text-sm tracking-tight ${pnlCls(p.floatingPnL, isRedUp)}`}>
                      {formatMoney(p.floatingPnL)}
                    </div>
                    <div className={`text-xs font-ui ${pnlCls(p.floatingPnLRate * 100, isRedUp)}`}>
                      {fmtPct(p.floatingPnLRate * 100)}
                    </div>
                    <div className="text-xs font-ui text-foreground/40 mt-1">
                      市值 {formatMoney(p.marketValue)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
