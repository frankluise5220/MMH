import { FundSubtype, TransactionType } from "@prisma/client";

import { bondDateKey, bondPayoutDatesUpTo, estimateBondPeriodInterest } from "@/lib/bond";
import { prisma } from "@/lib/db/prisma";
import { parseDepositInterestPayout } from "@/lib/deposit-interest-payout";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { SYSTEM_BOND_INTEREST_CATEGORY } from "@/lib/investment-category";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { ensureBondPlansForLot, loadBondLotPlanSource } from "@/lib/server/bond-plan-tasks";
import { getServerT } from "@/lib/server/i18n";
import { ENTRY_ORIGIN_SCHEDULED_TASK, TRANSACTION_SOURCE_BOND } from "@/lib/transaction-semantics";

/**
 * 债券按期付息自动落账 —— 口径与存款完全一致（2026-09-19 用户定版）。
 *
 * 每个应付息日生成**一对**记录（与存款的 autoAccruePeriodicInterest 同构）：
 *   1. 生息：type=income，记在债券账户（+利息）—— 利息在债券账户里生出来；
 *   2. 取息：type=transfer，债券账户 → 买入时的资金账户（−利息 / 资金账户 +利息）。
 *      The payout transfer is an ordinary ledger entry: it does not write bond
 *      business fields or a bond_transactions row, matching deposits.
 * 净效果：债券账户本金不变、资金账户收到利息；债券视图「累计已付利息」按
 * bond_transactions 的 dividend_cash 子行统计，所以生息那一侧同时落一条业务行。
 *
 * 与存款的差异（用户明确要求保留）：到期赎回仍由「债券到期」计划行提醒、手工确认
 * （本金到账时间/金额不确定，且有核销），本模块只管付息。
 */

export type BondInterestAccrualResult = {
  status: "accrued" | "skipped";
  pairs?: number;
  totalInterest?: number;
  entryIds?: string[];
  reason?: string;
};

const INTEREST_SOURCE = TRANSACTION_SOURCE_BOND;
/** 一次最多补多少期，防脏数据把整个历史刷爆。 */
const MAX_PAYOUTS_PER_RUN = 120;

export async function autoAccrueBondPeriodicInterestForLot(params: {
  householdId: string;
  lotId: string;
  today: Date;
  planId?: string | null;
}): Promise<BondInterestAccrualResult> {
  const source = await loadBondLotPlanSource({ householdId: params.householdId, lotId: params.lotId });
  if (!source) return { status: "skipped", reason: "存单不存在" };

  const frequency = parseDepositInterestPayout(source.payoutFrequency);
  if (frequency.kind !== "periodic") return { status: "skipped", reason: "非按期付息" };
  if (!(source.principal > 0)) return { status: "skipped", reason: "存单本金为 0" };
  const annualRate = Number(source.annualRate ?? 0);
  if (!(annualRate > 0)) return { status: "skipped", reason: "缺票面利率" };

  // 应付息日：从首次付息日按周期步进，只取不晚于「今天」的期次（到期日尾差一并纳入）。
  const todayKey = localDayKey(params.today);
  const startKey = bondDateKey(source.startDate);
  const slots = bondPayoutDatesUpTo({
    term: {
      annualRate,
      termDays: source.termDays,
      maturityDate: source.maturityDate,
      payoutFrequency: source.payoutFrequency,
      firstPayoutDate: source.firstPayoutDate,
    },
    start: source.startDate,
    untilKey: todayKey,
    limit: MAX_PAYOUTS_PER_RUN,
  });
  const due = slots.filter((slot) => !startKey || slot.key > startKey);
  if (due.length === 0) return { status: "skipped", reason: "无应付息日" };

  // 已覆盖判定：该存单自己的付息业务行（含手工登记的历史记录，直接认领不重复生成）。
  // 注意 bond_transactions 没有 regularInvestPlanId 列，所以计划归属只能落在 TxRecord 上。
  const existingRows = await prisma.bondTransaction.findMany({
    where: {
      householdId: params.householdId,
      sourceBondTransactionId: source.lotId,
      action: FundSubtype.dividend_cash,
      deletedAt: null,
    },
    select: { id: true, tradeDate: true, confirmDate: true },
  });
  const coveredKeys = new Set<string>();
  for (const row of existingRows) {
    const key = bondDateKey(row.confirmDate ?? row.tradeDate);
    if (key) coveredKeys.add(key);
  }

  const interest = estimateBondPeriodInterest({
    principal: source.principal,
    annualRate,
    frequency,
    interestCalcBasis: source.interestCalcBasis,
  });
  if (!(interest > 0)) return { status: "skipped", reason: "单期利息为 0" };

  const cashAccountId = source.cashAccountId;
  if (!cashAccountId) return { status: "skipped", reason: "缺买入资金来源账户" };
  const [bondAccount, cashAccount] = await Promise.all([
    prisma.account.findUnique({ where: { id: source.accountId }, select: { id: true, name: true, currency: true } }),
    prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, currency: true } }),
  ]);
  if (!bondAccount || !cashAccount) return { status: "skipped", reason: "账户不存在" };

  const lot = await prisma.bondTransaction.findUnique({
    where: { id: source.lotId },
    select: { bondProductId: true, productName: true },
  });

  const t = await getServerT();
  const category = await resolveCategorySnapshot(prisma, params.householdId, {
    categoryName: SYSTEM_BOND_INTEREST_CATEGORY,
    type: "investment",
  });
  const payoutNote = t("bondInterest.payoutNote", { name: source.name });
  const transferNote = t("bondInterest.payoutTransferNote", { name: source.name });
  const currency = bondAccount.currency ?? cashAccount.currency ?? "CNY";

  const createdEntryIds: string[] = [];
  let pairs = 0;
  let totalInterest = 0;

  for (const slot of due) {
    if (coveredKeys.has(slot.key)) continue;
    const created = await prisma.$transaction(async (tx) => {
      // ① 生息：利息在债券账户里生出来（+利息）。
      const income = await tx.txRecord.create({
        data: {
          householdId: params.householdId,
          date: slot.date,
          postedAt: slot.date,
          type: TransactionType.income,
          accountId: bondAccount.id,
          accountName: bondAccount.name,
          amount: interest,
          currency,
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? SYSTEM_BOND_INTEREST_CATEGORY,
          source: INTEREST_SOURCE,
          entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
          note: payoutNote,
          fundProductType: "bond",
          fundSubtype: FundSubtype.dividend_cash,
          bondProductId: lot?.bondProductId ?? null,
          bondSubtype: FundSubtype.dividend_cash,
          bondName: lot?.productName ?? source.name,
          bondAnnualRate: annualRate,
          bondInterest: interest,
          bondArrivalDate: slot.date,
          bondConfirmDate: slot.date,
          regularInvestPlanId: params.planId ?? null,
        },
      });
      // 付息业务行：债券视图「累计已付利息 / 下次付息」都按它统计（id ＝ TxRecord id）。
      await tx.bondTransaction.create({
        data: {
          id: income.id,
          householdId: params.householdId,
          accountId: bondAccount.id,
          cashAccountId: cashAccount.id,
          cashEntryId: income.id,
          bondProductId: lot?.bondProductId ?? null,
          productName: lot?.productName ?? source.name,
          sourceBondTransactionId: source.lotId,
          action: FundSubtype.dividend_cash,
          source: INTEREST_SOURCE,
          entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
          tradeDate: slot.date,
          confirmDate: slot.date,
          arrivalDate: slot.date,
          grossAmount: interest,
          arrivalAmount: interest,
          interest,
          annualRate,
        },
      });
      // ② 取息：把利息从债券账户转到资金账户（债券账户 −利息 / 资金账户 +利息）。
      // This transfer is an ordinary ledger entry. Keep the plan linkage, but
      // do not attach bond business fields, matching deposit interest payouts.
      const transfer = await tx.txRecord.create({
        data: {
          householdId: params.householdId,
          date: slot.date,
          type: TransactionType.transfer,
          accountId: bondAccount.id,
          accountName: bondAccount.name,
          toAccountId: cashAccount.id,
          toAccountName: cashAccount.name,
          amount: -interest,
          currency,
          source: INTEREST_SOURCE,
          entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
          note: transferNote,
          regularInvestPlanId: params.planId ?? null,
        },
      });
      return [income.id, transfer.id];
    });
    createdEntryIds.push(...created);
    coveredKeys.add(slot.key);
    pairs += 1;
    totalInterest = Number((totalInterest + interest).toFixed(2));
  }

  if (pairs === 0) return { status: "skipped", reason: "无未付期次" };

  await recalcAndSaveAccountBalance(bondAccount.id).catch(() => {});
  await recalcAndSaveAccountBalance(cashAccount.id).catch(() => {});
  // 付息后计划行跟着推进（nextRunDate = 下一未付息日；本金清零才完成）。
  await ensureBondPlansForLot({ householdId: params.householdId, lotId: source.lotId }).catch(() => {});

  return { status: "accrued", pairs, totalInterest, entryIds: createdEntryIds };
}

/** 本地日（YYYY-MM-DD）—— 与存款侧 localDayKey 同口径。 */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
