import { FundSubtype, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { isPeriodicDepositInterestPayout, parseDepositInterestPayout } from "@/lib/deposit-interest-payout";
import {
  computeDepositMaturityInterest,
  dayDiffDays,
  depositRenewRoundsNeeded,
  nextDepositTermMaturityUtc,
  round2,
  utcDayStart,
} from "@/lib/deposit-maturity";
import { getServerT } from "@/lib/server/i18n";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { renewDeposit } from "@/lib/server/sidebar-actions/transaction-actions";
import { resolveCategorySnapshot, SYSTEM_DEPOSIT_INTEREST_CATEGORY } from "@/lib/default-categories";
import { ENTRY_ORIGIN_SCHEDULED_TASK } from "@/lib/transaction-semantics";
import { addMonthsUtc, toNumber } from "@/lib/date-utils";

const MAX_LOTS_PER_RUN = 200;
const MAX_RENEW_ROUNDS_PER_LOT = 24;
const MAX_INTEREST_PAYOUTS_PER_LOT = 60;

export type DepositAutoMaturityDetail = {
  lotId: string;
  action: string;
  status: "redeemed" | "renewed" | "skipped" | "accrued";
  rounds?: number;
  pairs?: number;
  entryIds?: string[];
  reason?: string;
};

export type DepositAutoMaturityResult = {
  ok: boolean;
  processedCount: number;
  redeemedCount: number;
  renewedCount: number;
  interestPayoutsCount: number;
  skippedCount: number;
  remainingDue: boolean;
  entryIds: string[];
  details: DepositAutoMaturityDetail[];
};

let inFlight: Promise<DepositAutoMaturityResult> | null = null;

/**
 * Process every held deposit lot whose maturity date has arrived, following
 * the lot's stored maturity action. Idempotent per lot:
 *   - redeem  → skipped once a redeem/switch_out entry references the lot
 *   - renew   → the maturity date rolls forward past `now`, so it stops matching
 * Triggered from the app-open startup check (DailyTaskCheck); no OS background
 * task is required.
 */
export async function autoProcessMaturedDeposits(
  householdId: string,
  now: Date = new Date(),
): Promise<DepositAutoMaturityResult> {
  if (inFlight) return inFlight;
  inFlight = runAutoProcessMaturedDeposits(householdId, now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runAutoProcessMaturedDeposits(
  householdId: string,
  now: Date,
): Promise<DepositAutoMaturityResult> {
  const result: DepositAutoMaturityResult = {
    ok: true,
    processedCount: 0,
    redeemedCount: 0,
    renewedCount: 0,
    interestPayoutsCount: 0,
    skippedCount: 0,
    remainingDue: false,
    entryIds: [],
    details: [],
  };

  const today = utcDayStart(now);

  // ── Scan 1: periodic-payout deposits still held — any accrued-but-unpaid
  // interest (payout date passed, no live income entry for it) is generated
  // as a 利息收入 + 转账 pair. This covers ALL held periodic lots, matured
  // or not, so the user never has to click 取息 for dates already past.
  const periodicLots = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
      depositInterestPayoutFrequency: { not: null },
    },
    orderBy: [{ fundArrivalDate: "asc" }, { id: "asc" }],
    take: MAX_LOTS_PER_RUN,
  });
  for (const buy of periodicLots) {
    try {
      const outcome = await autoAccruePeriodicInterest(buy.id, householdId, today);
      if (outcome.status === "accrued") {
        result.interestPayoutsCount += outcome.pairs ?? 0;
        result.processedCount += outcome.pairs ?? 0;
        result.entryIds.push(...(outcome.entryIds ?? []));
        result.details.push({ lotId: buy.id, action: "interest_payout", ...outcome });
      } else if (outcome.status === "skipped" && outcome.reason !== "no missing payouts") {
        result.details.push({ lotId: buy.id, action: "interest_payout", ...outcome });
      }
    } catch (e) {
      result.details.push({
        lotId: buy.id,
        action: "interest_payout",
        status: "skipped",
        reason: e instanceof Error ? e.message : "periodic interest accrual failed",
      });
    }
  }

  // ── Scan 2: matured lots follow their stored maturity action (取回/续存).
  const candidates = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
      depositMaturityAction: { in: ["redeem", "renew_principal", "renew_principal_interest"] },
      fundArrivalDate: { lte: today },
    },
    orderBy: [{ fundArrivalDate: "asc" }, { id: "asc" }],
    take: MAX_LOTS_PER_RUN,
  });

  for (const buy of candidates) {
    const action = buy.depositMaturityAction;
    if (!action) continue;
    try {
      if (action === "redeem") {
        const outcome = await autoRedeemDeposit(buy.id, householdId);
        if (outcome.status === "redeemed") {
          result.redeemedCount += 1;
          result.processedCount += 1;
          if (outcome.entryId) result.entryIds.push(outcome.entryId);
        } else {
          result.skippedCount += 1;
          result.remainingDue = !!outcome.retryable;
        }
        result.details.push({ lotId: buy.id, action, ...outcome });
        continue;
      }

      // renew_principal / renew_principal_interest: roll one original term per
      // round until the maturity passes `now` (catch-up after a long absence).
      const outcome = await autoRenewDeposit(buy.id, householdId, now);
      if (outcome.status === "renewed") {
        result.renewedCount += outcome.rounds ?? 0;
        result.processedCount += outcome.rounds ?? 0;
      } else {
        result.skippedCount += 1;
        result.remainingDue = !!outcome.retryable;
      }
      result.details.push({ lotId: buy.id, action, ...outcome });
    } catch (e) {
      result.skippedCount += 1;
      result.remainingDue = true;
      result.details.push({
        lotId: buy.id,
        action,
        status: "skipped",
        reason: e instanceof Error ? e.message : "auto maturity failed",
      });
    }
  }

  if (result.processedCount > 0) {
    revalidateAfterInvestChange();
  }
  return result;
}

type LotOutcome = {
  status: "redeemed" | "renewed" | "skipped";
  entryId?: string;
  rounds?: number;
  reason?: string;
  retryable?: boolean;
};

/** True when a redemption entry already closes this lot. */
async function lotAlreadyRedeemed(buyId: string, householdId: string): Promise<boolean> {
  const link = await prisma.txRecord.findFirst({
    where: {
      householdId,
      deletedAt: null,
      depositSourceEntryId: buyId,
      fundSubtype: { in: [FundSubtype.redeem, FundSubtype.switch_out] },
    },
    select: { id: true },
  });
  return !!link;
}

/** Local-day key (the app stores dates as local midnight). Timezone-agnostic
 *  comparison for payout scheduling — avoids UTC/local off-by-one days. */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

type PayoutOutcome = {
  status: "accrued" | "skipped";
  pairs?: number;
  totalInterest?: number;
  entryIds?: string[];
  reason?: string;
};

/** Public single-lot entry for the deposit plan executor (system plan path). */
/** 同存单互斥：页面刷新与计划执行可能同时触发，避免重复生成。 */
const accrualInFlight = new Set<string>();

export async function autoAccruePeriodicInterestForLot(params: {
  householdId: string;
  lotId: string;
  now: Date;
  /** 计划任务的「是否转账」：false 时只生成利息收入，不生成转账。 */
  createTransfer?: boolean;
  /** 系统计划任务 id：生成的利息记录会写入 regularInvestPlanId 作为关联。 */
  planId?: string | null;
}): Promise<{ status: "accrued" | "skipped"; pairs?: number; totalInterest?: number; reason?: string }> {
  const key = `${params.householdId}:${params.lotId}`;
  if (accrualInFlight.has(key)) {
    return { status: "skipped", reason: "正在生成中" };
  }
  accrualInFlight.add(key);
  try {
    return await autoAccruePeriodicInterest(
      params.lotId,
      params.householdId,
      utcDayStart(params.now),
      params.createTransfer !== false,
      params.planId ?? null,
    );
  } finally {
    accrualInFlight.delete(key);
  }
}

/** Public single-lot maturity runner for the deposit plan executor. */
export async function processDepositMaturityForLot(params: {
  householdId: string;
  lotId: string;
  now: Date;
}): Promise<{ status: "redeemed" | "renewed" | "skipped"; rounds?: number; reason?: string }> {
  const buy = await prisma.txRecord.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
    },
    select: { id: true, depositMaturityAction: true },
  });
  if (!buy) return { status: "skipped", reason: "lot missing" };
  if (!buy.depositMaturityAction) return { status: "skipped", reason: "no maturity action" };
  if (await lotAlreadyRedeemed(buy.id, params.householdId)) {
    return { status: "skipped", reason: "already redeemed" };
  }
  if (buy.depositMaturityAction === "redeem") {
    const outcome = await autoRedeemDeposit(buy.id, params.householdId);
    return { status: outcome.status, reason: outcome.reason };
  }
  const outcome = await autoRenewDeposit(buy.id, params.householdId, params.now);
  return { status: outcome.status, rounds: outcome.rounds, reason: outcome.reason };
}

/**
 * Generate every past-due periodic interest payout for one held deposit lot:
 * anchor dates (deposit start + N×interval) and the maturity-day stub, each
 * producing a 利息收入 + 转账 pair unless a live income entry already covers
 * that date. Payout dates never exceed min(maturity, today); the pair dates
 * follow the bank anchor (start date's day-of-month).
 */
async function autoAccruePeriodicInterest(
  buyId: string,
  householdId: string,
  today: Date,
  createTransfer = true,
  planId?: string | null,
): Promise<PayoutOutcome> {
  const buy = await prisma.txRecord.findFirst({
    where: {
      id: buyId,
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
    },
  });
  if (!buy) return { status: "skipped", reason: "lot missing" };
  const frequency = parseDepositInterestPayout(buy.depositInterestPayoutFrequency);
  if (frequency.kind !== "periodic") return { status: "skipped", reason: "not periodic" };

  const principal = Math.abs(toNumber(buy.fundArrivalAmount ?? buy.amount));
  const annualRate = toNumber(buy.depositAnnualRate);
  if (!(principal > 0) || !(annualRate > 0)) return { status: "skipped", reason: "missing principal/rate" };
  const depositAccountId = buy.toAccountId;
  const cashAccountId = buy.accountId;
  if (!depositAccountId || !cashAccountId) return { status: "skipped", reason: "missing accounts" };

  const depositAccount = await prisma.account.findUnique({
    where: { id: depositAccountId },
    select: { id: true, name: true, currency: true },
  });
  const cashAccount = await prisma.account.findUnique({
    where: { id: cashAccountId },
    select: { id: true, name: true, currency: true },
  });
  if (!depositAccount || !cashAccount) return { status: "skipped", reason: "account not found" };

  const startDate = buy.date;
  if (!startDate) return { status: "skipped", reason: "missing start date" };

  // ── Scheduled payout dates: anchor stepping from the start date, capped at
  // the earlier of the lot's maturity and today (maturity-day stub handled by
  // including the maturity date itself when it lands after the last anchor).
  const todayKey = localDayKey(today);
  // 排程直接保存「锚点时刻」本身，并用本地日做去重键。写入记录时用同一个时刻，
  // 这样下一轮覆盖判定（按本地日）必然命中 —— 之前键按 UTC 日、写入按本地零点，
  // 差一天导致每轮都判定「未生成」→ 反复补生成（2026-09 一个月三笔的事故）。
  const maturityKeyCap = buy.fundArrivalDate ? localDayKey(buy.fundArrivalDate) : null;
  const upperKey = maturityKeyCap && maturityKeyCap <= todayKey ? maturityKeyCap : todayKey;
  const payoutByKey = new Map<string, Date>();
  const addPayout = (date: Date) => {
    const key = localDayKey(date);
    if (key > localDayKey(startDate) && key <= upperKey) payoutByKey.set(key, date);
  };
  if (frequency.unit === "month") {
    for (let k = frequency.interval; k < 12 * 80; k += frequency.interval) {
      const date = addMonthsUtc(startDate, k);
      if (localDayKey(date) > upperKey) break;
      addPayout(date);
    }
  } else {
    const stepDays = frequency.unit === "week" ? 7 * frequency.interval : 1;
    for (let ms = startDate.getTime() + stepDays * 86400000; localDayKey(new Date(ms)) <= upperKey; ms += stepDays * 86400000) {
      addPayout(new Date(ms));
    }
  }
  // 到期日尾差：最后一个付息日之后、到期日之前的那几天，银行在到期日一次结清。
  if (buy.fundArrivalDate) addPayout(buy.fundArrivalDate);

  const schedule = [...payoutByKey.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (schedule.length === 0) return { status: "skipped", reason: "no payouts due" };

  // Live deposit-source rows on this lot's account. A payout date counts as
  // covered only when its row belongs to THIS plan (regularInvestPlanId).
  // Rows without the plan link are legacy/manual leftovers: they get adopted
  // (linked) in place instead of duplicating — which is what makes
  // "no plan id → rebuild from the earliest date" safe.
  const liveRows = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      source: "deposit",
      accountId: depositAccountId,
      type: { in: [TransactionType.income, TransactionType.transfer] },
    },
    select: { id: true, date: true, type: true, note: true, depositSourceEntryId: true, regularInvestPlanId: true },
  });
  const rowsByDay = new Map<string, typeof liveRows>();
  for (const row of liveRows) {
    const key = localDayKey(new Date(row.date));
    const bucket = rowsByDay.get(key);
    if (bucket) bucket.push(row);
    else rowsByDay.set(key, [row]);
  }
  // 归属判定：有链接的只认本存单；无链接（历史遗留）的按备注里的产品名认领，
  // 免得同账户另一笔存款的旧记录误覆盖本存单的付息日。
  const lotName = (buy.fundName ?? "").trim();
  const belongsToThisLot = (row: { depositSourceEntryId: string | null; note: string | null }) => {
    if (row.depositSourceEntryId) return row.depositSourceEntryId === buy.id;
    if (!lotName) return true;
    return (row.note ?? "").includes(lotName);
  };
  const coveredDays = new Set<string>();
  const adoptIds: string[] = [];
  for (const [key, rows] of rowsByDay) {
    const mine = rows.filter(belongsToThisLot);
    if (mine.length === 0) continue;
    coveredDays.add(key);
    if (planId) {
      for (const row of mine) {
        if (row.regularInvestPlanId !== planId) adoptIds.push(row.id);
      }
    }
  }
  if (planId && adoptIds.length > 0) {
    await prisma.txRecord.updateMany({
      where: { id: { in: adoptIds } },
      data: { regularInvestPlanId: planId },
    });
  }

  const t = await getServerT();
  const interestCategory = await resolveCategorySnapshot(prisma, householdId, {
    categoryName: SYSTEM_DEPOSIT_INTEREST_CATEGORY,
    type: "income",
  });

  const currency = buy.currency ?? depositAccount.currency ?? "CNY";
  const note = `${t("deposit.renew.payoutNote", { name: buy.fundName ?? "" })}`;
  const transferNote = `${t("deposit.renew.payoutTransferNote", { name: buy.fundName ?? "" })}`;
  let segmentStart = startDate;
  let pairs = 0;
  let totalInterest = 0;
  const createdEntryIds: string[] = [];

  for (const [payoutDateKey, payoutDate] of schedule) {
    const segmentDays = Math.max(0, Math.round((payoutDate.getTime() - segmentStart.getTime()) / 86400000));
    if (segmentDays <= 0) continue;
    if (coveredDays.has(payoutDateKey)) {
      segmentStart = payoutDate;
      continue;
    }
    const accrued = round2((principal * (annualRate / 100) * segmentDays) / 365);
    segmentStart = payoutDate;
    if (!(accrued > 0)) continue;
    await prisma.$transaction(async (tx) => {
      const income = await tx.txRecord.create({
        data: {
          date: payoutDate,
          postedAt: payoutDate,
          type: TransactionType.income,
          accountId: depositAccount.id,
          accountName: depositAccount.name,
          amount: accrued,
          currency,
          categoryId: interestCategory?.id ?? null,
          categoryName: interestCategory?.name ?? SYSTEM_DEPOSIT_INTEREST_CATEGORY,
          source: "deposit",
          entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
          depositSourceEntryId: buy.id,
          regularInvestPlanId: planId ?? null,
          note,
          ...{ householdId: buy.householdId },
        },
      });
      if (createTransfer) {
        const transfer = await tx.txRecord.create({
          data: {
            date: payoutDate,
            type: TransactionType.transfer,
            accountId: depositAccount.id,
            accountName: depositAccount.name,
            toAccountId: cashAccount.id,
            toAccountName: cashAccount.name,
            amount: -accrued,
            currency,
            source: "deposit",
            entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
            depositSourceEntryId: buy.id,
            regularInvestPlanId: planId ?? null,
            note: transferNote,
            ...{ householdId: buy.householdId },
          },
        });
        createdEntryIds.push(income.id, transfer.id);
      } else {
        createdEntryIds.push(income.id);
      }
    });
    pairs += 1;
    totalInterest = Number((totalInterest + accrued).toFixed(2));
    // Advance the interest segment anchor.
    await prisma.txRecord.update({
      where: { id: buy.id },
      data: { fundConfirmDate: payoutDate },
    });
  }

  if (pairs > 0) {
    await recalcAndSaveAccountBalance(depositAccount.id).catch(() => {});
    await recalcAndSaveAccountBalance(cashAccount.id).catch(() => {});
    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: buy.id }).catch((e) => {
      console.error("autoAccruePeriodicInterest sync buy projection:", e);
    });
    return { status: "accrued", pairs, totalInterest, entryIds: createdEntryIds };
  }
  return { status: "skipped", reason: "no missing payouts" };
}

async function autoRedeemDeposit(buyId: string, householdId: string): Promise<LotOutcome> {
  const t = await getServerT();
  const buy = await prisma.txRecord.findFirst({
    where: {
      id: buyId,
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
    },
  });
  if (!buy) return { status: "skipped", reason: "lot missing", retryable: false };
  if (await lotAlreadyRedeemed(buy.id, householdId)) {
    return { status: "skipped", reason: "already redeemed", retryable: false };
  }

  const depositAccountId = buy.toAccountId;
  const cashAccountId = buy.accountId;
  if (!depositAccountId || !cashAccountId) {
    return { status: "skipped", reason: "missing deposit/cash account", retryable: false };
  }
  const [depositAccount, cashAccount] = await Promise.all([
    prisma.account.findUnique({ where: { id: depositAccountId }, select: { id: true, name: true, currency: true } }),
    prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, currency: true } }),
  ]);
  if (!depositAccount || !cashAccount) {
    return { status: "skipped", reason: "account not found", retryable: false };
  }

  const maturityDate = buy.fundArrivalDate;
  if (!maturityDate) return { status: "skipped", reason: "missing maturity", retryable: false };

  const principal = Math.abs(toNumber(buy.fundArrivalAmount ?? buy.amount));
  if (!(principal > 0)) return { status: "skipped", reason: "missing principal", retryable: false };

  const periodic = isPeriodicDepositInterestPayout(buy.depositInterestPayoutFrequency);
  const interest = computeDepositMaturityInterest({
    principal,
    annualRatePercent: buy.depositAnnualRate == null ? null : toNumber(buy.depositAnnualRate),
    segmentStart: buy.fundConfirmDate ?? buy.date,
    maturityDate,
    periodicPayout: periodic,
  });
  const arrival = round2(principal + interest);
  const redeemDate = maturityDate;

  // The redeem's DepositTransaction projection references the lot's own
  // projection via FK; legacy lots may lack it, so (re)build it first.
  const lotProjection = await prisma.depositTransaction.findUnique({ where: { id: buy.id }, select: { id: true } });
  if (!lotProjection) {
    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: buy.id }).catch((e) => {
      console.error("autoRedeemDeposit self-heal lot projection:", e);
    });
  }

  const created = await prisma.txRecord.create({
    data: {
      date: redeemDate,
      type: TransactionType.investment,
      accountId: depositAccount.id,
      accountName: depositAccount.name,
      toAccountId: cashAccount.id,
      toAccountName: cashAccount.name,
      amount: arrival,
      currency: buy.currency ?? depositAccount.currency ?? "CNY",
      fundName: buy.fundName,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.redeem,
      source: "deposit",
      entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
      depositAnnualRate: buy.depositAnnualRate ?? undefined,
      ...(interest > 0 ? { depositInterest: interest } : {}),
      depositSourceEntryId: buy.id,
      fundArrivalDate: redeemDate,
      fundArrivalAmount: arrival,
      note: t("deposit.auto.redeemNote", { name: buy.fundName ?? "" }),
      householdId,
    },
  });

  await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: created.id }).catch((e) => {
    console.error("autoRedeemDeposit sync business transaction:", e);
  });
  await recalcAndSaveAccountBalance(depositAccount.id).catch(() => {});
  await recalcAndSaveAccountBalance(cashAccount.id).catch(() => {});
  return { status: "redeemed", entryId: created.id };
}

async function autoRenewDeposit(
  buyId: string,
  householdId: string,
  now: Date,
): Promise<LotOutcome> {
  const first = await prisma.txRecord.findFirst({
    where: {
      id: buyId,
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
    },
  });
  if (!first) return { status: "skipped", reason: "lot missing", retryable: false };
  const originalMaturity = first.fundArrivalDate;
  if (!originalMaturity || !first.date) {
    return { status: "skipped", reason: "missing maturity", retryable: false };
  }
  // Original term measured from the first maturity — fixed across rounds so
  // repeated renewals keep rolling the same length (renewDeposit's internal
  // default drifts because it measures from buy.date, which never moves).
  const originalTermDays = Math.max(1, dayDiffDays(originalMaturity, first.date));
  const roundsNeeded = depositRenewRoundsNeeded({
    maturityDate: originalMaturity,
    originalTermDays,
    now,
  });
  const roundsToRun = Math.min(roundsNeeded, MAX_RENEW_ROUNDS_PER_LOT);

  let rounds = 0;
  const mode = first.depositMaturityAction === "renew_principal_interest"
    ? "renew_principal_interest"
    : "renew_principal";

  while (rounds < roundsToRun) {
    const fresh = await prisma.txRecord.findUnique({ where: { id: buyId } });
    if (!fresh || fresh.deletedAt) break;
    const maturity = fresh.fundArrivalDate;
    if (!maturity || maturity > now) break;
    if (await lotAlreadyRedeemed(fresh.id, householdId)) break;

    const fd = new FormData();
    fd.set("entryId", fresh.id);
    fd.set("renewMode", mode);
    // Calendar-aware roll: anniversary-aligned terms (e.g. 5 年) renew to the
    // next anniversary; day-based terms roll by their original day count.
    fd.set("newMaturityDate", nextDepositTermMaturityUtc(first.date, maturity).toISOString().slice(0, 10));
    if (mode === "renew_principal") {
      fd.set("cashAccountId", fresh.accountId ?? "");
    }
    const res = await renewDeposit(fd);
    if (!res.ok) {
      if (rounds === 0) {
        return { status: "skipped", reason: res.error, retryable: true };
      }
      break;
    }
    rounds += 1;
  }

  if (rounds > 0) {
    return { status: "renewed", rounds };
  }
  return { status: "skipped", reason: "nothing to renew", retryable: false };
}
