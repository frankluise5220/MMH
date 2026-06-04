"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { toNumber } from "@/lib/date-utils";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download } from "lucide-react";
import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { FillNavButton } from "@/components/FillNavButton";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { RefreshNavButton } from "@/components/RefreshNavButton";

import { subtypeDisplay } from "@/lib/investment-config";

function fl(subtype: string | null | undefined, source: string | null | undefined) {
  return subtypeDisplay(subtype, source);
}
function fmtDate(v: any) { if (!v) return ""; const s = typeof v === "string" ? v : v?.toISOString?.(); return s ? s.slice(0, 10) : ""; }

type Props = any;

export function FundShell(props: Props) {
  const {
    view, initialFundCode, positions, clearedPositions, allEntries,
    totalMarketValue, totalCost, totalHistoricalProfit,
    confirmDaysMap, feeRateMap, initialShowCleared, baseQuery,
    accountId, selectedAccount, selectedAccountLabel, accountOptions,
    cashAccounts, investmentAccounts, createAction, editAction,
    fillNavAction, regularInvestFormAction, lastUsedCashAccount, isRedUp,
  } = props;

  const [fundCode, setFundCode] = useState(initialFundCode);
  const [showCleared, setShowCleared] = useState(initialShowCleared);
  const [fundPage, setFundPage] = useState(1);
  const [fundPageSize, setFundPageSize] = useState(20);
  const [sortKey, setSortKey] = useState("marketValue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const upCls = isRedUp ? "text-red-600" : "text-emerald-700";
  const downCls = isRedUp ? "text-emerald-700" : "text-red-600";
  const pnl = (n: number) => n > 0 ? upCls : n < 0 ? downCls : "text-slate-600";

  function exportCSV() {
    const rows = allEntries || [];
    const header = ["申请日期", "确认日期", "资金账户", "基金代码", "基金名称", "净值", "份额", "交易类型", "金额", "收益", "状态"];
    const lines: string[] = [header.join(",")];

    for (const e of rows) {
      const nav = e.fundNav != null ? toNumber(e.fundNav) : "";
      const units = e.fundUnits != null ? toNumber(e.fundUnits) : "";
      const amt = toNumber(e.amount);
      const profit = e.realizedProfit != null ? toNumber(e.realizedProfit) : "";
      const subtype = fl(e.fundSubtype, e.source).label;
      const isR = e.fundSubtype === "redeem" || e.fundSubtype === "switch_out";
      const cashAcc = accountOptions.find((a: any) => a.id === (isR ? e.toAccountId : e.accountId));
      const cashAccName = cashAcc?.label?.split("·").pop() ?? "-";
      const confirmDate = e.fundSubtype === "dividend_cash" ? fmtDate(e.fundArrivalDate)
        : (e.fundUnits != null && Number(e.fundUnits) > 0) ? fmtDate(e.fundConfirmDate) : "待确认";
      const status = e.fundSubtype === "buy_failed" ? "暂停申购" : (e.fundUnits == null || Number(e.fundUnits) === 0) ? "待确认" : "确认";

      lines.push([
        fmtDate(e.date),
        confirmDate || "",
        cashAccName,
        e.fundCode || "",
        e.fundName || "",
        String(nav),
        String(units),
        subtype,
        Math.abs(amt).toFixed(2),
        typeof profit === "number" ? profit.toFixed(2) : "",
        status,
      ].join(","));
    }

    const bom = "﻿";
    const blob = new Blob([bom + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `交易明细_${fundCode || "all"}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sortedPositions = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...positions].sort((a: any, b: any) => {
      let v = 0;
      switch (sortKey) {
        case "fundCode": v = a.fundCode.localeCompare(b.fundCode); break;
        case "cost": v = a.cost - b.cost; break;
        case "floatingPnL": v = a.floatingPnL - b.floatingPnL; break;
        case "floatingPnLRate": v = a.floatingPnLRate - b.floatingPnLRate; break;
        case "historicalProfit": v = a.historicalProfit - b.historicalProfit; break;
        case "marketValue": default: v = a.marketValue - b.marketValue; break;
      }
      return v * dir;
    });
  }, [positions, sortKey, sortDir]);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortHead({ sk, label, cls }: { sk: string; label: string; cls: string }) {
    const active = sortKey === sk;
    return (
      <th className={cls} onClick={() => toggleSort(sk)} style={{ cursor: "pointer" }}>
        <span className={`inline-flex items-center gap-0.5 hover:text-blue-700 ${active ? "text-blue-700" : ""}`}>
          {label} {active ? <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span> : <span className="text-[10px] text-slate-300">↕</span>}
        </span>
      </th>
    );
  }

  function switchFund(code: string) {
    setFundCode(code);
    setFundPage(1);
    const q = new URLSearchParams(baseQuery);
    q.set("view", view); q.set("fundCode", code);
    if (showCleared) q.set("showCleared", "1");
    window.history.replaceState(null, "", `/?${q.toString()}`);
  }
  function toggleCleared(on: boolean) {
    setShowCleared(on);
    const q = new URLSearchParams(baseQuery); q.set("view", view);
    if (on) { q.set("showCleared", "1"); q.delete("fundCode"); }
    else { q.delete("showCleared"); q.delete("fundCode"); }
    window.history.replaceState(null, "", `/?${q.toString()}`);
    setFundCode(on && clearedPositions.length > 0 ? clearedPositions[0].fundCode : positions.length > 0 ? positions[0].fundCode : "");
    setFundPage(1);
  }

  const filtered = useMemo(() => fundCode ? allEntries.filter((e: any) => e.fundCode === fundCode) : allEntries, [allEntries, fundCode]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / fundPageSize));
  const safePage = Math.min(fundPage, totalPages);
  const paged = filtered.slice((safePage - 1) * fundPageSize, safePage * fundPageSize);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 p-4 bg-slate-50">
      <div className="flex-1 min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-slate-800">{showCleared ? "清仓基金" : "基金持仓"}</div>
            <div className="flex items-center gap-0.5">
              <button onClick={() => toggleCleared(false)} className={`h-6 px-2 rounded text-xs ${!showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>活跃持仓</button>
              <button onClick={() => toggleCleared(true)} className={`h-6 px-2 rounded text-xs ${showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>清仓基金</button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {!showCleared && (<>
              <RegularInvestForm accountId={accountId} accountLabel={selectedAccountLabel} cashAccounts={cashAccounts} action={regularInvestFormAction} lastUsedCashAccountId={lastUsedCashAccount?.accountId} showTriggerButton={true} />
              {positions.length > 0 && <RefreshNavButton accountId={accountId} symbols={positions.map((p: any) => p.fundCode).filter(Boolean)} />}
            </>)}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {!showCleared ? (
            <table className="min-w-[800px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <SortHead sk="fundCode" label="基金" cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" />
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">份额</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">均价</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">净值</th>
                  <SortHead sk="cost" label="持仓成本" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <SortHead sk="marketValue" label="市值" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">未确认金额</th>
                  <SortHead sk="floatingPnL" label="浮盈" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <SortHead sk="floatingPnLRate" label="浮盈率" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <SortHead sk="historicalProfit" label="历史收益" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                </tr>
              </thead>
              <tbody className="text-sm">
                {sortedPositions.length === 0 ? (
                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={10}>暂无持仓数据</td></tr>
                ) : sortedPositions.map((p: any) => {
                  const active = p.fundCode === fundCode;
                  return (
                    <tr key={p.fundCode} onClick={() => switchFund(p.fundCode)} className={`hover:bg-slate-50 cursor-pointer ${active ? "bg-blue-50" : ""}`}>
                      <td className="px-4 py-2 border-b border-slate-100"><span className={`text-xs font-medium ${active ? "text-blue-700" : "text-slate-800"}`}>{p.name}{p.fundCode !== p.name && <span className="ml-1 text-slate-400">{p.fundCode}</span>}</span></td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.units.toFixed(2)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.avgCost.toFixed(4)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.nav != null ? p.nav.toFixed(4) : "-"}{p.navDate ? <span className="ml-0.5 text-slate-400">({p.navDate})</span> : null}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(p.cost)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(p.marketValue)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.pendingCost > 0 ? <span className="text-amber-600 font-medium">{formatMoney(p.pendingCost)}</span> : <span className="text-slate-300">-</span>}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(p.floatingPnL)}`}>{formatMoney(p.floatingPnL)}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(p.floatingPnLRate)}`}>{(p.floatingPnLRate * 100).toFixed(2)}%</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(p.historicalProfit)}`}>{formatMoney(p.historicalProfit)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {positions.length > 0 && (
                <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">
                  <tr>
                    <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={4}>汇总</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalCost)}</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalMarketValue)}</td>
                    <td className="px-3 py-2 border-t border-slate-200"></td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalMarketValue - totalCost)}`}>{formatMoney(totalMarketValue - totalCost)}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalMarketValue - totalCost)}`}>{totalCost !== 0 ? `${(((totalMarketValue - totalCost) / totalCost) * 100).toFixed(2)}%` : "-"}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalHistoricalProfit)}`}>{formatMoney(totalHistoricalProfit)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            <table className="min-w-[600px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">基金</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">名称</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">初次购买</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">清仓时间</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">申购金额</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">赎回金额</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">清仓收益</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">收益率</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {clearedPositions.length === 0 ? (
                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={8}>暂无清仓基金</td></tr>
                ) : clearedPositions.map((c: any) => {
                  const active = c.fundCode === fundCode;
                  return (
                    <tr key={c.fundCode} onClick={() => switchFund(c.fundCode)} className={`hover:bg-slate-50 cursor-pointer ${active ? "bg-blue-50" : ""}`}>
                      <td className="px-4 py-2 border-b border-slate-100"><span className={`text-xs font-medium ${active ? "text-blue-700" : "text-slate-800"}`}>{c.fundCode}</span></td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs">{c.name}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">{c.firstBuyDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">{c.clearedDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(c.totalBuyAmount)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(c.totalRedeemAmount)}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(c.historicalProfit)}`}>{formatMoney(c.historicalProfit)}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(c.returnRate)}`}>{(c.returnRate * 100).toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
              {clearedPositions.length > 0 && (
                <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">
                  <tr>
                    <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={6}>汇总</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalHistoricalProfit)}`}>{formatMoney(totalHistoricalProfit)}</td>
                    <td className="px-3 py-2 border-t border-slate-200"></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>

      {/* 交易明细 */}
      <div className="flex-1 min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
        <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold text-slate-800">交易明细{fundCode && <span className="ml-2 text-xs text-slate-500 font-normal">{fundCode}</span>}</div>
          <div className="flex items-center gap-1 text-xs">
            <button onClick={exportCSV} className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导出 CSV">
              <Download className="w-3 h-3" />导出
            </button>
            <span className="text-slate-300">|</span>
            {[10, 20, 40].map((n) => (
              <button key={n} onClick={() => { setFundPageSize(n); setFundPage(1); }} className={`h-6 px-1.5 rounded border ${fundPageSize === n ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>{n}</button>
            ))}
            <span className="text-slate-300">|</span>
            {safePage > 1 && (<>
              <button onClick={() => setFundPage(1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsLeft className="h-3 w-3"/></button>
              <button onClick={() => setFundPage(safePage - 1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronLeft className="h-3 w-3"/></button>
            </>)}
            <span className="text-slate-500 px-0.5">{safePage}/{totalPages}</span>
            {safePage < totalPages && (<>
              <button onClick={() => setFundPage(safePage + 1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronRight className="h-3 w-3"/></button>
              <button onClick={() => setFundPage(totalPages)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsRight className="h-3 w-3"/></button>
            </>)}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="min-w-[780px] w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-white">
              <tr>
                <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">申请日期</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">确认日期</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">资金账户</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">基金</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">净值</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">份额</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">交易类型</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">金额</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">收益</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">状态</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">操作</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {paged.length > 0 ? paged.map((e: any) => {
                const amount = toNumber(e.amount);
                const nav = e.fundNav != null ? toNumber(e.fundNav) : null;
                const units = e.fundUnits != null ? toNumber(e.fundUnits) : null;
                const info = fl(e.fundSubtype, e.source);
                return (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-4 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-600">{fmtDate(e.date)}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
                      {e.fundSubtype === "dividend_cash" ? (fmtDate(e.fundArrivalDate) || "-")
                        : e.fundSubtype === "buy_failed" ? (fmtDate(e.fundConfirmDate) || "-")
                        : units != null && units > 0 ? (fmtDate(e.fundConfirmDate) || "-")
                        : <span className="text-amber-500">待确认</span>}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">
                      {(() => {
                        const isR = e.fundSubtype === "redeem" || e.fundSubtype === "switch_out" || (e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund");
                        const ca = isR ? e.toAccountId : e.accountId;
                        if (!ca || ca === (isR ? e.accountId : e.toAccountId)) return <span className="text-slate-300">-</span>;
                        const o = accountOptions.find((a: any) => a.id === ca);
                        return o?.label?.split("·").pop() ?? o?.label ?? "-";
                      })()}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-700">{e.fundName || e.fundCode || "-"}{e.fundCode && e.fundName && e.fundName !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{nav != null ? nav.toFixed(4) : <span className="text-slate-400">-</span>}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{units != null ? units.toFixed(2) : <span className="text-slate-400">-</span>}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs"><span className={`px-1 py-0.5 rounded text-[10px] font-medium ${info.cls}`}>{info.label}</span></td>
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums text-slate-700">
                      {e.source === "dividend" || e.fundSubtype === "dividend_cash" ? <span className={`font-medium ${info.textCls ?? "text-emerald-600"}`}>+{formatMoney(Math.abs(amount))}</span> : formatMoney(Math.abs(amount))}
                    </td>
                    <td className={`px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(toNumber(e.realizedProfit))}`}>
                      {e.realizedProfit != null && (e.fundSubtype === "redeem" || e.fundSubtype === "switch_out") ? formatMoney(toNumber(e.realizedProfit)) : <span className="text-slate-300">-</span>}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs"><span className="text-slate-400">-</span></td>
                    <td className="px-2 py-1 border-b border-slate-100">
                      <div className="flex items-center justify-end gap-1">
                        {e.fundCode && e.fundSubtype === "buy" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} /> : null}
                        <InvestmentFormModal
                          mode="edit"
                          entry={{
                            id: e.id, transactionId: e.id,
                            date: fmtDate(e.date),
                            confirmDate: fmtDate(e.fundConfirmDate) || undefined,
                            amount: toNumber(e.amount), note: e.note ?? null, memo: e.note ?? null,
                            fundCode: e.fundCode ?? null, fundName: e.fundName ?? e.fundCode ?? null,
                            fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
                            fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
                            fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
                            fundProductType: e.fundProductType ?? null, fundSubtype: e.fundSubtype ?? null,
                            source: e.source ?? null,
                            accountId: e.accountId ?? null, toAccountId: e.toAccountId ?? null, toAccountName: e.toAccountName ?? null,
                            fundArrivalDate: fmtDate(e.fundArrivalDate) || null,
                            fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
                            realizedProfit: e.realizedProfit != null ? toNumber(e.realizedProfit) : null,
                          }}
                          accountId={selectedAccount?.id ?? ""}
                          accountProductType={selectedAccount?.investProductType ?? null}
                          defaults={{
                            confirmDays: confirmDaysMap[e.fundCode ?? ""] ?? selectedAccount?.defaultConfirmDays ?? undefined,
                            feeRate: feeRateMap[`${e.fundCode ?? ""}:${e.fundSubtype === "redeem" || e.fundSubtype === "switch_out" ? "redeem" : "buy"}`] ?? null,
                          }}
                          cashAccounts={cashAccounts}
                          investmentAccounts={investmentAccounts}
                          createAction={createAction}
                          editAction={editAction}
                        />
                      </div>
                    </td>
                  </tr>
                );
              }) : (<tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={11}>暂无交易记录</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
