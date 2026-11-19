import { FundProductType, FundSubtype, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { MONEY_FUND_NAV } from "@/lib/fund/moneyFund";
import { ensureMoneyFundYieldRange, shiftYmd } from "@/lib/fund/moneyFundYield";
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
  /** 本次覆盖的起止日（YYYY-MM-DD），用来回话「从哪天算到哪天」。 */
  fromDate?: string | null;
  toDate?: string | null;
  /** 一次调用最多补 MAX_BATCHES_PER_RUN 批，还没补到今天时为 true（再点一次接着补）。 */
  truncated?: boolean;
  /** 重算前清掉的旧结转条数。 */
  removed?: number;
  /**
   * 因万份收益取数失败而停顿的起始日（缺数据的那天）。非空表示这几天的收益**还没结**，
   * 不是「没有收益」；网络恢复后再点一次会从这里继续。
   */
  pendingFrom?: string | null;
  /** 数据源确认没有万份收益、已按 0 收益跳过的天数（不会结出份额）。 */
  skippedDays?: number;
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
 * 万份收益的区间过滤（含负值）由 MoneyFundYield 模块负责，这里只消费它的结果：
 * 键是自然日、值是每万份收益，缺哪天就少结哪天，绝不外推。
 */


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
  fromDate: string | null;
  toDate: string | null;
  truncated: boolean;
  removed: number;
  pendingFrom: string | null;
  skippedDays: number;
};

const EMPTY_OUTCOME: FundAccrualOutcome = {
  days: 0,
  totalIncome: 0,
  entryIds: [],
  fromDate: null,
  toDate: null,
  truncated: false,
  removed: 0,
  pendingFrom: null,
  skippedDays: 0,
};
async function accrueOneFund(params: {
  householdId: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  today: Date;
  rebuild?: boolean;
}): Promise<FundAccrualOutcome> {
  const { householdId, accountId, fundCode, fundName, today, rebuild = false } = params;
  const yesterday = addDays(utcMidnight(today), -1);

  // 强制重算：先把这只基金已有的结转流水清掉，游标随之归零，下面就从最早一笔交易
  // 重新逐日重放。只删 source=money_fund_income 的记录——用户自己的买入 / 赎回一条不动，
  // 万一中途取数失败，下次自检也会从建仓日重新补（结转本身是可以由流水重算出来的）。
  let removed = 0;
  if (rebuild) {
    const deleted = await prisma.fundTransaction.deleteMany({
      where: {
        householdId,
        fundAccountId: accountId,
        fundCode,
        source: TRANSACTION_SOURCE_MONEY_INCOME,
      },
    });
    removed = deleted.count;
  }

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
  // 平时不给已赎空的基金结息；重算是为了核对历史，清仓后照样允许跑一遍。
  if (!rebuild && !(currentUnits > 0)) return { ...EMPTY_OUTCOME, removed };
  if (entries.length === 0) return { ...EMPTY_OUTCOME, removed };

  // 游标：上次结转到哪天的下一天；没结过就从建仓（确认）日开始。
  // 东财能翻页取到成立以来的每万份收益，所以历史可以补，不再人为截一个回看窗口。
  const firstEntry = entries[0];
  const cursorStart = lastAccrual
    ? addDays(utcMidnight(lastAccrual.applyDate), 1)
    : firstEntry.confirmDate && firstEntry.confirmDate > firstEntry.applyDate
      ? utcMidnight(firstEntry.confirmDate)
      : addDays(utcMidnight(firstEntry.applyDate), 1);
  if (cursorStart > yesterday) return { ...EMPTY_OUTCOME, removed };

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
  // 用户问的「算到哪天」：记录实际处理到的最后一天与是否补到了昨天。
  let lastDay: string | null = null;
  let reachedEnd = false;
  let pendingFrom: string | null = null;
  let skippedDays = 0;
  const yesterdayKey = ymd(yesterday);

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN && batchFrom <= yesterday; batch += 1) {
    const batchLast = addDays(batchFrom, DAYS_PER_BATCH - 1);
    const batchTo = batchLast < yesterday ? batchLast : yesterday;
    const batchFromKey = ymd(batchFrom);
    const batchToKey = ymd(batchTo);
    // 万份收益先读本地表，只对逐日缺口回源；落库后历史重放不再依赖外部接口可用性。
    const range = await ensureMoneyFundYieldRange(fundCode, batchFromKey, batchToKey);
    const byDay = range.yields;

    // 取数失败且有缺口：不能把缺失日当「当天无收益」跳过。游标一旦越过缺口，那几天
    // 的份额就永久少结（连重算也补不回来），所以停在缺口前一天，下次从缺口继续。
    let cutoffKey = batchToKey;
    if (range.unresolved && range.missingDates.length > 0) {
      pendingFrom = pendingFrom ?? range.missingDates[0];
      cutoffKey = shiftYmd(range.missingDates[0], -1);
      if (cutoffKey < batchFromKey) break;
    } else {
      // 回源成功仍没有的日期＝数据源没披露：跳过不结（份额不变），但计数上报。
      skippedDays += range.missingDates.length;
    }
    const days = Array.from(byDay.keys())
      .filter((day) => day >= batchFromKey && day <= cutoffKey)
      .sort();

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
          nav: new Prisma.Decimal(MONEY_FUND_NAV),
          units: new Prisma.Decimal(income),
          // 结转金额同时记为已实现收益：统计里它是一条「货币基金收益」，
          // 而不是一条 0 元买入（份额增加由 units 表达）。
          realizedProfit: new Prisma.Decimal(income),
          // 把依据写进流水：份额为什么多了 0.51，事后可逐日核对。
          note: `每万份收益 ${per10k.toFixed(4)}，结转 ${income.toFixed(2)} 份`,
        },
        select: { id: true },
      });

      entryIds.push(created.id);
      totalIncome = round2(totalIncome + income);
      // 当天结转立刻成为次日的基数；负收益减完不会把份额压到 0 以下。
      units = Math.max(0, round2(units + income));
    }

    lastDay = cutoffKey;
    if (cutoffKey >= batchToKey) {
      if (batchToKey >= yesterdayKey) {
        reachedEnd = true;
        break;
      }
      batchFrom = addDays(batchTo, 1);
      continue;
    }
    // 缺口阻断：本批只结到缺口前一天，剩下的等下次（truncated 会提示还没算完）。
    pendingFrom = pendingFrom ?? shiftYmd(cutoffKey, 1);
    break;
  }

  if (entryIds.length > 0 || removed > 0) {
    await recalcFundPositions(accountId, [fundCode]);
  }

  return {
    days: entryIds.length,
    totalIncome,
    entryIds,
    fromDate: ymd(cursorStart),
    toDate: lastDay,
    // 批数用完但还没补到今天：用户再点一次就会接着往下补。
    truncated: !reachedEnd && cursorStart <= yesterday,
    removed,
    pendingFrom,
    skippedDays,
  };
}

/**
 * 结转所有货基持仓的收益（或只结某一个账户）。
 *
 * 触发时机由调用方决定（定时任务 / 开机自检 / 手工），本函数只管「把还差的日子补上」。
 */
export async function accrueMoneyFundIncome(params: {
  householdId: string;
  fundAccountId?: string;
  /** 只处理某一只基金（持仓行上的重算按钮用），不传则处理账户下全部货基。 */
  fundCode?: string;
  today?: Date;
  /** 强制重算：清掉已有结转，从最早一笔交易重新逐日重放（「从购买以来」一次算清）。 */
  rebuild?: boolean;
}): Promise<MoneyIncomeAccrualResult> {
  const { householdId, fundAccountId } = params;
  const today = params.today ?? new Date();
  const fundCode = params.fundCode?.trim() || undefined;
  const rebuild = params.rebuild === true;

  return runExclusive(
    // 锁粒度取账本级：自检（全账本）与手工重算（单账户）必须互斥，否则重算删流的
    // 同时自检正在按旧游标补，会结出重复份额。
    `money-fund-income:${householdId}`,
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
      let fromDate: string | null = null;
      let toDate: string | null = null;
      let truncated = false;
      let removed = 0;
      let pendingFrom: string | null = null;
      let skippedDays = 0;

      for (const account of accounts) {
        const holdings = await prisma.fundHolding.findMany({
          // 重算 / 点名某只基金时都不过滤份额：清仓的基金也要能重放一遍核对历史。
          where: {
            accountId: account.id,
            ...(fundCode ? { fundCode } : {}),
            ...(fundCode || rebuild ? {} : { units: { gt: 0 } }),
          },
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
              rebuild,
            });
            entryIds.push(...outcome.entryIds);
            days += outcome.days;
            totalIncome = round2(totalIncome + outcome.totalIncome);
            removed += outcome.removed;
            if (outcome.fromDate && (!fromDate || outcome.fromDate < fromDate)) fromDate = outcome.fromDate;
            if (outcome.toDate && (!toDate || outcome.toDate > toDate)) toDate = outcome.toDate;
            if (outcome.truncated) truncated = true;
            skippedDays += outcome.skippedDays;
            if (outcome.pendingFrom && (!pendingFrom || outcome.pendingFrom < pendingFrom)) {
              pendingFrom = outcome.pendingFrom;
            }
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

      if (entryIds.length === 0 && removed === 0) {
        return {
          status: "skipped" as const,
          accounts: accounts.length,
          fromDate,
          toDate,
          truncated,
          pendingFrom,
          skippedDays,
          reason: pendingFrom ? "yield data unavailable" : "nothing to accrue",
        };
      }
      return {
        status: "accrued" as const,
        accounts: accounts.length,
        days,
        totalIncome,
        entryIds,
        fromDate,
        toDate,
        truncated,
        removed,
        pendingFrom,
        skippedDays,
      };
    },
    () => ({ status: "skipped" as const, reason: "busy" }),
  );
}
