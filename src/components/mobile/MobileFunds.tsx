"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, TrendingUp } from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";

type FundAccount = {
  id: string;
  label: string;
  marketValue: number;
};

type FundPosition = {
  fundCode: string;
  name: string;
  cost: number;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
};

type ClearedFundPosition = {
  fundCode: string;
  name: string;
  historicalProfit: number;
  totalBuyAmount: number;
  totalRedeemAmount: number;
  clearedDate: string;
};

type FundEntry = {
  id: string;
  fundCode: string;
  date: string;
  subtype: string;
  amount: number;
  units: number | null;
};

export function MobileFunds({
  accounts,
  selectedAccountId,
  positions,
  clearedPositions,
  entries,
  totalMarketValue,
  totalCost,
  isRedUp,
}: {
  accounts: FundAccount[];
  selectedAccountId: string;
  positions: FundPosition[];
  clearedPositions: ClearedFundPosition[];
  entries: FundEntry[];
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
}) {
  const [listKind, setListKind] = useState<"active" | "cleared">("active");
  const [selectedFundCode, setSelectedFundCode] = useState(positions[0]?.fundCode ?? clearedPositions[0]?.fundCode ?? "");
  const totalPnL = totalMarketValue - totalCost;
  const relatedEntries = useMemo(
    () => entries.filter((entry) => !selectedFundCode || entry.fundCode === selectedFundCode).slice(0, 8),
    [entries, selectedFundCode],
  );

  function selectList(next: "active" | "cleared") {
    setListKind(next);
    const nextRows = next === "active" ? positions : clearedPositions;
    if (!nextRows.some((row) => row.fundCode === selectedFundCode)) {
      setSelectedFundCode(nextRows[0]?.fundCode ?? "");
    }
  }

  const pnlClass = (value: number) => {
    if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
    if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
    return "text-slate-700";
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 grid grid-cols-3 border-b border-slate-200 bg-slate-50/96 px-2 backdrop-blur">
        <MobileTab href="/investments" label="投资总览" />
        <MobileTab href="/funds" label="基金持仓" active />
        <MobileTab href="/regular-invest" label="定投计划" />
      </div>

      <div className="space-y-2.5 px-3 py-2 pb-4">
        <label className="block rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <span className="mb-1 block text-[11px] font-medium text-slate-500">投资账户</span>
          <select
            value={selectedAccountId}
            onChange={(event) => { window.location.href = `/funds?accountId=${encodeURIComponent(event.target.value)}`; }}
            className="h-10 w-full bg-transparent text-sm font-semibold text-slate-900 outline-none"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}  {formatMoneyYuan(account.marketValue)}
              </option>
            ))}
          </select>
        </label>

        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-white shadow-sm">
          <div className="text-sm font-medium text-indigo-100">持仓总览</div>
          <div className="mt-1 break-all text-[26px] font-bold tabular-nums">{formatMoneyYuan(totalMarketValue)}</div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/15 pt-3">
            <SummaryMetric label="持仓成本" value={formatMoneyYuan(totalCost)} />
            <SummaryMetric label="浮动盈亏" value={formatMoneyYuan(totalPnL)} alignRight />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-200 p-1">
          <ListButton active={listKind === "active"} onClick={() => selectList("active")}>
            当前持仓 {positions.length}
          </ListButton>
          <ListButton active={listKind === "cleared"} onClick={() => selectList("cleared")}>
            已清仓 {clearedPositions.length}
          </ListButton>
        </div>

        <div className="space-y-2">
          {listKind === "active" ? positions.map((position) => (
            <Link
              key={position.fundCode}
              href={`/?accountId=${encodeURIComponent(selectedAccountId)}&view=investfund&fundCode=${encodeURIComponent(position.fundCode)}`}
              onClick={() => setSelectedFundCode(position.fundCode)}
              className="block rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
                  <TrendingUp size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{position.name || position.fundCode}</span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">{position.fundCode}</span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-slate-400" />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                <PositionMetric label="成本" value={formatMoneyYuan(position.cost)} />
                <PositionMetric label="市值" value={formatMoneyYuan(position.marketValue)} />
                <PositionMetric
                  label="浮盈"
                  value={`${formatMoneyYuan(position.floatingPnL)} (${formatRate(position.floatingPnLRate)})`}
                  className={pnlClass(position.floatingPnL)}
                  alignRight
                />
              </div>
            </Link>
          )) : clearedPositions.map((position) => (
            <button
              key={position.fundCode}
              type="button"
              onClick={() => setSelectedFundCode(position.fundCode)}
              className={`w-full rounded-lg border bg-white px-3 py-3 text-left shadow-sm ${selectedFundCode === position.fundCode ? "border-indigo-400" : "border-slate-200"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-900">{position.name || position.fundCode}</span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">{position.fundCode}</span>
                </span>
                <span className={`shrink-0 text-sm font-bold tabular-nums ${pnlClass(position.historicalProfit)}`}>
                  {formatMoneyYuan(position.historicalProfit)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                <PositionMetric label="累计买入" value={formatMoneyYuan(position.totalBuyAmount)} />
                <PositionMetric label="累计收回" value={formatMoneyYuan(position.totalRedeemAmount)} />
                <PositionMetric label="清仓日" value={position.clearedDate || "-"} alignRight />
              </div>
            </button>
          ))}

          {((listKind === "active" && positions.length === 0) || (listKind === "cleared" && clearedPositions.length === 0)) ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
              {listKind === "active" ? "当前账户暂无基金持仓" : "暂无已清仓基金"}
            </div>
          ) : null}
        </div>

        {relatedEntries.length > 0 ? (
          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-900">相关记录</div>
            <div className="divide-y divide-slate-100">
              {relatedEntries.map((entry) => (
                <div key={entry.id} className="grid min-h-14 grid-cols-[1fr_auto] items-center gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-800">{entry.date}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">{fundSubtypeLabel(entry.subtype)} · {entry.fundCode}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums text-slate-900">{formatMoneyYuan(entry.amount)}</div>
                    <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">{entry.units == null ? "-" : `${entry.units.toFixed(2)} 份`}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function MobileTab({ href, label, active = false }: { href: string; label: string; active?: boolean }) {
  return (
    <Link href={href} className={`flex h-11 items-center justify-center border-b-2 text-xs font-semibold ${active ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}>
      {label}
    </Link>
  );
}

function ListButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`h-9 rounded-md text-xs font-semibold ${active ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600"}`}>
      {children}
    </button>
  );
}

function SummaryMetric({ label, value, alignRight = false }: { label: string; value: string; alignRight?: boolean }) {
  return (
    <div className={alignRight ? "text-right" : ""}>
      <div className="text-[11px] text-indigo-200">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function PositionMetric({ label, value, className = "text-slate-900", alignRight = false }: { label: string; value: string; className?: string; alignRight?: boolean }) {
  return (
    <div className={`min-w-0 ${alignRight ? "text-right" : ""}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate text-xs font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function formatRate(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function fundSubtypeLabel(subtype: string) {
  if (subtype === "buy") return "买入";
  if (subtype === "redeem") return "赎回";
  if (subtype === "dividend_cash") return "现金分红";
  if (subtype === "dividend_reinvest") return "红利再投";
  if (subtype === "switch_in") return "转换转入";
  if (subtype === "switch_out") return "转换转出";
  return subtype || "基金交易";
}
