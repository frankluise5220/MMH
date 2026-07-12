import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { TransactionType } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { addStatisticCategoryBucket, buildStatisticCategoryItemsFromBuckets, createStatisticCategoryResolver, getIncomeExpenseStatisticAmount, getInvestmentStatisticItems } from "@/lib/transaction-statistics";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/statistics?year=YYYY&accounts=id1,id2&tags=id1,id2
 *
 * Yearly financial statistics for the authenticated household.
 * Mirrors the web `/statistics` page computation as a JSON API.
 *
 * Query params:
 *   year     – year to query (default: current year)
 *   accounts – comma-separated account IDs to filter (optional)
 *   tags     – comma-separated tag IDs to filter (optional)
 *
 * Expense totals preserve category offsets: a stored positive expense cash flow
 * is returned as a negative expense statistic instead of being made absolute.
 *
 * Response 200:
 * {
 *   ok: true,
 *   data: {
 *     year: number,
 *     totalIncome: number,
 *     totalExpense: number,
 *     totalInvestPnL: number,
 *     totalNet: number,
 *     monthData: [{ month, income, expense, investPnL, netTotal, cumNet }],
 *     incomeCategories: [{ id, name, value, pct }],
 *     expenseCategories: [{ id, name, value, pct }],
 *     incomeTagGroups: [{ id, name, color, value, pct }],
 *     expenseTagGroups: [{ id, name, color, value, pct }],
 *     pnlList: [{ id, date, fundCode, fundName, subtype, amount, profit, profitRate }]
 *   }
 * }
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter, householdId } = ctx;

    const url = req.nextUrl;
    const now = new Date();
    const thisYear = now.getFullYear();
    const rawYear = url.searchParams.get("year");
    const selectedYear = rawYear ? parseInt(rawYear, 10) : thisYear;
    const year = Number.isFinite(selectedYear) && selectedYear >= 2000 && selectedYear <= 2100 ? selectedYear : thisYear;

    const rawAccounts = url.searchParams.get("accounts");
    const selectedAccountIds = rawAccounts?.trim()
      ? rawAccounts.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const rawTags = url.searchParams.get("tags");
    const selectedTagIds = rawTags?.trim()
      ? rawTags.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);

    const [allAccounts, categories] = await Promise.all([
      prisma.account.findMany({
        where: { ...hidFilter, isActive: true },
        select: { id: true, name: true, kind: true },
        orderBy: { name: "asc" },
      }),
      prisma.category.findMany({
        where: { ...hidFilter, type: { in: ["income", "expense"] } },
        select: { id: true, name: true, type: true },
      }),
    ]);

    const nonInvestAccountIds = allAccounts.filter((a) => !isPureInvestmentAccount(a)).map(a => a.id);

    const accountFilter = selectedAccountIds
      ? { OR: [{ accountId: { in: selectedAccountIds } }, { toAccountId: { in: selectedAccountIds } }] }
      : {};

    // Fetch all entries for the year
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
        fundProductType: true,
        fundCode: true,
        fundName: true,
        realizedProfit: true,
        depositInterest: true,
        fundFee: true,
        categoryId: true,
        categoryName: true,
        accountId: true,
        toAccountId: true,
        EntryTag: { select: { tagId: true, Tag: { select: { id: true, name: true, color: true } } } },
      },
      orderBy: { date: "asc" },
    });

    // Tag filter
    const filteredEntries = selectedTagIds
      ? allEntries.filter(e => e.EntryTag.some(et => selectedTagIds.includes(et.tagId)))
      : allEntries;

    // Aggregation maps
    const monthMap = new Map<string, { income: number; expense: number; investPnL: number }>();
    const incomeByCat = new Map<string, { id: string | null; name: string; type: "income"; value: number }>();
    const expenseByCat = new Map<string, { id: string | null; name: string; type: "expense"; value: number }>();
    const incomeByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
    const expenseByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
    const pnlItems: { id: string; date: string; fundCode: string; fundName: string; subtype: string; amount: number; profit: number; profitRate: number }[] = [];

    const scopeAccountIds = selectedAccountIds ?? nonInvestAccountIds;
    const resolveCategory = createStatisticCategoryResolver(categories);

    for (const e of filteredEntries) {
      const d = e.date;
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
      const row = monthMap.get(m)!;
      const amount = toNumber(e.amount);

      const isToSelf = e.toAccountId && scopeAccountIds.includes(e.toAccountId);
      const isFromSelf = e.accountId && scopeAccountIds.includes(e.accountId);

      if (e.type === TransactionType.income) {
        const effectiveAmount = getIncomeExpenseStatisticAmount(e.type, amount);
        row.income += effectiveAmount;
        addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", categoryId: e.categoryId, categoryName: e.categoryName }), effectiveAmount);
        for (const et of e.EntryTag) {
          const existing = incomeByTag.get(et.tagId);
          incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
        }
      } else if (e.type === TransactionType.expense) {
        const effectiveAmount = getIncomeExpenseStatisticAmount(e.type, amount);
        row.expense += effectiveAmount;
        addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", categoryId: e.categoryId, categoryName: e.categoryName }), effectiveAmount);
        for (const et of e.EntryTag) {
          const existing = expenseByTag.get(et.tagId);
          expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
        }
      } else if (e.type === TransactionType.transfer) {
        if (isToSelf && !isFromSelf) {
          row.income += Math.abs(amount);
          addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", categoryId: e.categoryId, categoryName: e.categoryName }), Math.abs(amount));
          for (const et of e.EntryTag) {
            const existing = incomeByTag.get(et.tagId);
            incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(amount) });
          }
        } else if (isFromSelf && !isToSelf) {
          row.expense += Math.abs(amount);
          addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", categoryId: e.categoryId, categoryName: e.categoryName }), Math.abs(amount));
          for (const et of e.EntryTag) {
            const existing = expenseByTag.get(et.tagId);
            expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(amount) });
          }
        }
      } else if (e.type === TransactionType.investment) {
        for (const item of getInvestmentStatisticItems(e)) {
          const signedProfit = item.type === "income" ? item.amount : -item.amount;
          row.investPnL += signedProfit;
          if (item.type === "income") {
            addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
          } else {
            addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
          }
          const costBase = Math.abs(amount);
          const rate = costBase > 0 ? signedProfit / costBase : 0;
          pnlItems.push({
            id: e.id, date: d.toISOString().slice(0, 10), fundCode: e.fundCode ?? "", fundName: e.fundName ?? "",
            subtype: item.label, amount: item.amount, profit: signedProfit, profitRate: rate,
          });
        }
      }
    }

    // Build month data with cumulative net
    const monthData: { month: string; income: number; expense: number; investPnL: number; netTotal: number; cumNet: number }[] = [];
    let cumNet = 0;
    for (let i = 1; i <= 12; i++) {
      const m = String(i).padStart(2, "0");
      const row = monthMap.get(m);
      if (!row) continue;
      const netTotal = row.income - row.expense + row.investPnL;
      cumNet += netTotal;
      monthData.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
    }

    // Totals
    const totalIncome = monthData.reduce((s, m) => s + m.income, 0);
    const totalExpense = monthData.reduce((s, m) => s + m.expense, 0);
    const totalInvestPnL = monthData.reduce((s, m) => s + m.investPnL, 0);
    const totalNet = totalIncome - totalExpense + totalInvestPnL;

    // Category breakdown (top 8)
    const incomeCategories = buildStatisticCategoryItemsFromBuckets(incomeByCat, totalIncome);
    const expenseCategories = buildStatisticCategoryItemsFromBuckets(expenseByCat, totalExpense);

    // Tag breakdown (top 8)
    const incomeTagGroups = Array.from(incomeByTag.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map(t => ({ ...t, pct: totalIncome > 0 ? (t.value / totalIncome) * 100 : 0 }));

    const expenseTagGroups = Array.from(expenseByTag.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map(t => ({ ...t, pct: totalExpense > 0 ? (t.value / totalExpense) * 100 : 0 }));

    // PnL list sorted by date descending
    pnlItems.sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json({
      ok: true,
      data: {
        year,
        totalIncome,
        totalExpense,
        totalInvestPnL,
        totalNet,
        monthData,
        incomeCategories,
        expenseCategories,
        incomeTagGroups,
        expenseTagGroups,
        pnlList: pnlItems,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "统计数据读取失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
