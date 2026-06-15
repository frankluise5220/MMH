import { prisma } from "@/lib/db/prisma";
import { cookies } from "next/headers";
import { AccountKind, TransactionType } from "@prisma/client";
import { computeInvestBalances } from "@/lib/invest-balance";
import { toNumber } from "@/lib/date-utils";
import { Suspense } from "react";
import StatisticsCharts from "@/components/StatisticsCharts";
import { StatisticsFilterPanel } from "@/components/StatisticsFilterPanel";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

type MonthData = {
  month: string;
  income: number;
  expense: number;
  investPnL: number;
  netTotal: number;
  cumNet: number;
};

type CategoryItem = { name: string; value: number; pct: number };
type TagGroupData = { id: string; name: string; color: string; value: number; pct: number };

type PnLItem = {
  id: string;
  date: string;
  fundCode: string;
  fundName: string;
  subtype: string;
  amount: number;
  profit: number;
  profitRate: number;
};

export default async function StatisticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const ctx = await getHouseholdScope();
  const { householdId, hidFilter } = ctx;
  const cookieStore = await cookies();
  const colorScheme = cookieStore.get("colorScheme")?.value;
  const isRedUp = colorScheme === "red_up_green_down";

  const now = new Date();
  const thisYear = now.getFullYear();
  const selectedYear = typeof params?.year === "string" ? parseInt(params.year, 10) : thisYear;
  const year = Number.isFinite(selectedYear) && selectedYear >= 2000 && selectedYear <= 2100 ? selectedYear : thisYear;

  const selectedAccountIds = typeof params?.accounts === "string" && params.accounts.trim()
    ? params.accounts.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  const selectedTagIds = typeof params?.tags === "string" && params.tags.trim()
    ? params.tags.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  const allAccounts = await prisma.account.findMany({
    where: { ...hidFilter, isActive: true },
    select: { id: true, name: true, kind: true, Institution: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  const allTags = await prisma.tag.findMany({
    where: { ...hidFilter },
    select: { id: true, name: true, color: true },
    orderBy: { name: "asc" },
  });

  const nonInvestAccountIds = allAccounts.filter(a => a.kind !== AccountKind.investment).map(a => a.id);

  const accountFilter = selectedAccountIds
    ? { OR: [{ accountId: { in: selectedAccountIds } }, { toAccountId: { in: selectedAccountIds } }] }
    : {};

  // 获取当年全部交易记录（含 EntryTag）
  const allEntries = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...hidFilter,
      date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
      ...accountFilter,
    },
    select: {
      id: true,
      date: true,
      type: true,
      amount: true,
      fundSubtype: true,
      fundCode: true,
      fundName: true,
      realizedProfit: true,
      categoryName: true,
      accountId: true,
      toAccountId: true,
      EntryTag: { select: { tagId: true, Tag: { select: { id: true, name: true, color: true } } } },
    },
    orderBy: { date: "asc" },
  });

  // ── 标签筛选 ──
  const filteredEntries = selectedTagIds
    ? allEntries.filter(e => e.EntryTag.some(et => selectedTagIds.includes(et.tagId)))
    : allEntries;

  // ── 按月汇总 ──
  const monthMap = new Map<string, { income: number; expense: number; investPnL: number; investCost: number }>();
  const incomeByCat = new Map<string, number>();
  const expenseByCat = new Map<string, number>();
  const incomeByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
  const expenseByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
  const pnlItems: PnLItem[] = [];

  const scopeAccountIds = selectedAccountIds ?? nonInvestAccountIds;

  for (const e of filteredEntries) {
    const d = e.date;
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0, investCost: 0 });
    const row = monthMap.get(m)!;
    const amount = toNumber(e.amount);

    const isToSelf = e.toAccountId && scopeAccountIds.includes(e.toAccountId);
    const isFromSelf = e.accountId && scopeAccountIds.includes(e.accountId);

    if (e.type === TransactionType.income) {
      const effectiveAmount = isToSelf ? Math.abs(amount) : amount;
      row.income += effectiveAmount;
      if (e.categoryName) incomeByCat.set(e.categoryName, (incomeByCat.get(e.categoryName) ?? 0) + effectiveAmount);
      // 标签聚合
      for (const et of e.EntryTag) {
        const existing = incomeByTag.get(et.tagId);
        incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
      }
    } else if (e.type === TransactionType.expense) {
      const effectiveAmount = isFromSelf ? Math.abs(amount) : amount;
      row.expense += Math.abs(effectiveAmount);
      if (e.categoryName) expenseByCat.set(e.categoryName, (expenseByCat.get(e.categoryName) ?? 0) + Math.abs(effectiveAmount));
      // 标签聚合
      for (const et of e.EntryTag) {
        const existing = expenseByTag.get(et.tagId);
        expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(effectiveAmount) });
      }
    } else if (e.type === TransactionType.transfer) {
      if (isToSelf && !isFromSelf) {
        row.income += Math.abs(amount);
        if (e.categoryName) incomeByCat.set(e.categoryName, (incomeByCat.get(e.categoryName) ?? 0) + Math.abs(amount));
        for (const et of e.EntryTag) {
          const existing = incomeByTag.get(et.tagId);
          incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(amount) });
        }
      } else if (isFromSelf && !isToSelf) {
        row.expense += Math.abs(amount);
        if (e.categoryName) expenseByCat.set(e.categoryName, (expenseByCat.get(e.categoryName) ?? 0) + Math.abs(amount));
        for (const et of e.EntryTag) {
          const existing = expenseByTag.get(et.tagId);
          expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(amount) });
        }
      }
    } else if (e.type === TransactionType.investment) {
      if (e.fundSubtype === "dividend_cash") {
        const divAmt = Math.abs(amount);
        row.investPnL += divAmt;
        incomeByCat.set("投资分红", (incomeByCat.get("投资分红") ?? 0) + divAmt);
        pnlItems.push({
          id: e.id, date: d.toISOString().slice(0, 10), fundCode: e.fundCode ?? "", fundName: e.fundName ?? "",
          subtype: "dividend_cash", amount: divAmt, profit: divAmt, profitRate: 0,
        });
      }
      if (e.realizedProfit != null) {
        const rp = toNumber(e.realizedProfit);
        row.investPnL += rp;
        const costBase = Math.abs(amount);
        const rate = costBase > 0 ? rp / costBase : 0;
        pnlItems.push({
          id: e.id, date: d.toISOString().slice(0, 10), fundCode: e.fundCode ?? "", fundName: e.fundName ?? "",
          subtype: e.fundSubtype ?? "", amount: Math.abs(amount) + (rp > 0 ? rp : 0), profit: rp, profitRate: rate,
        });
      }
      if (e.fundSubtype === "buy" && amount < 0) {
        row.expense += Math.abs(amount);
        expenseByCat.set("投资买入", (expenseByCat.get("投资买入") ?? 0) + Math.abs(amount));
      }
    }
  }

  // ── 构建月份+累计数据 ──
  const monthData: MonthData[] = [];
  let cumNet = 0;
  for (let i = 1; i <= 12; i++) {
    const m = String(i).padStart(2, "0");
    const row = monthMap.get(m);
    if (!row) continue;
    const netTotal = row.income - row.expense + row.investPnL;
    cumNet += netTotal;
    monthData.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
  }

  // ── 分类饼图数据 ──
  const totalIncome = monthData.reduce((s, m) => s + m.income, 0);
  const totalExpense = monthData.reduce((s, m) => s + m.expense, 0);
  const incomeCats: CategoryItem[] = Array.from(incomeByCat.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, value]) => ({ name, value, pct: totalIncome > 0 ? (value / totalIncome) * 100 : 0 }));
  const expenseCats: CategoryItem[] = Array.from(expenseByCat.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, value]) => ({ name, value, pct: totalExpense > 0 ? (value / totalExpense) * 100 : 0 }));

  // ── 标签分组数据 ──
  const incomeTagGroups: TagGroupData[] = Array.from(incomeByTag.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map(t => ({ ...t, pct: totalIncome > 0 ? (t.value / totalIncome) * 100 : 0 }));
  const expenseTagGroups: TagGroupData[] = Array.from(expenseByTag.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map(t => ({ ...t, pct: totalExpense > 0 ? (t.value / totalExpense) * 100 : 0 }));

  // ── 投资浮盈 ──
  const investAccountIds = allAccounts.filter(a => a.kind === AccountKind.investment).map(a => a.id);
  const selectedInvestIds = selectedAccountIds
    ? selectedAccountIds.filter(id => investAccountIds.includes(id))
    : investAccountIds;
  const investBalances = selectedInvestIds.length > 0 ? await computeInvestBalances(ctx) : new Map();
  let totalFloatingPnL = 0;
  for (const [id, detail] of investBalances) {
    if (selectedInvestIds.includes(id)) totalFloatingPnL += detail.floatingPnL;
  }

  // ── P&L 列表按日期倒序 ──
  pnlItems.sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="page-header px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg page-title">资金统计</h1>
        <Suspense fallback={<div className="text-xs text-slate-400">加载筛选…</div>}>
          <StatisticsFilterPanel
            allAccounts={allAccounts}
            allTags={allTags}
            year={year}
          />
        </Suspense>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <StatisticsCharts
          monthData={monthData}
          incomeCats={incomeCats}
          expenseCats={expenseCats}
          incomeTagGroups={incomeTagGroups}
          expenseTagGroups={expenseTagGroups}
          pnlList={pnlItems}
          isRedUp={isRedUp}
        />
        {totalFloatingPnL !== 0 && (
          <div className="mt-3 text-xs text-slate-500 text-right">
            * 当前持仓未实现浮盈 {totalFloatingPnL >= 0 ? "+" : ""}{totalFloatingPnL.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}，未计入综合盈亏
          </div>
        )}
      </div>
    </div>
  );
}
