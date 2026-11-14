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
 * 业务口径（《货币市场基金监督管理办法》第 10、11 条 + 各基金合同）：
 *   - 货基按面值报价、摊余成本法核算，份额净值恒为 1.00 元，收益分配**只能**是红利再投；
 *   - 每日计算当日收益并结转为份额，没有现金分红这回事；
 *   - 披露「每万份基金净收益」，当日收益 = 持有份额 ÷ 10000 × 每万份收益；
 *   - 收益为正时份额增加，**为负时份额相应减少**，为零则不变；结转保留到 0.01 份，
 *     截尾部分按合同计入基金财产（所以不足一分不结转，正负都不动）；
 *   - 申购份额自确认日（T+1）起享有收益；赎回份额自申请日次日起不再享有收益。
 *
 * 这里刻意**不产生任何现金流水**：结转只增/减份额，`cashAccountId` 为空、
 * `grossAmount` 为 0、`cashFlows` 为空，与份额对账（fund_units_reconcile）同形。
 *
 * 历史回补：东财 lsjz 能翻页取到成立以来的每日每万份收益，所以老账户不需要人工对账补
 * 历史，直接从建仓（确认）日往前补即可——只是要按批滚动（见 DAYS_PER_BATCH），
 * 每日份额由流水重放得出（赎回按次日生效、申购按确认日生效），不能用当前份额顶替。
 */

export type MoneyIncomeAccrualResult = {
  status: "accrued" | "skipped";
  accounts?: number;
  days?: number;
  totalIncome?: number;
  entryIds?: string[];
  reason?: string;
};

/** 单批最多补多少天：接口一页 20 条，一次拉十年要翻上百页，按批滚动更稳。 */
const DAYS_PER_BATCH = 366;

/** 单次调用最多补几批（约 6 年），够覆盖货基常见持有期，也不把启动期的请求堆满。 */
const MAX_BATCHES_PER_RUN = 6;

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

/**
 * 当日收益（元）= 份额 ÷ 10000 × 每万份收益。
 *
 * 万份收益为负时（债券变现亏损等极端情形）合同约定份额相应减少，所以负数照算，
 * 否则累计收益会一直虚高。不足一分不结转：正负都向零截断，两边都不凭空多给/多扣。
 */
export function moneyFundDailyIncome(units: number, incomePer10k: number): number {
  const raw = (units * incomePer10k) / 10000;
  const income = Math.trunc(raw * 100) / 100;
  // 抹掉 -0，别让它以「-0.00」的样子出现在明细里。
  return income === 0 ? 0 : income;
}

/**
 * 把「每万份收益」从 lsjz 序列里挑出来。
 *
 * 东财对货基返回的 `DWJZ` 就是每万份收益（不是净值），这里按日期建索引；
 * 只取 (from, to] 区间，且必须落在区间的自然日内，缺哪天就少结哪天，绝不外推。
 * 负值保留——它代表当天的亏损分配（份额相应减少）。
 */
function incomeByDay(
  rows: { date: string; nav: number }[],
  from: Date,
  to: Date,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const value = Number(row.nav);
    if (!Number.isFinite(value)) continue;
    const day = row.date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const date = new Date(`${day}T00:00:00.000Z`);
    if (date <= from || date > to) continue;
    map.set(day, value);
  }
  return map;
}

type UnitMove = { day: string; delta: number };

type AccrualEntryRow = {
  fundSubtype: FundSubtype;
  units: Prisma.Decimal | null;
  applyDate: Date;
  confirmDate: Date | null;
  arrivalDate: Date | null;
};

const INCREASE_SUBTYPES = new Set<string>([FundSubtype.buy, FundSubtype.dividend_reinvest]);
const DECREASE_SUBTYPES = new Set<string>([FundSubtype.redeem, FundSubtype.switch_out]);

/**
 * 把流水折成「份额生效日 + 增减量」的时间线，用来还原某一天真实的持有份额。
 *
 * 生效规则与 recalcPosition 对齐，只有赎回多算一天：份额在申请日就记减，
 * 但收益口径是「赎回份额自 T+1 起不再享有收益」，申请当天仍按赎回前份额结息。
 * 结转流水本身就是 buy，会自然进入时间线，历史结转不会被漏算或重复算。
 */
export function buildMoneyUnitMoves(rows: AccrualEntryRow[]): UnitMove[] {
  const moves: UnitMove[] = [];
  for (const row of rows) {
    const units = Math.abs(Number(row.units ?? 0));
    if (!(units > 0)) continue;
    if (INCREASE_SUBTYPES.has(row.fundSubtype)) {
      const day = row.confirmDate ?? row.arrivalDate ?? row.applyDate;
      moves.push({ day: ymd(day), delta: units });
      continue;
    }
    if (DECREASE_SUBTYPES.has(row.fundSubtype)) {
      moves.push({ day: ymd(addDays(utcMidnight(row.applyDate), 1)), delta: -units });
    }
  }
  moves.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return moves;
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
}): Promise<FundAccrualOutcome> {
  const { householdId, accountId, fundCode, fundName, today } = params;
  const yesterday = addDays(utcMidnight(today), -1);

  const [holding, lastAccrual, entries] = await Promise.all([
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
    // 全部流水：既要拿建仓日，也要按日重放出「那一天到底持有多少份额」。
    prisma.fundTransaction.findMany({
      where: { fundAccountId: accountId, fundCode, deletedAt: null },
      orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }],
      select: {
        fundSubtype: true,
        units: true,
        applyDate: true,
        confirmDate: true,
        arrivalDate: true,
      },
    }),
  ]);

  const currentUnits = Number(holding?.units ?? 0);
  if (!(currentUnits > 0)) return { days: 0, totalIncome: 0, entryIds: [] };
  if (entries.length === 0) return { days: 0, totalIncome: 0, entryIds: [] };

  // 游标：上次结转到哪天的下一天；没结过就从建仓（确认）日开始。
  // 东财能翻页取到成立以来的每万份收益，所以历史可以补，不再人为截一个回看窗口。
  const firstEntry = entries[0];
  const cursorStart = lastAccrual
    ? addDays(utcMidnight(lastAccrual.applyDate), 1)
    : firstEntry.confirmDate && firstEntry.confirmDate > firstEntry.applyDate
      ? utcMidnight(firstEntry.confirmDate)
      : addDays(utcMidnight(firstEntry.applyDate), 1);
  if (cursorStart > yesterday) return { days: 0, totalIncome: 0, entryIds: [] };

  // 按日重放份额：不能用「当前份额」顶替历史份额，否则补历史时会把后期才有的份额
  // 算到早期，收益一路偏高。moves 已排序，指针单调右移即可。
  const moves = buildMoneyUnitMoves(entries);
  let moveIndex = 0;
  let units = 0;
  const advanceTo = (day: string) => {
    while (moveIndex < moves.length && moves[moveIndex].day <= day) {
      units += moves[moveIndex].delta;
      moveIndex += 1;
    }
  };
  advanceTo(ymd(addDays(cursorStart, -1)));

  const entryIds: string[] = [];
  let totalIncome = 0;
  let batchFrom = cursorStart;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN && batchFrom <= yesterday; batch += 1) {
    const batchLast = addDays(batchFrom, DAYS_PER_BATCH - 1);
    const batchTo = batchLast < yesterday ? batchLast : yesterday;
    const rows = await fetchHistoricalNavList(fundCode, ymd(batchFrom), ymd(batchTo));
    const byDay = incomeByDay(rows, addDays(batchFrom, -1), batchTo);
    const days = Array.from(byDay.keys()).sort();

    // 幂等：同一天同一条来源只允许一条，重复触发（开机自检 + 定时任务）不会翻倍加份额。
    // 一次查出本批已有结转的日期，避免逐日一次查询。
    const existing = days.length === 0 ? new Set<string>() : new Set(
      (await prisma.fundTransaction.findMany({
        where: {
          fundAccountId: accountId,
          fundCode,
          source: TRANSACTION_SOURCE_MONEY_INCOME,
          deletedAt: null,
          applyDate: {
            gte: new Date(`${days[0]}T00:00:00.000Z`),
            lte: new Date(`${days[days.length - 1]}T00:00:00.000Z`),
          },
        },
        select: { applyDate: true },
      })).map((row) => ymd(row.applyDate)),
    );

    for (const day of days) {
      advanceTo(day);
      // 份额被赎空（或被负收益扣完）之后没有收益可结。
      if (!(units > 0)) continue;
      const per10k = byDay.get(day)!;
      const income = moneyFundDailyIncome(units, per10k);
      // 不足一分不动；历史结转已经在时间线里（units 已含），只补没结过的日子。
      if (income === 0 || existing.has(day)) continue;

      const applyDate = new Date(`${day}T00:00:00.000Z`);
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
          // 净值恒为 1：份额增量在数值上等于收益金额（负收益就是份额减少）。
          nav: new Prisma.Decimal(1),
          units: new Prisma.Decimal(income),
          realizedProfit: null,
          note: null,
        },
        select: { id: true },
      });

      entryIds.push(created.id);
      totalIncome = round2(totalIncome + income);
      // 当天结转立刻成为次日的基数；负收益减完不会把份额压到 0 以下。
      units = Math.max(0, round2(units + income));
    }

    if (batchTo >= yesterday) break;
    batchFrom = addDays(batchTo, 1);
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
  today?: Date;
}): Promise<MoneyIncomeAccrualResult> {
  const { householdId, fundAccountId } = params;
  const today = params.today ?? new Date();

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
