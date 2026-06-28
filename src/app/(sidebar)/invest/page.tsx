import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { computeInvestBalances } from "@/lib/invest-balance";
import { InvestHeaderSync } from "@/components/InvestHeaderSync";
import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { toNumber } from "@/lib/date-utils";
import { formatMoneyYuan } from "@/lib/format";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { cookies } from "next/headers";
import Link from "next/link";
import StatisticsCharts from "@/components/StatisticsCharts";
import { DailyPnlCalendar } from "@/components/DailyPnlCalendar";

export const dynamic = "force-dynamic";

const fmt = formatMoneyYuan;

const fmtRate = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;

const investProductTypeLabel = (type: string | null) => {
  if (type === "fund") return "开放式基金";
  if (type === "money") return "货币基金";
  return "投资账户";
};

  export default async function InvestPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const tab = typeof params?.tab === "string" ? params.tab : "overview";
  const filter = typeof params?.filter === "string" ? params.filter : "all"; // holding | cleared | all
  const pageParam = typeof params?.page === "string" ? parseInt(params.page, 10) : 1;
  const pageSizeParam = typeof params?.pageSize === "string" ? parseInt(params.pageSize, 10) : 10;
  const pageSize = [10, 20, 40].includes(pageSizeParam) ? pageSizeParam : 10;
  const cookieStore = await cookies();
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const isRedUp = colorScheme === "red_up_green_down";
  const pnlClass = (n: number) =>
    n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;

  const accounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, isActive: true, ...hidFilter },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ name: "asc" }],
  });

  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-w-0">
        <header className="page-header">
          <div className="h-12 flex items-center px-4">
            <div className="text-sm page-title">投资一览</div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
          暂无投资账户
        </div>
      </div>
    );
  }

  const accountIds = accounts.map((a) => a.id);

  const [allEntries, investBalByAccountId] = await Promise.all([
    prisma.txRecord.findMany({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          { toAccountId: { in: accountIds } },
        ],
        deletedAt: null,
        type: TransactionType.investment,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      take: 10000,
    }),
    computeInvestBalances(ctx),
  ]);

  // ── 收益统计：按月汇总数据 ──
  const earningsData = (() => {
    type MonthRow = { income: number; expense: number; investPnL: number };
    const monthMap = new Map<string, MonthRow>();
    const incomeByCat = new Map<string, number>();
    const expenseByCat = new Map<string, number>();
    const profitItems: Array<{ id: string; date: string; fundCode: string; fundName: string; subtype: string; amount: number; profit: number; profitRate: number }> = [];

    for (const e of allEntries) {
      const d = e.date;
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
      const row = monthMap.get(m)!;
      const amt = toNumber(e.amount);
      const fee = toNumber(e.fundFee);
      const subtype = e.fundSubtype;

      if (subtype === "dividend_cash") {
        row.investPnL += Math.abs(amt);
        incomeByCat.set("投资分红", (incomeByCat.get("投资分红") ?? 0) + Math.abs(amt));
        profitItems.push({ id: e.id, date: d.toISOString().slice(0,10), fundCode: e.fundCode??"", fundName: e.fundName??"", subtype: "dividend_cash", amount: Math.abs(amt), profit: Math.abs(amt), profitRate: 0 });
      }
      if (e.realizedProfit != null) {
        const rp = toNumber(e.realizedProfit);
        row.investPnL += rp;
        const costBase = Math.abs(amt);
        profitItems.push({ id: e.id, date: d.toISOString().slice(0,10), fundCode: e.fundCode??"", fundName: e.fundName??"", subtype: subtype??"", amount: costBase + (rp>0?rp:0), profit: rp, profitRate: costBase > 0 ? rp / costBase : 0 });
      }
      if (subtype === "buy" && amt < 0) {
        row.expense += Math.abs(amt) - fee;
        expenseByCat.set("投资买入", (expenseByCat.get("投资买入") ?? 0) + Math.abs(amt) - fee);
      }
    }

    const monthData: Array<{ month: string; income: number; expense: number; investPnL: number; netTotal: number; cumNet: number }> = [];
    let cumNet = 0;
    for (let i = 1; i <= 12; i++) {
      const m = String(i).padStart(2, "0");
      const row = monthMap.get(m);
      if (!row) continue;
      const netTotal = row.income - row.expense + row.investPnL;
      cumNet += netTotal;
      monthData.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
    }

    const totalInc = monthData.reduce((s,m)=>s+m.income,0);
    const totalExp = monthData.reduce((s,m)=>s+m.expense,0);
    const incCats = Array.from(incomeByCat.entries()).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n,v])=>({name:n,value:v,pct:totalInc>0?(v/totalInc)*100:0}));
    const expCats = Array.from(expenseByCat.entries()).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n,v])=>({name:n,value:v,pct:totalExp>0?(v/totalExp)*100:0}));
    profitItems.sort((a,b) => b.date.localeCompare(a.date));

    return { monthData, incCats, expCats, profitItems };
  })();

  type AccountRow = {
    id: string;
    label: string;
    groupName: string;
    productTypeLabel: string;
    balance: number;
    marketValue: number;
    totalCost: number;
    floatingPnL: number;
    floatingPnLRate: number;
    totalBuy: number;
    totalSell: number;
    totalDividend: number;
    totalFee: number;
    realizedPnL: number;
    totalReturn: number;
    totalReturnRate: number;
    txCount: number;
    buyCount: number;
    sellCount: number;
  };

  const accountRows: AccountRow[] = accounts.map((a) => {
    const entries = allEntries.filter((e) => e.accountId === a.id || e.toAccountId === a.id);
    const investDetail = investBalByAccountId.get(a.id);

    let totalBuy = 0;
    let totalSell = 0;
    let totalDividend = 0;
    let totalFee = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const e of entries) {
      const amt = toNumber(e.amount);
      const fee = toNumber(e.fundFee);
      const subtype = e.fundSubtype;
      const isDividend = e.source === "dividend" || subtype === "dividend_cash";
      totalFee += fee;
      if (amt < 0) {
        totalBuy += Math.abs(amt) - fee;
        buyCount++;
      } else if (isDividend) {
        totalDividend += amt;
      } else if (amt > 0) {
        totalSell += amt - fee;
        sellCount++;
      }
    }

    const marketValue = investDetail?.marketValue ?? 0;
    const totalCost = investDetail?.totalCost ?? 0;
    const floatingPnL = investDetail?.floatingPnL ?? 0;
    const floatingPnLRate = totalCost > 0 ? floatingPnL / totalCost : 0;
    const realizedPnL = totalSell + totalDividend - (totalBuy - totalCost);
    const totalReturn = floatingPnL + realizedPnL;
    const totalReturnRate = totalBuy > 0 ? totalReturn / totalBuy : 0;

    const display = buildAccountDisplayOption({
      id: a.id,
      name: a.name,
      kind: a.kind,
      numberMasked: a.numberMasked,
      groupId: a.groupId,
      investProductType: a.investProductType,
      Institution: a.Institution,
      AccountGroup: a.AccountGroup,
    }, creditCardLabelTemplate);
    const label = display.label;
    const groupName = a.AccountGroup?.name?.trim() || "未设置所有人";
    const productTypeLabel = investProductTypeLabel(a.investProductType);

    return {
      id: a.id,
      label,
      groupName,
      productTypeLabel,
      balance: toNumber(a.balance),
      marketValue,
      totalCost,
      floatingPnL,
      floatingPnLRate,
      totalBuy,
      totalSell,
      totalDividend,
      totalFee,
      realizedPnL,
      totalReturn,
      totalReturnRate,
      txCount: entries.length,
      buyCount,
      sellCount,
    };
  });

  // ── 筛选 + 分页 ──
  const filteredRows = accountRows.filter((r) => {
    if (filter === "holding") return r.marketValue > 0.01;
    if (filter === "cleared") return r.marketValue <= 0.01 && r.txCount > 0;
    return true;
  });
  const totalPageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(pageParam, totalPageCount);
  const pagedRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  const totalMarketValue = accountRows.reduce((s, r) => s + r.marketValue, 0);
  const totalCostAll = accountRows.reduce((s, r) => s + r.totalCost, 0);
  const totalFloatingPnL = accountRows.reduce((s, r) => s + r.floatingPnL, 0);
  const totalRealizedPnL = accountRows.reduce((s, r) => s + r.realizedPnL, 0);
  const totalFeeAll = accountRows.reduce((s, r) => s + r.totalFee, 0);
  const totalReturn = totalFloatingPnL + totalRealizedPnL;
  const totalBuyAll = accountRows.reduce((s, r) => s + r.totalBuy, 0);
  const totalReturnRate = totalBuyAll > 0 ? totalReturn / totalBuyAll : 0;
  const totalFloatingRate = totalCostAll > 0 ? totalFloatingPnL / totalCostAll : 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <header className="page-header">
        <div className="h-12 flex items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <div className="text-sm page-title">投资</div>
            <div className="flex items-center gap-1">
              <Link href="/invest?tab=overview" className={`h-7 px-3 rounded text-xs flex items-center ${tab === "overview" ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>投资一览</Link>
              <Link href="/invest?tab=stats" className={`h-7 px-3 rounded text-xs flex items-center ${tab === "stats" ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>收益统计</Link>
            </div>
          </div>
          <InvestHeaderSync />
        </div>
      </header>

      {tab === "stats" ? (
        <div className="flex-1 overflow-auto p-4">
          <StatisticsCharts
            monthData={earningsData.monthData}
            incomeCats={earningsData.incCats}
            expenseCats={earningsData.expCats}
            incomeTagGroups={[]}
            expenseTagGroups={[]}
            pnlList={earningsData.profitItems}
            isRedUp={isRedUp}
          />
        </div>
      ) : (
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <DailyPnlCalendar accountId={accounts[0]?.id ?? ""} />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "总市值", value: fmt(totalMarketValue), sub: null, color: pnlClass(totalMarketValue) },
            { label: "持仓成本", value: fmt(totalCostAll), sub: null, color: "text-slate-600" },
            { label: "浮动盈亏", value: fmt(totalFloatingPnL), sub: fmtRate(totalFloatingRate), color: pnlClass(totalFloatingPnL) },
            { label: "历史收益", value: fmt(totalRealizedPnL), sub: null, color: pnlClass(totalRealizedPnL) },
            { label: "总收益", value: fmt(totalReturn), sub: fmtRate(totalReturnRate), color: pnlClass(totalReturn) },
            { label: "累计买入", value: fmt(totalBuyAll), sub: null, color: "text-slate-600" },
            { label: "累计手续费", value: fmt(totalFeeAll), sub: null, color: "text-slate-600" },
          ].map((item) => (
            <div key={item.label} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div className="text-xs text-slate-500 mb-1">{item.label}</div>
              <div className={`text-sm font-semibold tabular-nums ${item.color}`}>{item.value}</div>
              {item.sub && <div className={`text-xs tabular-nums mt-0.5 ${item.color}`}>{item.sub}</div>}
            </div>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-sm font-semibold text-slate-800">账户汇总</div>
              <div className="flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5">
                {[
                  { key: "all", label: "全部" },
                  { key: "holding", label: "持仓" },
                  { key: "cleared", label: "清仓" },
                ].map((f) => {
                  const q = new URLSearchParams();
                  q.set("tab", "overview");
                  if (f.key !== "all") q.set("filter", f.key);
                  return <Link key={f.key} href={`/invest?${q.toString()}`} className={`h-7 px-4 rounded-md text-xs flex items-center transition-all duration-200 ${filter === f.key ? "bg-white text-blue-700 font-semibold shadow-sm border border-blue-200" : "text-slate-600 hover:text-slate-800 hover:bg-white/60"}`}>{f.label}</Link>;
                })}
              </div>
            </div>
            <span className="text-xs text-slate-400">{filteredRows.length} 个账户</span>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[960px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200 min-w-[220px]">账户</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">持仓成本</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">市值</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">浮动盈亏</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">浮盈率</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">历史收益</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">累计买入</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">累计手续费</th>
                  <th className="text-center text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">交易</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">操作</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {pagedRows.length === 0 ? (
                  <tr><td className="px-4 py-6 text-xs text-slate-500 text-center" colSpan={10}>暂无数据</td></tr>
                ) : pagedRows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 border-b border-slate-100">
                      <div className="max-w-[240px]">
                        <div className="truncate text-xs font-semibold text-slate-800">{r.label}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{r.groupName}</span>
                          <span>{r.productTypeLabel}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{r.totalCost > 0 ? fmt(r.totalCost) : <span className="text-slate-300">-</span>}</td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnlClass(r.marketValue)}`}>{r.marketValue > 0 ? fmt(r.marketValue) : <span className="text-slate-300">-</span>}</td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnlClass(r.floatingPnL)}`}>{r.marketValue > 0 ? fmt(r.floatingPnL) : <span className="text-slate-300">-</span>}</td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnlClass(r.floatingPnLRate)}`}>{r.marketValue > 0 ? fmtRate(r.floatingPnLRate) : <span className="text-slate-300">-</span>}</td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnlClass(r.realizedPnL)}`}>{r.realizedPnL !== 0 ? fmt(r.realizedPnL) : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{r.totalBuy > 0 ? fmt(r.totalBuy) : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-500">{r.totalFee > 0 ? fmt(r.totalFee) : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-center text-xs text-slate-500">{r.txCount > 0 ? r.txCount : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 border-b border-slate-100">
                      <a href={`/?accountId=${r.id}&view=${r.marketValue > 0 ? "invest" : "investfund"}`} className="text-xs text-blue-600 hover:text-blue-800">明细</a>
                    </td>
                  </tr>
                ))}
              </tbody>
              {pagedRows.length > 0 && (
                <tfoot className="sticky bottom-0 bg-slate-50">
                  <tr>
                    <td className="px-4 py-2 border-t border-slate-200 text-xs font-semibold text-slate-700">合计</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-600">{fmt(totalCostAll)}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold ${pnlClass(totalMarketValue)}`}>{fmt(totalMarketValue)}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold ${pnlClass(totalFloatingPnL)}`}>{fmt(totalFloatingPnL)}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnlClass(totalFloatingRate)}`}>{fmtRate(totalFloatingRate)}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold ${pnlClass(totalRealizedPnL)}`}>{fmt(totalRealizedPnL)}</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-600">{fmt(totalBuyAll)}</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-500">{fmt(totalFeeAll)}</td>
                    <td className="px-3 py-2 border-t border-slate-200"></td>
                    <td className="px-3 py-2 border-t border-slate-200"></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {/* 分页 */}
          {totalPageCount > 1 && (
            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-1 text-xs shrink-0">
              {[10, 20, 40].map((n) => {
                const q = new URLSearchParams();
                q.set("tab", "overview");
                if (filter !== "all") q.set("filter", filter);
                q.set("pageSize", String(n));
                q.set("page", "1");
                return <Link key={n} href={`/invest?${q.toString()}`} className={`h-6 px-1.5 rounded border flex items-center ${pageSize === n ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>{n}</Link>;
              })}
              <span className="text-slate-300">|</span>
              {page > 1 && (
                <>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", "1"); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 flex items-center justify-center">&laquo;</Link>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", String(page - 1)); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 flex items-center justify-center">&lsaquo;</Link>
                </>
              )}
              <span className="text-slate-500">{page}/{totalPageCount}</span>
              {page < totalPageCount && (
                <>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", String(page + 1)); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 flex items-center justify-center">&rsaquo;</Link>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", String(totalPageCount)); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 flex items-center justify-center">&raquo;</Link>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
