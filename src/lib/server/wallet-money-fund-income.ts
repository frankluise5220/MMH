import { AccountKind, FundProductType, Prisma, TransactionType } from "@prisma/client";

import { addDaysUtc } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { resolveFundName } from "@/lib/fund/fundProfile";
import { ensureMoneyFundYieldRange, shiftYmd } from "@/lib/fund/moneyFundYield";
import { queryDailyEndBalances } from "@/lib/server/detail-page-query";
import { moneyFundDailyIncome } from "@/lib/server/money-fund-income-accrual";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import { runExclusive, utcDayKey } from "@/lib/server/interest-accrual";
import { logger } from "@/lib/logger";
import { ENTRY_ORIGIN_SCHEDULED_TASK, TRANSACTION_SOURCE_MONEY_INCOME } from "@/lib/transaction-semantics";

/**
 * 电子钱包直接挂货基代码的每日收益（2026-11-19 用户裁定，轻量模型）。
 *
 * 为什么不再建「货币基金账户」：钱包本身就是那份钱，货基按面值 1 元/份核算，
 * 余额就是份额。再开一个投资账户只为记份额，会让同一笔钱在「钱包」和「货基」
 * 两处各有一套流水、一套余额，绑定/解绑还得搬来搬去。这里只保留必要的一步：
 *
 *   当日收益 = 前一日日终余额 ÷ 10000 × 当日每万份收益
 *
 * 收益直接在本钱包记一条 `type=income` 的流水（分类「基金收益」），余额随之上涨，
 * 次日再按新的余额计息（自然复利）。不产生份额、不生成申赎腿、不影响基金持仓。
 *
 * 为什么是 income 而不是 investment（2026-11-20 用户裁定）：万份收益就是当天到账的
 * 收入，不是基金申赎。记成 investment 会让明细把它当「基金赎回」编辑，弹基金交易窗、
 * 还要求选一个「货币基金账户」——轻量模型里根本没有这个账户。source 仍保留，
 * 它只是幂等键和报表口径标记，与 type 无关。
 *
 * 同一只钱包可以在不同时间挂不同的货基（用户 2026-11-19 追加要求）：
 * 绑定关系存在 wallet_linked_funds 的「区间」里，逐日计息时按日期找到当天生效的那一段，
 * 用那一段的基金代码取每万份收益。Account.linkedFundCode 只是当前段的快照。
 *
 * 三个必须守住的点：
 *   1. 基数是**前一日日终余额**，不是当天余额：当天的消费/转出不能让当天已经
 *      持有了一整天的钱少拿收益（货基规则是赎回份额 T+1 起才不享收益）。
 *   2. 日终余额必须与明细/账户余额同一条折叠链（`applyBalanceAnchorEntry`），
 *      否则「收益基数」会和用户看到的余额对不上。
 *   3. 幂等：同一钱包同一天只允许一条 `source=money_fund_income`（**与基金代码无关**）。
 *      钱包里的钱一天只能呆在一只货基里，换绑当天不可能两头都拿收益；把基金代码放进
 *      幂等键会让「新旧两段区间有一天重叠」结出两条收益（2026-11-20 用户报的重复收益）。
 */

const MONEY_INCOME_CATEGORY_NAME = "基金收益";

/** 单次最多补多少天，剩下的下次接着补（绑定很久以前也不会一次卡死请求）。 */
const MAX_DAYS_PER_RUN = 366;

export type WalletMoneyFundAccrualResult = {
  status: "accrued" | "skipped";
  wallets?: number;
  days?: number;
  totalIncome?: number;
  fromDate?: string | null;
  toDate?: string | null;
  /** 批数用完还没补到昨天：再触发一次会接着往下补。 */
  truncated?: boolean;
  /** 万份收益缺数据的起始日（非空表示这几天还没结，不是没有收益）。 */
  pendingFrom?: string | null;
  /** 「从某天重算」时删掉的旧收益行数。 */
  removed?: number;
  reason?: string;
};

const EMPTY: WalletMoneyFundAccrualResult = {
  status: "skipped",
  wallets: 0,
  days: 0,
  totalIncome: 0,
  fromDate: null,
  toDate: null,
  truncated: false,
  pendingFrom: null,
  removed: 0,
};

type WalletTarget = {
  id: string;
  name: string;
  currency: string | null;
  /** 当前生效段的快照；表里没有记录时用它兜底成一段。 */
  linkedFundCode: string;
  linkedFundStartDate: Date;
};

/** 一段绑定：某基金在 [startKey, endKey] 期间生效（endKey 为空表示仍在生效）。 */
type LinkedFundSegment = {
  fundCode: string;
  fundName: string | null;
  startKey: string;
  endKey: string | null;
};

type SegmentPlan = LinkedFundSegment & {
  fromKey: string;
  toKey: string;
  yields: Map<string, number>;
};

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 含头含尾的天数差（YYYY-MM-DD）。 */
function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00.000Z`);
  const to = Date.parse(`${toKey}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

async function resolveMoneyIncomeCategoryId(householdId: string): Promise<string | null> {
  const row = await prisma.category.findFirst({
    where: { householdId, name: MONEY_INCOME_CATEGORY_NAME },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * 钱包的绑定区间（按起始日升序）。
 *
 * 表里还没有记录时（迁移刚上、或老库只有 Account 上的单段），退回用 Account 快照
 * 拼一段，保证计息不中断；迁移会把这些快照回填成正式记录。
 */
async function loadWalletSegments(wallet: WalletTarget): Promise<LinkedFundSegment[]> {
  const rows = await prisma.walletLinkedFund.findMany({
    where: { accountId: wallet.id },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
    select: { fundCode: true, fundName: true, startDate: true, endDate: true },
  });
  if (rows.length > 0) {
    return rows
      .map((row) => ({
        fundCode: row.fundCode.trim(),
        fundName: row.fundName,
        startKey: utcDayKey(row.startDate),
        endKey: row.endDate ? utcDayKey(row.endDate) : null,
      }))
      .filter((row) => /^\d{6}$/.test(row.fundCode));
  }
  return [{
    fundCode: wallet.linkedFundCode,
    fundName: null,
    startKey: utcDayKey(wallet.linkedFundStartDate),
    endKey: null,
  }];
}

/**
 * 钱包的「日终余额」时间线（只算到 `untilKey`，含当天）。
 *
 * 直接复用明细页的余额引擎（`queryDailyEndBalances` → `ledger_balanced` CTE），
 * 使计息基数与用户在明细余额列看到的是**同一个数字**。
 *
 * 为什么不再自己折叠（2026-11-21 用户报「明细余额 21279.90 却按 14886.80 计息」）：
 * 旧实现用 `getDetailEntryDisplayDate` + `applyBalanceAnchorEntry` 另起一条链。两条链
 * 在关联业务生效日（赎回款到账日）、锚点分段、金额方向上各自实现，长期看必然分叉——
 * 该账户两条链从 7 月起就差约 6963 元，且差额随流水波动。既然用户核对的是明细余额列，
 * 计息就只能以那一条链为准，绝不能有两套「日终余额」。
 */
async function loadWalletDailyEndBalance(
  householdId: string,
  walletId: string,
  untilKey: string,
): Promise<{ balanceOf: (dayKey: string) => number }> {
  const byDay = await queryDailyEndBalances({ accountId: walletId, householdId, untilKey });
  const dayKeys = [...byDay.keys()].sort();
  let cursor = 0;
  let current = 0;
  const balanceOf = (dayKey: string) => {
    while (cursor < dayKeys.length && dayKeys[cursor] <= dayKey) {
      current = byDay.get(dayKeys[cursor]) ?? current;
      cursor += 1;
    }
    return current;
  };
  return { balanceOf };
}

/** 重算区间端点只接受 `YYYY-MM-DD` 业务日字符串，其余一律当「没填」。 */
function normalizeDayKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

async function accrueOneWallet(params: {
  householdId: string;
  wallet: WalletTarget;
  today: Date;
  rebuild: boolean;
  /** 从这一天（含）起重算：删掉该日及以后的收益行，再从这天补到终点（默认昨天）。 */
  rebuildFrom?: string | null;
  /** 重算终点（含）；默认补到昨天，因为当天的万份收益还没公布。 */
  rebuildTo?: string | null;
}): Promise<WalletMoneyFundAccrualResult> {
  const { householdId, wallet, today, rebuild } = params;
  const yesterday = addDaysUtc(utcMidnight(today), -1);
  const yesterdayKey = utcDayKey(yesterday);

  const segments = await loadWalletSegments(wallet);
  if (segments.length === 0) {
    return { ...EMPTY, wallets: 1, reason: "no linked fund segment" };
  }
  const walletStartKey = segments[0].startKey;

  // 起算日不能早于第一段的起始日：那天之前本来就不该有收益。
  const rebuildFromRaw = normalizeDayKey(params.rebuildFrom);
  const rebuildFromKey = rebuildFromRaw && rebuildFromRaw < walletStartKey ? walletStartKey : rebuildFromRaw;

  // 重算终点（用户选的「到某天」）：只在「从某天重算」时生效，晚于昨天一律夹到昨天
  // ——当天的万份收益还没公布。
  const rebuildToRaw = rebuildFromKey ? normalizeDayKey(params.rebuildTo) : null;
  const rebuildToKey = rebuildToRaw && rebuildToRaw > yesterdayKey ? yesterdayKey : rebuildToRaw;
  /** 本轮的计息上限：没选终点就是昨天。 */
  const accrualEndKey = rebuildToKey && rebuildToKey < yesterdayKey ? rebuildToKey : yesterdayKey;

  // 重算按「钱包」删，不限基金代码：区间里可能有多个段的收益行都要重放。
  // 选了终点就只删这一段，区间之后的行保持原样（用户只要求重放这一段）。
  let removed = 0;
  if (rebuild) {
    const deleted = await prisma.txRecord.deleteMany({
      where: { accountId: wallet.id, source: TRANSACTION_SOURCE_MONEY_INCOME },
    });
    removed = deleted.count;
  } else if (rebuildFromKey) {
    const deleted = await prisma.txRecord.deleteMany({
      where: {
        accountId: wallet.id,
        source: TRANSACTION_SOURCE_MONEY_INCOME,
        date: {
          gte: new Date(`${rebuildFromKey}T00:00:00.000Z`),
          ...(rebuildToKey ? { lte: new Date(`${rebuildToKey}T00:00:00.000Z`) } : {}),
        },
      },
    });
    removed = deleted.count;
  }

  // 删过行就要把账户余额重新折一次——即使这一天后来没生成新行（余额基数变了不能留旧值）。
  let needBalanceRecalc = removed > 0;
  const finish = async (result: WalletMoneyFundAccrualResult): Promise<WalletMoneyFundAccrualResult> => {
    if (needBalanceRecalc) {
      await recalcAndSaveAccountBalance(wallet.id).catch((error) => {
        logger.warn(`Wallet money fund balance recalc failed: ${wallet.id}`, "wallet-money-fund-income", error);
      });
    }
    return { ...result, removed };
  };

  const [lastAccrual, categoryId] = await Promise.all([
    // 从指定日重算时忽略既有游标：用户就是要求从那天开始全部重来。
    rebuildFromKey
      ? Promise.resolve(null)
      : prisma.txRecord.findFirst({
        where: {
          accountId: wallet.id,
          source: TRANSACTION_SOURCE_MONEY_INCOME,
          deletedAt: null,
        },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
    resolveMoneyIncomeCategoryId(householdId),
  ]);

  const cursorKey = rebuildFromKey
    ?? (lastAccrual ? shiftYmd(utcDayKey(lastAccrual.date), 1) : null);

  // 逐段规划：每段裁到 [max(段起始, 游标), min(段结束, 昨天)]，并取该段的万份收益。
  const plans: SegmentPlan[] = [];
  const fundNameCache = new Map<string, string>();
  let pendingFrom: string | null = null;
  let truncated = false;
  let budget = MAX_DAYS_PER_RUN;

  for (const segment of segments) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const segmentEndKey = segment.endKey && segment.endKey < accrualEndKey ? segment.endKey : accrualEndKey;
    let fromKey = segment.startKey;
    if (cursorKey && cursorKey > fromKey) fromKey = cursorKey;
    if (fromKey > segmentEndKey) continue;

    let toKey = segmentEndKey;
    if (daysBetween(fromKey, toKey) + 1 > budget) {
      toKey = shiftYmd(fromKey, budget - 1);
      truncated = true;
    }

    const range = await ensureMoneyFundYieldRange(segment.fundCode, fromKey, toKey);
    // 万份收益取数失败且有缺口：停在缺口前一天，下次从缺口继续；越过缺口会让那几天永久少结。
    if (range.unresolved && range.missingDates.length > 0) {
      pendingFrom = range.missingDates[0];
      toKey = shiftYmd(pendingFrom, -1);
      if (toKey < fromKey) {
        truncated = true;
        break;
      }
    }

    plans.push({ ...segment, fromKey, toKey, yields: range.yields });
    budget -= daysBetween(fromKey, toKey) + 1;
    if (pendingFrom) break;
  }

  if (plans.length === 0) {
    return finish({
      ...EMPTY,
      wallets: 1,
      fromDate: cursorKey ?? walletStartKey,
      toDate: rebuildToKey,
      pendingFrom,
      truncated,
      reason: pendingFrom ? "yield data unavailable" : "nothing to accrue",
    });
  }

  const minFromKey = plans.reduce((min, plan) => (plan.fromKey < min ? plan.fromKey : min), plans[0].fromKey);
  const maxToKey = plans.reduce((max, plan) => (plan.toKey > max ? plan.toKey : max), plans[0].toKey);

  // 幂等键是「日期」而不是「日期 + 基金代码」：一只钱包一天只可能有一只货基在生息，
  // 换绑/新增段的区间只要有一天重叠，按基金代码去重就会结出两条收益。
  const existing = new Set(
    (
      await prisma.txRecord.findMany({
        where: {
          accountId: wallet.id,
          source: TRANSACTION_SOURCE_MONEY_INCOME,
          deletedAt: null,
          date: {
            gte: new Date(`${minFromKey}T00:00:00.000Z`),
            lte: new Date(`${maxToKey}T00:00:00.000Z`),
          },
        },
        select: { date: true },
      })
    ).map((row) => utcDayKey(row.date)),
  );

  const { balanceOf } = await loadWalletDailyEndBalance(householdId, wallet.id, maxToKey);

  let created = 0;
  let totalIncome = 0;
  /**
   * 本轮已经排进 rows 的收益累计（按日升序处理，轮到某天时它就等于「该日之前」的收益之和）。
   *
   * 为什么不直接信 balanceOf：折叠链只读库里已有的行，本轮要写的收益行还没落库，
   * 于是每一天的基数都停在「删完之后/补之前」的那个余额上——收益不再滚进本金，
   * 重算出来的每天份额一模一样，备注里的份额也跟着错（2026-11-20 用户报）。
   * 货基按面值计，收益次日就变成份额，必须把这部分加进基数。
   */
  let carriedIncome = 0;
  const rows: Prisma.TxRecordCreateManyInput[] = [];

  for (const plan of plans) {
    const fundCode = plan.fundCode;
    let fundName = plan.fundName?.trim() || fundNameCache.get(fundCode) || "";
    if (!fundName) {
      fundName = (await resolveFundName(fundCode).catch(() => null)) ?? fundCode;
      fundNameCache.set(fundCode, fundName);
    }

    const days = [...plan.yields.keys()]
      .filter((day) => day >= plan.fromKey && day <= plan.toKey)
      .sort();

    for (const day of days) {
      // existing 同时承担两件事：库里已有的收益日、以及本轮前面几段已经排过的收益日。
      if (existing.has(day)) continue;
      // 前一日日终余额 + 本轮此前各天已排的收益（还没落库，折叠链看不到，见 carriedIncome）。
      const base = round2(balanceOf(shiftYmd(day, -1)) + carriedIncome);
      if (!(base > 0)) continue;
      const per10k = plan.yields.get(day)!;
      const income = moneyFundDailyIncome(base, per10k);
      if (income === 0) continue;
      existing.add(day);
      carriedIncome = round2(carriedIncome + income);
      rows.push({
        householdId,
        accountId: wallet.id,
        accountName: wallet.name,
        // 收益是收入（2026-11-20）：不是基金申赎，明细/编辑都按 income 处理。
        type: TransactionType.income,
        amount: new Prisma.Decimal(income),
        date: new Date(`${day}T00:00:00.000Z`),
        currency: wallet.currency ?? "CNY",
        status: "posted",
        source: TRANSACTION_SOURCE_MONEY_INCOME,
        entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
        categoryId,
        categoryName: MONEY_INCOME_CATEGORY_NAME,
        fundCode,
        fundName,
        fundProductType: FundProductType.money,
        // 轻量模型没有份额：余额就是本金，收益只加余额（不写 fundUnits，免得被当成持仓）。
        //
        // fundSubtype 留空（收益不是申购）。type=income 后分类就是账簿里那个 income 型
        // 的「基金收益」，不会再被 transactions_set_investment_system_category 这个
        // investment 触发器改写成「基金买入」；月度收益/买入汇总仍按 source 排除这些行，
        // 所以不要为它另造同名分类。
        fundSubtype: null,
        fundNav: null,
        fundUnits: null,
        // 货基 1 元/份，计息基数就是前一日日终的账户余额（明细里能查到的那个数）。
        // 备注叫「计息余额」而不是「份额」：用户核对的是明细余额列，写「份额」会以为
        // 是另一套数字（2026-11-21 用户报「余额 2 万多却按 1.4 万算」）。代码、基数、
        // 万份收益、收益都写进备注，明细里不用点开就能逐项对账。
        note: `基金代码 ${fundCode}，计息余额 ${base.toFixed(2)}，每万份收益 ${per10k.toFixed(4)}，收益 ${income.toFixed(2)} 元`,
        dayOrder: 0,
      });
      created += 1;
      totalIncome = round2(totalIncome + income);
    }
  }

  if (rows.length > 0) {
    // 一次落库；skipDuplicates 是并发的最后一道闸——两个实例/两个手工触发同时补历史时，
    // 「先查后写」都查不到对方尚未提交的行，只有数据库唯一索引能拦住重复。
    const inserted = await createManySkipDuplicatesCompat(prisma.txRecord, rows);
    created = inserted.count;
    needBalanceRecalc = true;
  }

  return finish({
    status: created > 0 ? "accrued" : "skipped",
    wallets: 1,
    days: created,
    totalIncome,
    fromDate: minFromKey,
    toDate: maxToKey,
    truncated: truncated || maxToKey < accrualEndKey,
    pendingFrom,
    reason: created === 0 ? "nothing to accrue" : undefined,
  });
}

/**
 * 给「直接挂货基代码」的电子钱包补结每日收益（当前账本，或只结某一只钱包）。
 *
 * 触发时机与旧货基结转一致：开机自检 + 手工接口。漏跑几天不会丢——从上次结转日的
 * 次日继续，单次最多补 366 天，剩下的下次接着补。
 *
 * `rebuildFrom` / `rebuildTo`：重算区间 `[from, to]`（含两端）——先删掉这段收益行，
 * 再按当前余额与万份收益重放。`to` 默认昨天（当天收益还没公布），晚于昨天会被夹回昨天。
 * 改了历史流水、或万份收益数据修正之后用它把某一段重放（`rebuild` 是整段重来）。
 */
export async function accrueWalletMoneyFundIncome(params: {
  householdId: string;
  walletAccountId?: string;
  today?: Date;
  rebuild?: boolean;
  rebuildFrom?: string | null;
  rebuildTo?: string | null;
}): Promise<WalletMoneyFundAccrualResult> {
  const { householdId, walletAccountId } = params;
  const today = params.today ?? new Date();
  const rebuild = params.rebuild === true;
  const rebuildFrom = normalizeDayKey(params.rebuildFrom);
  const rebuildTo = normalizeDayKey(params.rebuildTo);

  return runExclusive(`wallet-money-fund-income:${householdId}`, async () => {
    const rows = await prisma.account.findMany({
      where: {
        householdId,
        kind: AccountKind.ewallet,
        ...(walletAccountId ? { id: walletAccountId } : {}),
        // 当前段已解绑（快照为空）但还留有历史段时也要能重算历史：
        // 指定单只钱包时放宽条件，由下方「至少有一段生效过」兜住。
        ...(walletAccountId
          ? {}
          : { linkedFundCode: { not: null }, linkedFundStartDate: { not: null } }),
      },
      select: {
        id: true,
        name: true,
        currency: true,
        linkedFundCode: true,
        linkedFundStartDate: true,
        WalletLinkedFunds: {
          where: { endDate: null },
          orderBy: { startDate: "desc" },
          select: { fundCode: true, startDate: true },
          take: 1,
        },
      },
    });

    // 当前段以区间表为准（同一只钱包换过货基也认得），表里没有记录时退回账户快照。
    const wallets: WalletTarget[] = [];
    for (const row of rows) {
      const open = row.WalletLinkedFunds[0];
      const linkedFundCode = String(open?.fundCode ?? row.linkedFundCode ?? "").trim();
      const linkedFundStartDate = open?.startDate ?? row.linkedFundStartDate;
      if (!/^\d{6}$/.test(linkedFundCode) || !linkedFundStartDate) continue;
      wallets.push({ id: row.id, name: row.name, currency: row.currency, linkedFundCode, linkedFundStartDate });
    }

    if (wallets.length === 0) {
      return { ...EMPTY, reason: "no wallet linked to a money fund" };
    }

    let days = 0;
    let totalIncome = 0;
    let fromDate: string | null = null;
    let toDate: string | null = null;
    let truncated = false;
    let pendingFrom: string | null = null;
    let removed = 0;

    for (const wallet of wallets) {
      try {
        const outcome = await accrueOneWallet({ householdId, wallet, today, rebuild, rebuildFrom, rebuildTo });
        removed += outcome.removed ?? 0;
        days += outcome.days ?? 0;
        totalIncome = round2(totalIncome + (outcome.totalIncome ?? 0));
        if (outcome.fromDate && (!fromDate || outcome.fromDate < fromDate)) fromDate = outcome.fromDate;
        if (outcome.toDate && (!toDate || outcome.toDate > toDate)) toDate = outcome.toDate;
        if (outcome.truncated) truncated = true;
        if (outcome.pendingFrom && (!pendingFrom || outcome.pendingFrom < pendingFrom)) {
          pendingFrom = outcome.pendingFrom;
        }
      } catch (error) {
        // 单只钱包失败不能拖垮其它钱包：游标没推进，下次会重试同一天。
        logger.warn(`Wallet money fund income failed: ${wallet.id}`, "wallet-money-fund-income", error);
      }
    }

    return {
      status: days > 0 ? "accrued" : "skipped",
      wallets: wallets.length,
      days,
      totalIncome,
      fromDate,
      toDate,
      truncated,
      pendingFrom,
      removed,
      reason: days === 0 ? (pendingFrom ? "yield data unavailable" : "nothing to accrue") : undefined,
    };
  }, () => ({ ...EMPTY, reason: "busy" }));
}

/**
 * 换绑/解绑后清掉本钱包的收益流水（可选：`rebuild` 已经覆盖，这个给「换基金代码」用）。
 *
 * 换基金时旧基金的收益是真实到账的钱，**不能删**；只有同一只基金重算才清。
 * 因此这里只在 `fundCode` 明确时删除同代码的结转行。
 */
export async function clearWalletMoneyFundIncome(walletAccountId: string, fundCode: string): Promise<number> {
  const deleted = await prisma.txRecord.deleteMany({
    where: {
      accountId: walletAccountId,
      source: TRANSACTION_SOURCE_MONEY_INCOME,
      fundCode,
    },
  });
  return deleted.count;
}

/** 供明细/表单判断：该钱包是否走「直接挂代码」的轻量计息。 */
export function isWalletDirectMoneyFund(account: {
  kind?: string | null;
  linkedFundCode?: string | null;
  linkedFundStartDate?: Date | null;
} | null | undefined): boolean {
  if (!account) return false;
  if (String(account.kind ?? "").trim() !== "ewallet") return false;
  return Boolean(String(account.linkedFundCode ?? "").trim()) && Boolean(account.linkedFundStartDate);
}
