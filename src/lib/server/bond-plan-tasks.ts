import { IntervalUnit, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { bondPlanInterval, bondPayoutExpectation, bondDateKey } from "@/lib/wealth-bond";
import { parseDepositInterestPayout } from "@/lib/deposit-interest-payout";
import { encodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { toNumber } from "@/lib/date-utils";

export const WEALTH_BOND_MATURITY_PLAN_FUND_CODE = "wealth_bond_maturity";
export const WEALTH_BOND_PAYOUT_PLAN_FUND_CODE = "wealth_bond_interest_payout";

/** 城投债的两类计划行 fundCode —— 执行器只读跳过、不自动落账。 */
export function isWealthBondPlanFundCode(code: string | null | undefined): boolean {
  return code === WEALTH_BOND_MATURITY_PLAN_FUND_CODE || code === WEALTH_BOND_PAYOUT_PLAN_FUND_CODE;
}

function payoutMemoText(name: string) {
  return encodeScheduledTaskMemo({
    type: "wealth_bond_interest_payout",
    title: `城投债付息：${name}`,
  });
}

/** 城投债债单的计划行：债单（WealthProduct）= 唯一真源，行随条款/到账刷新。 */
export type BondPlanSource = {
  id: string;
  householdId: string;
  name: string;
  annualRate: number | null;
  termDays: number | null;
  maturityDate: Date | null;
  payoutFrequency: string | null;
  firstPayoutDate: Date | null;
  productType: string;
};

async function loadBondPlanSource(householdId: string, productId: string): Promise<BondPlanSource | null> {
  const product = await prisma.wealthProduct.findFirst({
    where: { id: productId, householdId },
  });
  if (!product || product.productType !== "bond") return null;
  return {
    id: product.id,
    householdId: product.householdId,
    name: product.name,
    annualRate: product.annualRate == null ? null : Number(product.annualRate),
    termDays: product.termDays,
    maturityDate: product.maturityDate,
    payoutFrequency: product.payoutFrequency,
    firstPayoutDate: product.firstPayoutDate,
    productType: product.productType,
  };
}

/** 债单当前持仓本金（城投债无份额）：Σ买入 − Σ赎回 − Σ核销。 */
async function bondPrincipalCost(householdId: string, productId: string): Promise<number> {
  const rows = await prisma.wealthTransaction.groupBy({
    by: ["action"],
    where: { householdId, wealthProductId: productId, deletedAt: null },
    _sum: { grossAmount: true },
  });
  let cost = 0;
  for (const row of rows) {
    const amount = Math.abs(toNumber(row._sum.grossAmount));
    if (row.action === "buy") cost += amount;
    else if (row.action === "redeem" || row.action === "switch_out" || row.action === "write_off") cost -= amount;
  }
  return Math.max(0, Number(cost.toFixed(2)));
}

/**
 * 债单=计划行唯一真源（对齐存款口径）：每张 bond 债单 upsert 两行只读计划行——
 *   1. bondm_<productId> 城投债到期：nextRunDate=maturityDate，amount=当前持仓本金；
 *   2. bondi_<productId> 城投债付息：nextRunDate=下一预期付息日（严格晚于最近到账日），
 *      amount=该期估算利息（本金×票面×周期天数/365）。
 * 计划行永不自动执行（到账时间/金额不确定，必须手工确认）；债单编辑、利息到账、
 * 核销、赎回后由落账路径调用本函数刷新。持仓清零 → 两行一并完成。
 */
export async function ensureWealthBondPlansForProduct(params: {
  householdId: string;
  productId: string;
}): Promise<void> {
  const source = await loadBondPlanSource(params.householdId, params.productId);
  if (!source) return;

  const planIds = [`bondm_${source.id}`, `bondi_${source.id}`];
  const cost = await bondPrincipalCost(params.householdId, source.id);

  // 债单已了结（全部收回/核销，且不再有买入）：计划行完成，避免空挂。
  if (cost <= 0.005) {
    await prisma.regularInvestPlan.updateMany({
      where: { householdId: params.householdId, id: { in: planIds }, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
    return;
  }

  const maturity = source.maturityDate ?? null;
  const frequency = parseDepositInterestPayout(source.payoutFrequency);
  // 下一预期付息日锚点：严格晚于最近一次利息到账（无到账记录 → 首次付息日）。
  const lastInterest = await prisma.wealthTransaction.findFirst({
    where: { householdId: params.householdId, wealthProductId: source.id, deletedAt: null, action: "dividend_cash" },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
    select: { tradeDate: true, confirmDate: true },
  });
  const lastPayoutAnchor = lastInterest
    ? (lastInterest.confirmDate ?? lastInterest.tradeDate)
    : null;
  const expectation = bondPayoutExpectation({
    term: source,
    start: source.firstPayoutDate ?? lastPayoutAnchor ?? undefined,
    after: lastPayoutAnchor,
    principal: cost,
  });

  const maturityLabel = `城投债到期：${source.name}`;
  if (maturity) {
    const maturityMemo = encodeScheduledTaskMemo({
      type: "wealth_bond_maturity",
      title: maturityLabel,
    });
    // 城投债计划行挂在 wealth 账户上（bond 产品的买入理财账户），供计划页展示归属。
    const ownerAccount = await prisma.wealthTransaction.findFirst({
      where: { householdId: params.householdId, wealthProductId: source.id, deletedAt: null },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
      select: { accountId: true },
    });
    const ownerAccountId = ownerAccount?.accountId ?? "";
    if (!ownerAccountId) return;
    await prisma.regularInvestPlan.upsert({
      where: { id: `bondm_${source.id}` },
      create: {
        id: `bondm_${source.id}`,
        accountId: ownerAccountId,
        accountName: source.name,
        cashAccountId: null,
        cashAccountName: null,
        fundCode: WEALTH_BOND_MATURITY_PLAN_FUND_CODE,
        fundName: source.name,
        fundProductType: "wealth",
        amount: cost,
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
        householdId: params.householdId,
      },
      update: {
        startDate: maturity,
        nextRunDate: maturity,
        amount: cost,
        status: RegularInvestStatus.active,
        memo: maturityMemo,
      },
    }).catch(() => {});
  } else {
    await prisma.regularInvestPlan.updateMany({
      where: { id: `bondm_${source.id}`, householdId: params.householdId, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
  }

  if (frequency.kind === "periodic" && expectation.nextPayoutDate) {
    const payoutMemo = payoutMemoText(source.name);
    const interval = bondPlanInterval(frequency);
    const nextRun = new Date(`${expectation.nextPayoutDate}T00:00:00.000Z`);
    // 城投债计划行挂在 wealth 账户上（bond 产品的买入理财账户），供计划页展示归属。
    const ownerAccount = await prisma.wealthTransaction.findFirst({
      where: { householdId: params.householdId, wealthProductId: source.id, deletedAt: null },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
      select: { accountId: true },
    });
    const ownerAccountId = ownerAccount?.accountId ?? "";
    if (!ownerAccountId) return;
    await prisma.regularInvestPlan.upsert({
      where: { id: `bondi_${source.id}` },
      create: {
        id: `bondi_${source.id}`,
        accountId: ownerAccountId,
        accountName: source.name,
        cashAccountId: null,
        cashAccountName: null,
        fundCode: WEALTH_BOND_PAYOUT_PLAN_FUND_CODE,
        fundName: source.name,
        fundProductType: "wealth",
        amount: expectation.nextExpectedInterest ?? 0,
        intervalUnit: interval.unit === "week" ? IntervalUnit.week : IntervalUnit.month,
        intervalValue: Math.max(1, interval.value),
        executionDay: new Date(expectation.nextPayoutDate).getUTCDate(),
        startDate: bondDateKey(source.firstPayoutDate) ? new Date(`${bondDateKey(source.firstPayoutDate)}T00:00:00.000Z`) : (lastPayoutAnchor ?? new Date()),
        nextRunDate: nextRun,
        endDate: null,
        totalRuns: null,
        status: RegularInvestStatus.active,
        feeRate: 0,
        confirmDays: 0,
        arrivalDays: 0,
        memo: payoutMemo,
        skipPendingPreceding: false,
        householdId: params.householdId,
      },
      update: {
        nextRunDate: nextRun,
        amount: expectation.nextExpectedInterest ?? 0,
        status: RegularInvestStatus.active,
        fundCode: WEALTH_BOND_PAYOUT_PLAN_FUND_CODE,
        fundName: source.name,
        accountName: source.name,
        memo: payoutMemo,
      },
    }).catch(() => {});
  } else {
    // 到期付息（或无法推算）→ 付息计划行失去对象，完成以免空挂。
    await prisma.regularInvestPlan.updateMany({
      where: { id: `bondi_${source.id}`, householdId: params.householdId, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
  }
}

/** 落账后刷新债单计划行（仅 bond 产品；productId 缺省时忽略）。 */
export async function ensureWealthBondPlansAfterTx(householdId: string, productId?: string | null): Promise<void> {
  const id = String(productId ?? "").trim();
  if (!id) return;
  await ensureWealthBondPlansForProduct({ householdId, productId: id });
}

/** 债单了结（本息全部收回/核销）：结束该债单的系统计划行。 */
export async function completeWealthBondPlansForProduct(params: { householdId: string; productId: string }): Promise<void> {
  await prisma.regularInvestPlan.updateMany({
    where: {
      householdId: params.householdId,
      id: { in: [`bondm_${params.productId}`, `bondi_${params.productId}`] },
      status: { not: RegularInvestStatus.completed },
    },
    data: { status: RegularInvestStatus.completed },
  }).catch(() => {});
}

/**
 * 开机自愈：为所有持有中的城投债补齐/刷新计划行（老数据可能没有）。
 * 每次开机全量 ensure bond 产品（数量少、upsert 幂等）。
 */
export async function ensureWealthBondPlansForHousehold(params: { householdId: string }): Promise<number> {
  const products = await prisma.wealthProduct.findMany({
    where: { householdId: params.householdId, productType: "bond", isActive: true },
    select: { id: true },
  });
  let touched = 0;
  for (const product of products) {
    await ensureWealthBondPlansForProduct({ householdId: params.householdId, productId: product.id }).catch(() => {});
    touched += 1;
  }
  return touched;
}
