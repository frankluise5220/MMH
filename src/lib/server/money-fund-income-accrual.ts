import { FundProductType, FundSubtype, Prisma } from "@prisma/client";

import { formatDateInTimeZone } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { MONEY_FUND_NAV } from "@/lib/fund/moneyFund";
import { ensureMoneyFundYieldRange, shiftYmd } from "@/lib/fund/moneyFundYield";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
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
 * 历史回补（2026-11-26 用户裁定）：**添加/导入一只非当日的货基时，自动结转不回补历史**。
 * 自动结转（开机自检、后台任务）只从「这笔基金第一次被录进系统那天」起逐日往下结，
 * 建仓日至今的空档留给用户在持仓行上点「重算收益结转」显式生成——那条路径带
 * `rebuildFrom`，不受水位限制。时间太久的货基（几年以上）与其逐段重算，用户更愿意
 * 直接按当前份额手工记一笔。
 *
 * 手工重算每点一次只跑一年（`maxBatches = 1`），算完由界面弹窗告诉用户「已重算到哪天」，
 * 用户再点一次接着往下跑；删除区间也严格限制在这一年内，绝不能「删掉整段、只结一年」。
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

/** 重算区间端点只接受 `YYYY-MM-DD` 业务日字符串，其余一律当「没填」。 */
function normalizeDayKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function dayFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** 含头含尾的天数差（`YYYY-MM-DD`）。 */
function daysBetweenKeys(fromKey: string, toKey: string): number {
  return Math.round((dayFromKey(toKey).getTime() - dayFromKey(fromKey).getTime()) / 86_400_000);
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
  /** 真实录入时刻：算自动结转水位（录进来之前的收益不算）。 */
  createdAt: Date;
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
  /** 账本时区：自动结转的水位（第一次录入那天）按这个时区算业务日。 */
  timeZone: string;
  rebuild?: boolean;
  /** 重算起点（含）：只删这一段内的结转行，再从这天重放；不传＝从最早一笔交易。 */
  rebuildFrom?: string | null;
  /** 重算终点（含）：缺省＝昨天，晚于昨天会被夹回昨天。 */
  rebuildTo?: string | null;
  /** 单次最多跑几批（每批约一年）：手工重算传 1，自动结转用默认值。 */
  maxBatches?: number;
}): Promise<FundAccrualOutcome> {
  const {
    householdId,
    accountId,
    fundCode,
    fundName,
    today,
    timeZone,
    rebuild = false,
    maxBatches = MAX_BATCHES_PER_RUN,
  } = params;
  const yesterday = addDays(utcMidnight(today), -1);
  const yesterdayKey = ymd(yesterday);

  const rebuildFromKey = normalizeDayKey(params.rebuildFrom);
  const rebuildToRaw = normalizeDayKey(params.rebuildTo);
  const rebuildToKey = rebuildToRaw && rebuildToRaw > yesterdayKey ? yesterdayKey : rebuildToRaw;
  // 用户要求的终点（最多到昨天）。单次窗口再按 maxBatches 收缩。
  const requestedEndKey = rebuildToKey ?? yesterdayKey;

  // 强制重算：先清掉已有结转，游标随之归零，下面重新逐日重放。只删
  // source=money_fund_income 的记录——用户自己的买入 / 赎回一条不动。
  // 2026-11-26：带起点的重算一次只处理一年，**删除区间也必须跟着这一年走**，
  // 否则「删掉七年、只结一年」会让后面几年在用户继续点之前彻底没有收益行。
  const windowEndKey = rebuildFromKey
    && daysBetweenKeys(rebuildFromKey, requestedEndKey) + 1 > maxBatches * DAYS_PER_BATCH
    ? shiftYmd(rebuildFromKey, maxBatches * DAYS_PER_BATCH - 1)
    : requestedEndKey;

  let removed = 0;
  if (rebuildFromKey) {
    if (rebuildFromKey <= windowEndKey) {
      const deleted = await prisma.fundTransaction.deleteMany({
        where: {
          householdId,
          fundAccountId: accountId,
          fundCode,
          source: TRANSACTION_SOURCE_MONEY_INCOME,
          applyDate: {
            gte: dayFromKey(rebuildFromKey),
            lte: dayFromKey(windowEndKey),
          },
        },
      });
      removed = deleted.count;
    }
  } else if (rebuild) {
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
        createdAt: true,
      },
    }),
  ]);

  const currentUnits = Number(holding?.units ?? 0);
  // 平时不给已赎空的基金结息；重算（含接着往下算）是为了核对历史，清仓后照样允许跑一遍。
  if (!rebuild && !rebuildFromKey && !(currentUnits > 0)) return { ...EMPTY_OUTCOME, removed };
  if (entries.length === 0) return { ...EMPTY_OUTCOME, removed };

  // 游标：上次结转到哪天的下一天；没结过就从建仓（确认）日开始。
  // 东财能翻页取到成立以来的每万份收益，所以历史可以补，不再人为截一个回看窗口。
  const firstEntry = entries[0];
  const naturalStart = firstEntry.confirmDate && firstEntry.confirmDate > firstEntry.applyDate
    ? utcMidnight(firstEntry.confirmDate)
    : addDays(utcMidnight(firstEntry.applyDate), 1);
  let cursorStart: Date;
  if (rebuildFromKey) {
    // 手工重算 / 接着往下算：从用户指定的那天起，但不早于建仓日。
    const requestedStart = dayFromKey(rebuildFromKey);
    cursorStart = requestedStart > naturalStart ? requestedStart : naturalStart;
  } else if (lastAccrual) {
    cursorStart = addDays(utcMidnight(lastAccrual.applyDate), 1);
  } else {
    // 自动结转（自检 / 定时任务）：只从「这只基金第一次被录进系统那天」往后结。
    // 2026-11-26 用户裁定：补录一只非当日的货基，不自动回补历史收益；要历史请点「重算」。
    // 「从购买以来整段重来」（rebuild 且没给起点）是用户显式点名要历史，不受这个水位限制。
    const firstRecordedKey = entries.reduce<string>(
      (min, entry) => {
        const key = formatDateInTimeZone(entry.createdAt, timeZone);
        return min && min < key ? min : key;
      },
      "",
    );
    const floor = !rebuild && firstRecordedKey ? dayFromKey(firstRecordedKey) : null;
    cursorStart = floor && floor > naturalStart ? floor : naturalStart;
  }
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

  const accrualEnd = dayFromKey(windowEndKey);
  // 起点已经在窗口之后（区间填反了 / 续算游标超出了终点）：没有任何可算的，别让界面空转。
  if (cursorStart > accrualEnd) return { ...EMPTY_OUTCOME, removed };

  const entryIds: string[] = [];
  let totalIncome = 0;
  let batchFrom = cursorStart;
  // 用户问的「算到哪天」：记录实际处理到的最后一天与是否补到了终点。
  let lastDay: string | null = null;
  let reachedEnd = false;
  let pendingFrom: string | null = null;
  let skippedDays = 0;

  for (let batch = 0; batch < maxBatches && batchFrom <= accrualEnd; batch += 1) {
    const batchLast = addDays(batchFrom, DAYS_PER_BATCH - 1);
    const batchTo = batchLast < accrualEnd ? batchLast : accrualEnd;
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
      if (batchToKey >= windowEndKey) {
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
    // 这一段没跑完（批数用完 / 窗口只到一年 / 卡在缺口）：界面提醒用户再点一次接着补。
    truncated: !reachedEnd || lastDay === null || lastDay < requestedEndKey,
    removed,
    pendingFrom,
    skippedDays,
  };
}

/**
 * 结转所有货基持仓的收益（或只结某一个账户）。
 *
 * 触发时机由调用方决定（定时任务 / 开机自检 / 手工），本函数只管「把还差的日子补上」。
 * 自动结转（没有 `rebuild` / `rebuildFrom`）不会回补历史：起点取「这笔基金第一次被录进
 * 系统那天」与建仓日中较晚的一个；要历史请带 `rebuild` 或 `rebuildFrom`（界面上的重算按钮）。
 */
export async function accrueMoneyFundIncome(params: {
  householdId: string;
  fundAccountId?: string;
  /** 只处理某一只基金（持仓行上的重算按钮用），不传则处理账户下全部货基。 */
  fundCode?: string;
  today?: Date;
  /** 强制重算：清掉已有结转，从最早一笔交易重新逐日重放（每次只跑一年，见 maxBatches）。 */
  rebuild?: boolean;
  /**
   * 重算起点 / 终点（`YYYY-MM-DD`，含两端）。带起点时只删这一段、只重放这一段，
   * 是「一次一年、用户再点一次接着算」的续算入口；不带起点＝从最早一笔交易重来。
   */
  rebuildFrom?: string | null;
  rebuildTo?: string | null;
  /** 单次最多跑几批（每批约一年）：手工重算传 1，自动结转不传（默认 6 批）。 */
  maxBatches?: number;
}): Promise<MoneyIncomeAccrualResult> {
  const { householdId, fundAccountId } = params;
  const today = params.today ?? new Date();
  const fundCode = params.fundCode?.trim() || undefined;
  const rebuild = params.rebuild === true;
  const timeZone = await getHouseholdTimeZone(householdId);

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
              timeZone,
              rebuild,
              rebuildFrom: params.rebuildFrom ?? null,
              rebuildTo: params.rebuildTo ?? null,
              maxBatches: params.maxBatches,
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

/**
 * 重算窗口预览（只读）：界面点「重算」之前先问一句这只基金的历史有多长。
 *
 * 2026-11-26 用户裁定：超过一年的货基，点重算时先弹提示（重算一次只算一年），
 * 由用户决定「逐年重算」还是「关掉提示、直接按当前份额手工记一笔买入」。
 * 预览不写任何数据；起点口径与 `accrueOneFund` 完全一致（确认日晚于买入日取确认日，
 * 否则买入日次日），终点是「昨天」。
 */
export type MoneyFundRebuildPreview = {
  fundCode: string;
  /** 最早可算的收益起始日（`YYYY-MM-DD`）；没有任何流水时为 null。 */
  startDate: string | null;
  /** 可以算到的最后一天（`YYYY-MM-DD`）。 */
  endDate: string;
  /** startDate → endDate 的天数（含两端）；无流水或起点晚于终点时为 0。 */
  totalDays: number;
  /** 按「一次一年」还需要点几次重算才算完。 */
  batches: number;
};

export async function previewMoneyFundRebuildWindow(params: {
  fundAccountId: string;
  fundCode: string;
  today?: Date;
}): Promise<MoneyFundRebuildPreview> {
  const today = params.today ?? new Date();
  const yesterday = addDays(utcMidnight(today), -1);
  const endKey = ymd(yesterday);
  const base = { fundCode: params.fundCode, endDate: endKey, totalDays: 0, batches: 0 };

  const firstEntry = await prisma.fundTransaction.findFirst({
    where: { fundAccountId: params.fundAccountId, fundCode: params.fundCode, deletedAt: null },
    orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }],
    select: { applyDate: true, confirmDate: true },
  });
  if (!firstEntry) return { ...base, startDate: null };

  const naturalStart = firstEntry.confirmDate && firstEntry.confirmDate > firstEntry.applyDate
    ? utcMidnight(firstEntry.confirmDate)
    : addDays(utcMidnight(firstEntry.applyDate), 1);
  const startKey = ymd(naturalStart);
  if (naturalStart > yesterday) return { ...base, startDate: startKey };

  const totalDays = daysBetweenKeys(startKey, endKey) + 1;
  return {
    fundCode: params.fundCode,
    startDate: startKey,
    endDate: endKey,
    totalDays,
    batches: Math.ceil(totalDays / DAYS_PER_BATCH),
  };
}
