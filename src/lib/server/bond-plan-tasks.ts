import { FundSubtype, IntervalUnit, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { bondDateKey, bondPlanInterval, bondPayoutExpectation, clampBondFirstPayoutToStart } from "@/lib/bond";
import { toNumber } from "@/lib/date-utils";
import { parseDepositInterestPayout } from "@/lib/deposit-interest-payout";
import { encodeScheduledTaskMemo } from "@/lib/scheduled-task";

export const BOND_MATURITY_PLAN_FUND_CODE = "bond_maturity";
export const BOND_PAYOUT_PLAN_FUND_CODE = "bond_interest_payout";

/** 债券的两类计划行 fundCode —— 执行器只读跳过、不自动落账。 */
export function isBondPlanFundCode(code: string | null | undefined): boolean {
  return code === BOND_MATURITY_PLAN_FUND_CODE || code === BOND_PAYOUT_PLAN_FUND_CODE;
}

function payoutMemoText(name: string) {
  return encodeScheduledTaskMemo({
    type: "bond_interest_payout",
    title: `债券付息：${name}`,
  });
}

const OPEN_PRINCIPAL_EPSILON = 0.005;
const CLEAR_ACTIONS = new Set<string>([FundSubtype.redeem, FundSubtype.switch_out, FundSubtype.write_off]);

/**
 * 债券计划行按**存单**生成（对齐存款的 depm_/depi_ 口径）。
 *
 * 存单 = 一笔买入行（bond_transactions.action='buy'）。同一债单可以有多张存单，
 * 每张存单有自己的起息日与条款，付息必须按存单各自产生，所以计划行 id 是
 *   bondm_<存单id> / bondi_<存单id>
 * 而不是产品级。
 */
export type BondLotPlanSource = {
  lotId: string;
  householdId: string;
  accountId: string;
  /** 买入时的资金来源账户（付息转入目标）。 */
  cashAccountId: string | null;
  name: string;
  annualRate: number | null;
  termDays: number | null;
  maturityDate: Date | null;
  payoutFrequency: string | null;
  firstPayoutDate: Date | null;
  /** 计息方式：monthly = 月均计息；其他/缺省 = 按日。 */
  interestCalcBasis: string | null;
  startDate: Date;
  principal: number;
  lastPayoutAnchor: Date | null;
};

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

/** 载入存单及其条款（存单快照优先，缺失回退债单主数据）。 */
export async function loadBondLotPlanSource(params: {
  householdId: string;
  lotId: string;
}): Promise<BondLotPlanSource | null> {
  const lot = await prisma.bondTransaction.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      action: FundSubtype.buy,
      deletedAt: null,
    },
    include: { BondProduct: true },
  });
  if (!lot) return null;

  // 该存单的持仓本金 = 买入额 − 子行赎回/核销额。
  const childRows = await prisma.bondTransaction.findMany({
    where: { householdId: params.householdId, sourceBondTransactionId: lot.id, deletedAt: null },
    select: { action: true, grossAmount: true },
  });
  let principal = Math.abs(toNumber(lot.grossAmount));
  for (const row of childRows) {
    if (CLEAR_ACTIONS.has(row.action)) principal -= Math.abs(toNumber(row.grossAmount));
  }

  // 最近一次付息到账锚点（该存单自己的付息记录）。
  const lastInterest = await prisma.bondTransaction.findFirst({
    where: {
      householdId: params.householdId,
      sourceBondTransactionId: lot.id,
      deletedAt: null,
      action: FundSubtype.dividend_cash,
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
    select: { tradeDate: true, confirmDate: true },
  });

  const product = lot.BondProduct;
  const termDays = lot.termDays ?? product?.termDays ?? null;
  const explicitMaturity = lot.maturityDate ?? product?.maturityDate ?? null;
  const maturityDate = explicitMaturity ?? (termDays && termDays > 0 ? addDaysUtc(lot.tradeDate, termDays) : null);
  const payoutFrequency = lot.payoutFrequency ?? product?.payoutFrequency ?? null;
  // 老存单没有条款快照时回退债单主数据，债单的首次付息日可能早于本存单起息日
  // （同一债单里后买的存单尤其明显）→ 顺延到第一个晚于起息日的付息日。
  const firstPayoutDate = clampBondFirstPayoutToStart({
    firstPayoutDate: lot.firstPayoutDate ?? product?.firstPayoutDate ?? null,
    startDate: lot.tradeDate,
    payoutFrequency,
  });

  return {
    lotId: lot.id,
    householdId: lot.householdId,
    accountId: lot.accountId,
    cashAccountId: lot.cashAccountId ?? null,
    name: product?.name ?? lot.productName ?? "债券",
    annualRate: lot.annualRate != null
      ? Number(lot.annualRate)
      : product?.annualRate == null ? null : Number(product.annualRate),
    termDays,
    maturityDate,
    payoutFrequency,
    firstPayoutDate,
    interestCalcBasis: lot.interestCalcBasis ?? product?.interestCalcBasis ?? null,
    startDate: lot.tradeDate,
    principal: Math.max(0, Number(principal.toFixed(2))),
    lastPayoutAnchor: lastInterest ? (lastInterest.confirmDate ?? lastInterest.tradeDate) : null,
  };
}

/**
 * 存单 = 计划行唯一真源：每张存单 upsert 两行只读计划行——
 *   1. bondm_<存单id> 债券到期：nextRunDate=到期日，amount=该存单持仓本金；
 *   2. bondi_<存单id> 债券付息：nextRunDate=该存单下一预期付息日，amount=该期估算利息。
 * 计划行永不自动执行（到账时间/金额不确定，必须手工确认）；买入、付息、赎回、
 * 核销后由落账路径调用本函数刷新。存单本金清零 → 两行一并完成。
 */
export async function ensureBondPlansForLot(params: {
  householdId: string;
  lotId: string;
}): Promise<{ maturityPlanId: string | null; payoutPlanId: string | null }> {
  const source = await loadBondLotPlanSource(params);
  if (!source) {
    await completeBondPlansForLot(params);
    return { maturityPlanId: null, payoutPlanId: null };
  }

  // 存单已了结（本金收回/核销完）→ 计划行完成，避免空挂。
  if (source.principal <= OPEN_PRINCIPAL_EPSILON) {
    await completeBondPlansForLot(params);
    return { maturityPlanId: null, payoutPlanId: null };
  }

  const maturity = source.maturityDate;
  const frequency = parseDepositInterestPayout(source.payoutFrequency);
  const expectation = bondPayoutExpectation({
    term: {
      annualRate: source.annualRate,
      termDays: source.termDays,
      maturityDate: source.maturityDate,
      payoutFrequency: source.payoutFrequency,
      firstPayoutDate: source.firstPayoutDate,
      interestCalcBasis: source.interestCalcBasis,
    },
    start: source.firstPayoutDate ?? source.lastPayoutAnchor ?? source.startDate,
    after: source.lastPayoutAnchor,
    principal: source.principal,
  });

  let maturityPlanId: string | null = null;
  if (maturity) {
    const maturityMemo = encodeScheduledTaskMemo({
      type: "bond_maturity",
      title: `债券到期：${source.name}`,
    });
    await prisma.regularInvestPlan.upsert({
      where: { id: `bondm_${source.lotId}` },
      create: {
        id: `bondm_${source.lotId}`,
        accountId: source.accountId,
        accountName: source.name,
        cashAccountId: null,
        cashAccountName: null,
        fundCode: BOND_MATURITY_PLAN_FUND_CODE,
        fundName: source.name,
        fundProductType: "bond",
        amount: source.principal,
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
        householdId: source.householdId,
      },
      update: {
        accountId: source.accountId,
        accountName: source.name,
        startDate: maturity,
        nextRunDate: maturity,
        amount: source.principal,
        status: RegularInvestStatus.active,
        memo: maturityMemo,
      },
    }).catch(() => {});
    maturityPlanId = `bondm_${source.lotId}`;
  } else {
    await prisma.regularInvestPlan.updateMany({
      where: { id: `bondm_${source.lotId}`, householdId: source.householdId, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
  }

  let payoutPlanId: string | null = null;
  if (frequency.kind === "periodic" && expectation.nextPayoutDate) {
    const payoutMemo = payoutMemoText(source.name);
    const interval = bondPlanInterval(frequency);
    const nextRun = new Date(`${expectation.nextPayoutDate}T00:00:00.000Z`);
    const firstKey = bondDateKey(source.firstPayoutDate);
    await prisma.regularInvestPlan.upsert({
      where: { id: `bondi_${source.lotId}` },
      create: {
        id: `bondi_${source.lotId}`,
        accountId: source.accountId,
        accountName: source.name,
        cashAccountId: null,
        cashAccountName: null,
        fundCode: BOND_PAYOUT_PLAN_FUND_CODE,
        fundName: source.name,
        fundProductType: "bond",
        amount: expectation.nextExpectedInterest ?? 0,
        intervalUnit: interval.unit === "week" ? IntervalUnit.week : IntervalUnit.month,
        intervalValue: Math.max(1, interval.value),
        executionDay: new Date(expectation.nextPayoutDate).getUTCDate(),
        startDate: firstKey ? new Date(`${firstKey}T00:00:00.000Z`) : (source.lastPayoutAnchor ?? source.startDate),
        nextRunDate: nextRun,
        endDate: null,
        totalRuns: null,
        status: RegularInvestStatus.active,
        feeRate: 0,
        confirmDays: 0,
        arrivalDays: 0,
        memo: payoutMemo,
        skipPendingPreceding: false,
        householdId: source.householdId,
      },
      update: {
        accountId: source.accountId,
        accountName: source.name,
        nextRunDate: nextRun,
        amount: expectation.nextExpectedInterest ?? 0,
        status: RegularInvestStatus.active,
        fundCode: BOND_PAYOUT_PLAN_FUND_CODE,
        fundName: source.name,
        memo: payoutMemo,
      },
    }).catch(() => {});
    payoutPlanId = `bondi_${source.lotId}`;
  } else {
    // 到期付息（或无法推算）→ 付息计划行失去对象，完成以免空挂。
    await prisma.regularInvestPlan.updateMany({
      where: { id: `bondi_${source.lotId}`, householdId: source.householdId, status: { not: RegularInvestStatus.completed } },
      data: { status: RegularInvestStatus.completed },
    }).catch(() => {});
  }

  return { maturityPlanId, payoutPlanId };
}

/** 存单了结 / 被删除：结束该存单的系统计划行。 */
export async function completeBondPlansForLot(params: {
  householdId: string;
  lotId: string;
}): Promise<void> {
  await prisma.regularInvestPlan.updateMany({
    where: {
      householdId: params.householdId,
      id: { in: [`bondm_${params.lotId}`, `bondi_${params.lotId}`] },
      status: { not: RegularInvestStatus.completed },
    },
    data: { status: RegularInvestStatus.completed },
  }).catch(() => {});
}

/** 刷新某债单下全部存单的计划行（债单条款卡编辑后调用）。 */
export async function ensureBondPlansForProduct(params: {
  householdId: string;
  productId: string;
}): Promise<number> {
  const lots = await prisma.bondTransaction.findMany({
    where: {
      householdId: params.householdId,
      bondProductId: params.productId,
      action: FundSubtype.buy,
      deletedAt: null,
    },
    select: { id: true },
  });
  for (const lot of lots) {
    await ensureBondPlansForLot({ householdId: params.householdId, lotId: lot.id }).catch(() => {});
  }
  return lots.length;
}

/**
 * 清理旧的产品级计划行（bondm_/bondi_<productId>）。
 *
 * 存单化之前计划行挂在债单（BondProduct）上；现在必须挂存单（bond_transactions.id）。
 * 残留的产品级行会变成孤儿（后缀不是任何存单 id），在计划任务页表现为「关联不上」，
 * 所以开机自愈时一并清掉。只删后缀不是存单 id 的行，绝不碰存单级行。
 */
async function purgeLegacyProductLevelBondPlans(householdId: string): Promise<number> {
  const rows = await prisma.regularInvestPlan.findMany({
    where: {
      householdId,
      OR: [{ id: { startsWith: "bondm_" } }, { id: { startsWith: "bondi_" } }],
    },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  const suffixes = [...new Set(rows.map((row) => row.id.slice(6)))];
  const lots = await prisma.bondTransaction.findMany({
    where: { id: { in: suffixes } },
    select: { id: true },
  });
  const lotIds = new Set(lots.map((lot) => lot.id));
  const orphanIds = rows.filter((row) => !lotIds.has(row.id.slice(6))).map((row) => row.id);
  if (orphanIds.length === 0) return 0;
  await prisma.regularInvestPlan.deleteMany({ where: { id: { in: orphanIds } } }).catch(() => {});
  return orphanIds.length;
}

/**
 * 开机自愈：为所有持有中的存单补齐/刷新计划行（老数据可能没有）。
 * 逐存单 upsert，幂等；同时清掉旧的产品级计划行残留。
 */
export async function ensureBondPlansForHousehold(params: { householdId: string }): Promise<number> {
  await purgeLegacyProductLevelBondPlans(params.householdId).catch(() => {});
  const lots = await prisma.bondTransaction.findMany({
    where: {
      householdId: params.householdId,
      action: FundSubtype.buy,
      deletedAt: null,
    },
    select: { id: true },
  });
  let touched = 0;
  for (const lot of lots) {
    await ensureBondPlansForLot({ householdId: params.householdId, lotId: lot.id }).catch(() => {});
    touched += 1;
  }
  return touched;
}
