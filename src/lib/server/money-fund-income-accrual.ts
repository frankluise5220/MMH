import { FundProductType, FundSubtype, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { fetchHistoricalNavList } from "@/lib/fund/navCache";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { runExclusive, utcDayKey } from "@/lib/server/interest-accrual";
import { logger } from "@/lib/logger";
import {
  ENTRY_ORIGIN_SCHEDULED_TASK,
  TRANSACTION_SOURCE_MONEY_INCOME,
} from "@/lib/transaction-semantics";

/**
 * 货币基金的收益结转（红利再投）。
 *
 * 业务口径（《货币市场基金监督管理办法》，全行业一致）：
 *   - 货基用摊余成本法，份额净值恒为 1.00 元，收益分配**只能**采用红利再投资；
 *   - 每日计算当日收益并结转为份额，没有现金分红这回事；
 *   - 披露「每万份基金净收益」，当日收益 = 持有份额 ÷ 10000 × 每万份收益；
 *   - 结转份额保留到 0.01 份，截尾部分按合同计入基金财产（所以不足一分不结转）；
 *   - 申购份额自 T+1 起享有收益，赎回份额自 T+1 起不再享有。
 *
 * 这里刻意**不产生任何现金流水**：结转只增份额，`cashAccountId` 为空、
 * `grossAmount` 为 0、`cashFlows` 为空，与份额对账（fund_units_reconcile）同形。
 */

export type MoneyIncomeAccrualResult = {
  status: "accrued" | "skipped";
  accounts?: number;
  days?: number;
  totalIncome?: number;
  entryIds?: string[];
  reason?: string;
};

/** 一次最多往前补多少天，防止长期没跑时把整段历史刷进来。 */
const DEFAULT_LOOKBACK_DAYS = 30;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function ymd(date: Date): string {
  return utcDayKey(date);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 当日收益（元）= 份额 ÷ 10000 × 每万份收益。 */
function dailyIncome(units: number, incomePer10k: number): number {
  const raw = (units * incomePer10k) / 10000;
  // 不足一分不结转：合同写的是「截尾部分计入基金财产」，四舍五入会凭空多给用户钱。
  return Math.floor(raw * 100) / 100;
}

/**
 * 把「每万份收益」从 lsjz 序列里挑出来。
 *
 * 东财对货基返回的 `DWJZ` 就是每万份收益（不是净值），这里按日期建索引；
 * 只取 (from, to] 区间，且必须落在区间的自然日内，缺哪天就少结哪天，绝不外推。
 */
function incomeByDay(
  rows: { date: string; nav: number }[],
  from: Date,
  to: Date,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.nav);
    if (!Number.isFinite(value) || value <= 0) continue;
    const day = row.date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const date = new Date(`${day}T00:00:00.000Z`);
    if (date <= from || date > to) continue;
    map.set(day, value);
  }
  return map;
}

type FundAccrualOutcome = {
  days: number;
  totalIncome: number;
  entryIds: string[];
};

async function accrueOneFund(params: {
  householdId: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  today: Date;
  lookbackDays: number;
}): Promise<FundAccrualOutcome> {
  const { householdId, accountId, fundCode, fundName, today, lookbackDays } = params;
  const yesterday = addDays(utcMidnight(today), -1);

  const [holding, lastAccrual, firstEntry] = await Promise.all([
    prisma.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode } },
      select: { units: true },
    }),
    prisma.fundTransaction.findFirst({
      where: {
        fundAccountId: accountId,
        fundCode,
        source: TRANSACTION_SOURCE_MONEY_INCOME,
        deletedAt: null,
      },
      orderBy: { applyDate: "desc" },
      select: { applyDate: true },
    }),
    prisma.fundTransaction.findFirst({
      where: { fundAccountId: accountId, fundCode, deletedAt: null },
      orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }],
      select: { applyDate: true, confirmDate: true },
    }),
  ]);

  const currentUnits = Number(holding?.units ?? 0);
  if (!(currentUnits > 0)) return { days: 0, totalIncome: 0, entryIds: [] };

  // 游标：上次结转到哪天的下一天；没有结转记录时从「建仓日」或回看窗口起点开始。
  // 货基历史收益在系统里没有记录，无法回补——更早的收益已经体现在用户对账后的真实份额里。
  const windowStart = addDays(utcMidnight(today), -lookbackDays);
  // 权益起算：申购份额自 T+1（确认日）起才享有收益，建仓当天不结息；
  // 赎回不在这里处理——当天仍持有，收益照结。
  const cursorStart = lastAccrual
    ? addDays(utcMidnight(lastAccrual.applyDate), 1)
    : firstEntry
      ? firstEntry.confirmDate && firstEntry.confirmDate > firstEntry.applyDate
        ? utcMidnight(firstEntry.confirmDate)
        : addDays(utcMidnight(firstEntry.applyDate), 1)
      : null;
  if (!cursorStart) return { days: 0, totalIncome: 0, entryIds: [] };

  const from = cursorStart > windowStart ? cursorStart : windowStart;
  if (from > yesterday) return { days: 0, totalIncome: 0, entryIds: [] };

  const rows = await fetchHistoricalNavList(fundCode, ymd(from), ymd(yesterday));
  const byDay = incomeByDay(rows, addDays(from, -1), yesterday);
  if (byDay.size === 0) return { days: 0, totalIncome: 0, entryIds: [] };

  const days = Array.from(byDay.keys()).sort();
  const entryIds: string[] = [];
  let totalIncome = 0;
  let units = currentUnits;

  for (const day of days) {
    const per10k = byDay.get(day)!;
    const income = dailyIncome(units, per10k);
    if (income <= 0) continue;

    const applyDate = new Date(`${day}T00:00:00.000Z`);
    // 幂等：同一天同一条来源只允许一条，重复触发（开机自检 + 定时任务）不会翻倍加份额。
    const exists = await prisma.fundTransaction.findFirst({
      where: {
        fundAccountId: accountId,
        fundCode,
        applyDate,
        source: TRANSACTION_SOURCE_MONEY_INCOME,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (exists) {
      units += income;
      continue;
    }

    const created = await prisma.fundTransaction.create({
      data: {
        householdId,
        fundAccountId: accountId,
        cashAccountId: null,
        fundCode,
        fundName,
        fundProductType: FundProductType.money,
        fundSubtype: FundSubtype.buy,
        source: TRANSACTION_SOURCE_MONEY_INCOME,
        entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
        applyDate,
        confirmDate: applyDate,
        arrivalDate: null,
        grossAmount: new Prisma.Decimal(0),
        refundAmount: new Prisma.Decimal(0),
        arrivalAmount: null,
        fee: null,
        // 净值恒为 1：份额增量在数值上等于收益金额。
        nav: new Prisma.Decimal(1),
        units: new Prisma.Decimal(income),
        realizedProfit: null,
        note: null,
      },
      select: { id: true },
    });

    entryIds.push(created.id);
    totalIncome = round2(totalIncome + income);
    units += income;
  }

  if (entryIds.length > 0) {
    await recalcFundPositions(accountId, [fundCode]);
  }

  return { days: entryIds.length, totalIncome, entryIds };
}

/**
 * 结转所有货基持仓的收益（或只结某一个账户）。
 *
 * 触发时机由调用方决定（定时任务 / 开机自检 / 手工），本函数只管「把还差的日子补上」。
 */
export async function accrueMoneyFundIncome(params: {
  householdId: string;
  fundAccountId?: string;
  lookbackDays?: number;
  today?: Date;
}): Promise<MoneyIncomeAccrualResult> {
  const { householdId, fundAccountId } = params;
  const today = params.today ?? new Date();
  const lookbackDays = params.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  return runExclusive(
    `money-fund-income:${householdId}:${fundAccountId ?? "*"}`,
    async () => {
      const accounts = await prisma.account.findMany({
        where: {
          householdId,
          kind: "investment",
          investProductType: FundProductType.money,
          ...(fundAccountId ? { id: fundAccountId } : {}),
        },
        select: { id: true },
      });
      if (accounts.length === 0) return { status: "skipped" as const, reason: "no money fund account" };

      const entryIds: string[] = [];
      let days = 0;
      let totalIncome = 0;

      for (const account of accounts) {
        const holdings = await prisma.fundHolding.findMany({
          where: { accountId: account.id, units: { gt: 0 } },
          select: { fundCode: true, fundName: true },
        });

        for (const holding of holdings) {
          try {
            const outcome = await accrueOneFund({
              householdId,
              accountId: account.id,
              fundCode: holding.fundCode,
              fundName: holding.fundName,
              today,
              lookbackDays,
            });
            entryIds.push(...outcome.entryIds);
            days += outcome.days;
            totalIncome = round2(totalIncome + outcome.totalIncome);
          } catch (error) {
            // 单只基金取数失败不能拖垮整个账户：下一轮补跑即可（游标没推进）。
            logger.warn(
              `Money fund income accrual failed: ${holding.fundCode} (${account.id})`,
              "money-fund-income",
              error,
            );
          }
        }

        if (holdings.length > 0) {
          await recalcAndSaveAccountBalance(account.id);
        }
      }

      if (entryIds.length === 0) {
        return { status: "skipped" as const, accounts: accounts.length, reason: "nothing to accrue" };
      }
      return {
        status: "accrued" as const,
        accounts: accounts.length,
        days,
        totalIncome,
        entryIds,
      };
    },
    () => ({ status: "skipped" as const, reason: "busy" }),
  );
}
