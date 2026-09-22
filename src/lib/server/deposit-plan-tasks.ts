import { IntervalUnit, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { isPeriodicDepositInterestPayout, parseDepositInterestPayout, depositPayoutAnchorUtc } from "@/lib/deposit-interest-payout";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, type ScheduledTaskPayload } from "@/lib/scheduled-task";

/**
 * 存单取回（redeem/switch_out）时结束该存单的系统计划任务：
 * 「存款到期」与「存款取息」两条计划一并标记完成，不再有任何下次执行日。
 */
export async function completeDepositPlansForLot(params: {
  householdId: string;
  lotId: string;
}): Promise<void> {
  await prisma.regularInvestPlan.updateMany({
    where: {
      householdId: params.householdId,
      id: { in: [`depm_${params.lotId}`, `depi_${params.lotId}`] },
      status: { not: RegularInvestStatus.completed },
    },
    data: { status: RegularInvestStatus.completed },
  }).catch(() => {});
}

/** 该计划类型是否由存款计划执行器处理。 */
export function isDepositPlanTask(type: string | null | undefined): boolean {
  return type === "deposit_maturity" || type === "deposit_interest_payout";
}

/**
 * 开机自愈：为所有持有中的存单补齐缺的系统计划行（老数据/历史导入可能没有）。
 * 只对缺少计划行的存单做 upsert，避免每次开机无谓写库。
 */
export async function ensureDepositPlansForHeldLots(params: {
  householdId: string;
}): Promise<number> {
  const lots = await prisma.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
    },
    select: {
      id: true,
      date: true,
      fundArrivalDate: true,
      depositMaturityAction: true,
      depositInterestPayoutFrequency: true,
    },
  });
  if (lots.length === 0) return 0;
  const ids = lots.map((lot) => lot.id);
  const existing = await prisma.regularInvestPlan.findMany({
    where: {
      householdId: params.householdId,
      id: { in: [...ids.map((id) => `depm_${id}`), ...ids.map((id) => `depi_${id}`)] },
    },
    select: { id: true, memo: true },
  });
  const existingIds = new Set(existing.map((row) => row.id));
  // 老计划行可能缺少存单关联（memo 里没有 depositSourceEntryId）→ 一并刷新。
  const staleLinkedIds = new Set(
    existing
      .filter((row) => {
        const task = decodeScheduledTaskMemo(row.memo);
        return !task.depositSourceEntryId;
      })
      .map((row) => row.id),
  );
  let created = 0;
  for (const lot of lots) {
    const needsMaturity = !!lot.depositMaturityAction && !!lot.fundArrivalDate
      && (!existingIds.has(`depm_${lot.id}`) || staleLinkedIds.has(`depm_${lot.id}`));
    const needPayout = isPeriodicDepositInterestPayout(lot.depositInterestPayoutFrequency)
      && (!existingIds.has(`depi_${lot.id}`) || staleLinkedIds.has(`depi_${lot.id}`));
    if (!needsMaturity && !needPayout) continue;
    if (!lot.date || !lot.fundArrivalDate) continue;
    await ensureDepositPlansForLot({ householdId: params.householdId, lotId: lot.id }).catch(() => {});
    created += 1;
  }
  return created;
}

export const DEPOSIT_MATURITY_PLAN_FUND_CODE = "deposit_maturity";
export const DEPOSIT_PAYOUT_PLAN_FUND_CODE = "deposit_interest_payout";

/**
 * System-plan wiring for deposits, mirroring 理财产品/贷款: every held lot gets
 * two RegularInvestPlan rows keyed by the lot id —
 *   1. deposit_maturity: fires on the lot's maturity date, executing the lot's
 *      stored maturity action (取回 / 续存本金 / 续存本息).
 *   2. deposit_interest_payout (periodic lots only): fires on each payout
 *      anchor date, generating the 利息收入 + 转账 pair.
 * Both rows loop: after each execution the runner recomputes the next run
 * (maturity rolls forward on renewal; payout advances to the next anchor) and
 * keeps cycling while the next date stays within the same day or earlier —
 * i.e. until the next execution date is strictly in the future.
 */
export async function ensureDepositPlansForLot(params: {
  householdId: string;
  lotId: string;
}): Promise<{ maturityPlanId: string | null; payoutPlanId: string | null }> {
  const { householdId, lotId } = params;
  const buy = await prisma.txRecord.findFirst({
    where: {
      id: lotId,
      householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
    },
  });
  if (!buy) throw new Error("LOT_NOT_FOUND");
  const maturity = buy.fundArrivalDate;
  if (!maturity || !buy.date) throw new Error("LOT_MISSING_DATES");

  const depositAccount = buy.toAccountId;
  const cashAccount = buy.accountId;
  if (!depositAccount || !cashAccount) throw new Error("LOT_MISSING_ACCOUNTS");
  const label = buy.fundName ?? "存款";
  const start = buy.date;

  // ── Maturity plan: one-shot on the maturity date; renewed lots roll the
  // date forward when the maturity action executes. 没有设置到期行为的存单
  // 不建这条计划（无事可做），避免开机每轮空跑。
  const maturityMemo = encodeScheduledTaskMemo({
    type: "deposit_maturity",
    title: `存款到期：${label}`,
    toAccountId: depositAccount,
    fromAccountId: cashAccount,
    depositSourceEntryId: buy.id,
    note: buy.depositMaturityAction ?? "redeem",
  });
  const maturityPlan = buy.depositMaturityAction ? await prisma.regularInvestPlan.upsert({
    where: { id: `depm_${buy.id}` },
    create: {
      id: `depm_${buy.id}`,
      accountId: depositAccount,
      accountName: label,
      cashAccountId: cashAccount,
      cashAccountName: null,
      fundCode: DEPOSIT_MATURITY_PLAN_FUND_CODE,
      fundName: label,
      fundProductType: "deposit",
      amount: Math.abs(Number(buy.amount ?? 0)),
      intervalUnit: IntervalUnit.month,
      intervalValue: 1,
      executionDay: maturity.getUTCDate(),
      startDate: maturity,
      nextRunDate: maturity,
      endDate: null,
      totalRuns: 1,
      status: RegularInvestStatus.active,
      feeRate: 0,
      confirmDays: 0,
      arrivalDays: 0,
      memo: maturityMemo,
      skipPendingPreceding: false,
      householdId,
    },
    update: {
      // startDate 与 nextRunDate 同步为当前到期日：存单编辑（起存日/期限）
      // 后计划行不残留创建时刻的旧到期日快照，避免「开始日期」晚于「下次执行日」。
      startDate: maturity,
      nextRunDate: maturity,
      // 金额跟随存单当前本金（到期执行金额按 lot 实时计算，这里只保证列表显示一致）。
      amount: Math.abs(Number(buy.amount ?? 0)),
      status: RegularInvestStatus.active,
      memo: maturityMemo,
    },
  }) : null;

  // ── Payout plan: only for periodic-payout lots. Anchor dates follow the
  // deposit start (day-of-month), interval from the stored frequency.
  const frequency = parseDepositInterestPayout(buy.depositInterestPayoutFrequency);
  let payoutPlanId: string | null = null;
  if (frequency.kind === "periodic") {
    const anchor = startDateAnchorUtc(start);
    const intervalUnit = frequency.unit === "month" ? IntervalUnit.month : IntervalUnit.week;
    const intervalValue = frequency.unit === "month"
      ? frequency.interval
      : frequency.unit === "week" ? frequency.interval : 0;
    const payoutMemo = encodeScheduledTaskMemo({
      type: "deposit_interest_payout",
      title: `存款取息：${label}`,
      toAccountId: depositAccount,
      fromAccountId: cashAccount,
      depositSourceEntryId: buy.id,
    });
    // nextRunDate = the first anchor date strictly after the last payout
    // (fundConfirmDate slot), so renewals/paid dates are never re-run.
    const nextRun = nextPayoutDateUtc(start, frequency, buy.fundConfirmDate ?? new Date(start.getTime() - 86400000));
    const payoutPlan = await prisma.regularInvestPlan.upsert({
      create: {
        id: `depi_${buy.id}`,
        accountId: depositAccount,
        accountName: label,
        cashAccountId: cashAccount,
        cashAccountName: null,
        fundCode: DEPOSIT_PAYOUT_PLAN_FUND_CODE,
        fundName: label,
        fundProductType: "deposit",
        amount: Math.abs(Number(buy.amount ?? 0)),
        intervalUnit,
        intervalValue: Math.max(1, intervalValue || 1),
        executionDay: anchor.getUTCDate(),
        startDate: start,
        nextRunDate: nextRun,
        endDate: null,
        totalRuns: null,
        status: RegularInvestStatus.active,
        feeRate: 0,
        confirmDays: 0,
        arrivalDays: 0,
        memo: payoutMemo,
        skipPendingPreceding: false,
        householdId,
      },
      update: {
        // 同步锚点起点：存单起存日被编辑后，取息计划的 startDate 跟随当前
        // 起存日，避免残留创建时的旧快照。
        startDate: start,
        nextRunDate: nextRun,
        status: RegularInvestStatus.active,
        memo: payoutMemo,
        amount: Math.abs(Number(buy.amount ?? 0)),
      },
      where: { id: `depi_${buy.id}` },
    });
    payoutPlanId = payoutPlan.id;
  } else {
    // 取息频率为「到期取息」（含用户从周期取息改过来）→ 取息计划失去对象，
    // 标记完成以免残留「执行中」空挂；之后改回周期时上面的 upsert update
    // 会把它重新激活。
    await prisma.regularInvestPlan.updateMany({
      where: { id: `depi_${buy.id}`, householdId, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
  }

  return { maturityPlanId: maturityPlan?.id ?? null, payoutPlanId };
}

function startDateAnchorUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** First anchor date strictly after `after` (exclusive), one day before the bank anchor day. */
function nextPayoutDateUtc(
  startDate: Date,
  frequency: { unit: "week" | "month" | "year"; interval: number },
  after: Date,
): Date {
  if (frequency.unit === "month") {
    // periods is a count; depositPayoutAnchorUtc multiplies it by interval internally.
    for (let periods = 1; periods * frequency.interval < 12 * 80; periods++) {
      const date = depositPayoutAnchorUtc(startDate, frequency, periods);
      if (date.getTime() > after.getTime()) return date;
    }
    // Extreme fallback after 80 years without a match: advance one full period from after.
    return depositPayoutAnchorUtc(after, frequency, 1);
  }
  const stepDays = frequency.unit === "week" ? 7 * frequency.interval : 365 * frequency.interval;
  const elapsed = Math.floor((after.getTime() - startDate.getTime()) / 86400000);
  // periods is a count, not a unit count; depositPayoutAnchorUtc multiplies it by interval.
  let periods = Math.max(1, Math.ceil((elapsed + 1) / stepDays));
  let date = depositPayoutAnchorUtc(startDate, frequency, periods);
  // Match the monthly branch: the anchor must be strictly after `after`; an exact
  // match advances to the next period.
  while (date.getTime() <= after.getTime()) {
    periods += 1;
    date = depositPayoutAnchorUtc(startDate, frequency, periods);
  }
  return date;
}

export type DepositPlanExecutionResult = {
  executed: boolean;
  pairs: number;
  message: string;
};

/**
 * Run one due deposit plan row (存款到期 or 存款取息). The heavy lifting is
 * delegated to the shared lot processors (autoRedeemDeposit /
 * autoRenewDeposit / autoAccruePeriodicInterest logic inlined via the plan
 * runner), and afterwards the plan loops: the next run date is recomputed and
 * the row keeps executing while the next date is still <= today, stopping
 * once the next execution date lands in the future.
 */
export async function executeDepositPlan(params: {
  householdId: string;
  plan: { id: string; memo: string | null; startDate: Date; nextRunDate: Date; accountId: string };
  task: ScheduledTaskPayload;
  now: Date;
}): Promise<DepositPlanExecutionResult> {
  const { householdId, plan, task, now } = params;
  // 存单 id 优先取 memo 里的关联；老计划行没有该字段时，从计划 id 反推
  // （depm_<lotId> / depi_<lotId>），避免历史数据被跳过。
  const lotId = task.depositSourceEntryId
    || ((plan.id.startsWith("depm_") || plan.id.startsWith("depi_")) ? plan.id.slice(5) : "");
  if (!lotId) return { executed: false, pairs: 0, message: "计划缺少存单关联" };

  if (task.type === "deposit_maturity") {
    const { processDepositMaturityForLot } = await import("@/lib/server/deposit-auto-maturity");
    const outcome = await processDepositMaturityForLot({ householdId, lotId, now });
    // 到期计划推进：取回 → 计划完成；续存 → 下次执行日滚动到新到期日。
    const closed = await prisma.txRecord.findFirst({
      where: {
        householdId,
        deletedAt: null,
        depositSourceEntryId: lotId,
        fundSubtype: { in: ["redeem", "switch_out"] },
      },
      select: { id: true },
    });
    const fresh = await prisma.txRecord.findUnique({
      where: { id: lotId },
      select: { fundArrivalDate: true, deletedAt: true },
    });
    await prisma.regularInvestPlan.update({
      where: { id: plan.id },
      data: closed || !fresh || fresh.deletedAt
        ? { status: RegularInvestStatus.completed }
        // 续存滚动后 startDate 同步新到期日，与 nextRunDate 保持一致。
        : { startDate: fresh.fundArrivalDate ?? plan.startDate, nextRunDate: fresh.fundArrivalDate ?? plan.nextRunDate },
    }).catch(() => {});
    return {
      executed: outcome.status === "redeemed" || outcome.status === "renewed",
      pairs: outcome.status === "renewed" ? outcome.rounds ?? 0 : outcome.status === "redeemed" ? 1 : 0,
      message: outcome.status === "redeemed"
        ? "已按到期行为取回"
        : outcome.status === "renewed"
          ? `已续存 ${outcome.rounds ?? 0} 期`
          : `未执行（${outcome.reason ?? "无待处理"}）`,
    };
  }

  // 存款取息：只处理本计划关联的存单；「是否转账」由计划决定。
  const { autoAccruePeriodicInterestForLot } = await import("@/lib/server/deposit-auto-maturity");
  const withTransfer = task.payoutTransfer !== false;
  const outcome = await autoAccruePeriodicInterestForLot({
    householdId,
    lotId,
    now,
    createTransfer: withTransfer,
    // 生成的利息记录带上本计划任务 id —— 「没有关联 id 的就是没生成过」，
    // 下次执行会从最早日期重算并顺带认领（写回）无关联的旧记录。
    planId: plan.id,
  });
  // 下一执行日 = 严格晚于最近结息日的下一个锚定日。若它仍 ≤ 今天，外层
  // 运行器会在下一轮继续执行（追补历史缺期），直到落在未来为止。
  const fresh = await prisma.txRecord.findUnique({
    where: { id: lotId },
    select: {
      date: true,
      fundConfirmDate: true,
      depositInterestPayoutFrequency: true,
      fundArrivalDate: true,
      deletedAt: true,
    },
  });
  if (fresh && !fresh.deletedAt && fresh.date) {
    const frequency = parseDepositInterestPayout(fresh.depositInterestPayoutFrequency);
    if (frequency.kind === "periodic") {
      const anchorAfter = fresh.fundConfirmDate ?? new Date(fresh.date.getTime() - 86400000);
      const maturityCap = fresh.fundArrivalDate && fresh.fundArrivalDate <= now ? fresh.fundArrivalDate : null;
      const candidate = nextPayoutDateUtc(fresh.date, frequency, anchorAfter);
      // 已到期（maturity ≤ 今天）的存单：利息只到到期日，取息计划就此完成，
      // 后续由「存款到期」计划负责取回 —— 避免每轮开机都空跑这个计划。
      const nextRunDate = maturityCap && candidate > maturityCap ? maturityCap : candidate;
      await prisma.regularInvestPlan.update({
        where: { id: plan.id },
        data: maturityCap
          ? { nextRunDate, status: RegularInvestStatus.completed }
          // 存单起存日被编辑后，取息计划的锚点起点（startDate）一并同步。
          : { startDate: fresh.date ?? plan.startDate, nextRunDate },
      }).catch(() => {});
    }
  }
  return {
    executed: (outcome.pairs ?? 0) > 0,
    pairs: outcome.pairs ?? 0,
    message: outcome.status === "accrued"
      ? `已生成 ${outcome.pairs} 期利息${withTransfer ? "（收入+转账）" : "（不转账）"}`
      : outcome.reason ?? "无需生成",
  };
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
