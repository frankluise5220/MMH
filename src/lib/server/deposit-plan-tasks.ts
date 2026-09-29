import { IntervalUnit, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  depositPayoutAnchorUtc,
  depositPayoutMaxPeriods,
  isPeriodicDepositInterestPayout,
  parseDepositInterestPayout,
} from "@/lib/deposit-interest-payout";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, type ScheduledTaskPayload } from "@/lib/scheduled-task";
import { loadDepositLotBalance } from "@/lib/server/deposit-lot-balance";

/**
 * Refresh both system plans after a deposit redemption. Partial redemption
 * keeps both plans active with the remaining principal; full redemption
 * completes both plans.
 */
export async function completeDepositPlansForLot(params: {
  householdId: string;
  lotId: string;
}): Promise<void> {
  // This path is used only after the source lot itself has been deleted. Do
  // not load the balance here: a transient read failure must not be treated
  // as a settled lot and it would also make a deleted lot impossible to mark
  // complete because its balance row is intentionally unavailable.
  await prisma.regularInvestPlan.updateMany({
    where: {
      householdId: params.householdId,
      id: { in: [`depm_${params.lotId}`, `depi_${params.lotId}`] },
    },
    data: { status: RegularInvestStatus.completed },
  });
}

/** 该计划类型是否由存款计划执行器处理。 */
export function isDepositPlanTask(type: string | null | undefined): boolean {
  return type === "deposit_maturity" || type === "deposit_interest_payout";
}

/**
 * Startup self-healing fills and refreshes system plans for held deposit lots.
 * Both maturity and payout plans depend on the lot's current principal, so
 * each run synchronizes their amount and status.
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
  const payoutPlansByLotId = new Map(
    existing
      .filter((row) => row.id.startsWith("depi_"))
      .map((row) => {
        const task = decodeScheduledTaskMemo(row.memo);
        const lotId = task.depositSourceEntryId || row.id.slice(5);
        return [lotId, row.id] as const;
      })
      .filter((item): item is [string, string] => Boolean(item[0])),
  );
  if (payoutPlansByLotId.size > 0) {
    const linkedRows = await prisma.txRecord.findMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        source: "deposit",
        type: { in: ["income", "transfer"] },
        depositSourceEntryId: { in: [...payoutPlansByLotId.keys()] },
      },
      select: { id: true, depositSourceEntryId: true, regularInvestPlanId: true },
    });
    const adoptIdsByPlanId = new Map<string, string[]>();
    for (const row of linkedRows) {
      const planId = row.depositSourceEntryId ? payoutPlansByLotId.get(row.depositSourceEntryId) : null;
      if (!planId || row.regularInvestPlanId === planId) continue;
      const ids = adoptIdsByPlanId.get(planId);
      if (ids) ids.push(row.id);
      else adoptIdsByPlanId.set(planId, [row.id]);
    }
    await Promise.all([...adoptIdsByPlanId].map(([planId, ids]) =>
      prisma.txRecord.updateMany({ where: { id: { in: ids } }, data: { regularInvestPlanId: planId } }),
    ));
  }
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
    // 不跳过「缺日期」的存单：要素不全的存单虽然建不出计划行，但**已结清**的存单
    // 必须在这里被收尾（ensureDepositPlansForLot 内部先判结清、再校验日期）。
    const needsRefresh = !!lot.depositMaturityAction
      || isPeriodicDepositInterestPayout(lot.depositInterestPayoutFrequency)
      || !existingIds.has(`depm_${lot.id}`)
      || !existingIds.has(`depi_${lot.id}`)
      || (!lot.depositMaturityAction && existingIds.has(`depm_${lot.id}`))
      || staleLinkedIds.has(`depm_${lot.id}`)
      || staleLinkedIds.has(`depi_${lot.id}`);
    if (!needsRefresh) continue;
    const result = await ensureDepositPlansForLot({ householdId: params.householdId, lotId: lot.id }).catch(() => null);
    if (result) created += 1;
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
  // 本金已取完（提前支取/到期取回/核销）→ 两条计划行一并完成，绝不再生成利息。
  // 这一步必须在下面的日期/账户校验**之前**：存单要素不全（缺到期日、缺资金来源
  // 账户）时那些校验会抛错，而调用方一律 catch 掉 —— 结果就是已结清的存单计划
  // 永远停不下来（2026-09-29 honker 报的「本金取完了还在跑取息任务」）。
  const settled = await loadDepositLotBalance({ householdId, lotId: buy.id });
  if (!settled || settled.settled) {
    await completeDepositPlansForLot({ householdId, lotId: buy.id });
    return { maturityPlanId: null, payoutPlanId: null };
  }
  const maturity = buy.fundArrivalDate;
  if (!maturity || !buy.date) throw new Error("LOT_MISSING_DATES");

  const depositAccount = buy.toAccountId;
  const cashAccount = buy.accountId;
  if (!depositAccount || !cashAccount) throw new Error("LOT_MISSING_ACCOUNTS");
  const lotBalance = settled;
  const remainingPrincipal = lotBalance.remainingPrincipal;
  const label = buy.fundName ?? "存款";
  const start = buy.date;

  // 到这里存单一定还有剩余本金（已结清的在上面提前返回），所以下面两条计划行
  // 一律 active；本金取完时由上面的提前返回把两行置 completed。
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
      amount: remainingPrincipal,
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
      amount: remainingPrincipal,
      status: RegularInvestStatus.active,
      memo: maturityMemo,
    },
  }) : null;
  if (!buy.depositMaturityAction) {
    await prisma.regularInvestPlan.updateMany({
      where: { id: `depm_${buy.id}`, householdId, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    });
  }

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
        amount: remainingPrincipal,
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
        amount: remainingPrincipal,
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

/** 严格晚于 `after` 的第一个付息锚点（对应日口径，见 depositPayoutAnchorUtc）。 */
function nextPayoutDateUtc(
  startDate: Date,
  frequency: { unit: "week" | "month" | "year"; interval: number },
  after: Date,
): Date {
  const maxPeriods = depositPayoutMaxPeriods(frequency);
  // periods 是「期数」；depositPayoutAnchorUtc 内部再乘 interval。
  for (let periods = 1; periods <= maxPeriods; periods++) {
    const date = depositPayoutAnchorUtc(startDate, frequency, periods);
    if (date.getTime() > after.getTime()) return date;
  }
  // 兜底（超过 80 年仍未匹配）：从 after 起推进一个完整周期。
  return depositPayoutAnchorUtc(after, frequency, 1);
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
    const balance = await loadDepositLotBalance({ householdId, lotId });
    const fresh = await prisma.txRecord.findUnique({
      where: { id: lotId },
      select: { fundArrivalDate: true, deletedAt: true },
    });
    await prisma.regularInvestPlan.update({
      where: { id: plan.id },
      data: !balance || balance.settled || !fresh || fresh.deletedAt
        ? { status: RegularInvestStatus.completed }
        // 续存滚动后 startDate 同步新到期日，与 nextRunDate 保持一致。
        : {
            startDate: fresh.fundArrivalDate ?? plan.startDate,
            nextRunDate: fresh.fundArrivalDate ?? plan.nextRunDate,
            amount: balance.remainingPrincipal,
            status: RegularInvestStatus.active,
          },
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
  // 存单本金已取完（提前支取 / 到期取回 / 核销）→ 取息计划就此终结：绝不能继续
  // 挂在「执行中」上每轮空跑（2026-09-29 honker 报的问题）。这里兜住所有「取回
  // 记录没能触发计划收尾」的历史路径（存单要素不全、旧版本写入、导入数据等）。
  const balanceAfter = await loadDepositLotBalance({ householdId, lotId });
  if (!balanceAfter || balanceAfter.settled) {
    await prisma.regularInvestPlan.update({
      where: { id: plan.id },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
    return {
      executed: (outcome.pairs ?? 0) > 0,
      pairs: outcome.pairs ?? 0,
      message: (outcome.pairs ?? 0) > 0
        ? `已生成 ${outcome.pairs} 期利息，存单本金已取完 → 取息计划已结束`
        : "存单本金已取完 → 取息计划已结束",
    };
  }
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

