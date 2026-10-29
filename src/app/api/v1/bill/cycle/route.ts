/**
 * API: /api/v1/bill/cycle
 *
 * PATCH JSON body:
 *   accountId: string
 *   statementMonth: string (YYYY-MM)
 *   periodStart: string (YYYY-MM-DD)
 *   periodEnd: string (YYYY-MM-DD)
 *   dueDate?: string | null (YYYY-MM-DD)
 *
 * Updates the credit-card bill cycle for one statement month and reorders
 * the following existing cycles from that month onward using the new
 * billing day / repayment day.
 * Accepted entity types: Account.id + CreditCardCycle.statementMonth
 *
 * 注意：账单列表里「双击周期修改账单日」的 UI 入口已移除（它允许把某一期写成
 * 邻月的日期，进而把相邻月份挤成两个月一期）。账单日改由「账单日设置」与
 * 账户编辑维护。本接口保留给对账单导入/数据修复使用，并继续做周期一致性校验。
 */
import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { addDaysUtc, formatDateUtc, startOfDayUtc, toNumber, businessTodayUtcStart } from "@/lib/date-utils";
import { revalidateAfterSettingsChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import {
  getCreditBillAccountIds,
  syncCreditCardInstitutionSettings,
} from "@/lib/server/credit-card-institution-settings";
import {
  recordCreditCardBillingDayChange,
  syncCreditCardBillingDaysFromRules,
} from "@/lib/server/credit-card-billing-day-rules";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import {
  CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS,
  CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
  applyNextCyclePaidToCreditBillSummaries,
  buildCreditCardCyclePersistRows,
  computeCreditBillCascade,
  creditCardBillingDayFromCycleEndDate,
  creditCardCycleEndDateForStatementMonth,
  creditCardDueDateForStatementMonth,
  creditCardStatementDateForMonth,
  mergeCreditCardCycleLockSources,
  summarizeCreditBillSignedFlows,
  creditBillDateRangeWhere,
  isCreditCyclePeriodInStatementMonth,
  type CreditBillSummary,
} from "@/lib/credit/billing";

function parseDateOnly(value: unknown): Date | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return formatDateUtc(date) === raw ? date : null;
}

function statementMonthDate(statementMonth: string) {
  const match = statementMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

function cycleEndForMonth(
  statementMonth: string,
  billingDay: number,
  billingDayTxPeriod: "current" | "next" | null | undefined,
) {
  const parsed = statementMonthDate(statementMonth);
  if (!parsed) return null;
  // The billing cycle for statementMonth ends on this-month billingDay.
  // e.g. billingDay=10 -> cycle ends on the 10th of the statement month.
  // This must match cycleForStatementMonth in billing.ts so that mid-cycle
  // edits, persisted cycles and computed cycles all share one boundary.
  return creditCardCycleEndDateForStatementMonth(
    parsed.year,
    parsed.monthIndex,
    billingDay,
    billingDayTxPeriod,
  );
}

function dueForCycle(statementMonth: string, billingDay: number, repaymentDay: number | null, repaymentOffsetDays: number | null) {
  const parsed = statementMonthDate(statementMonth);
  if (!parsed) return null;
  return creditCardDueDateForStatementMonth({
    year: parsed.year,
    monthIndex: parsed.monthIndex,
    billingDay,
    repaymentDay,
    repaymentOffsetDays,
  });
}

function diffUtcDays(start: Date, end: Date) {
  return Math.round((startOfDayUtc(end).getTime() - startOfDayUtc(start).getTime()) / 86400000);
}

function mdUtcDots(date: Date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")}`;
}

export async function PATCH(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_REQUEST_BODY", error: "请求内容格式不正确" }, { status: 400 });

    const accountId = String(body.accountId ?? "").trim();
    const statementMonth = String(body.statementMonth ?? "").trim();
    const periodStart = parseDateOnly(body.periodStart);
    const periodEnd = parseDateOnly(body.periodEnd);
    const dueDate = body.dueDate ? parseDateOnly(body.dueDate) : null;

    if (!accountId || !statementMonth) return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_OR_MONTH", error: "缺少账户或账单月份" }, { status: 400 });
    if (!statementMonthDate(statementMonth)) return NextResponse.json({ ok: false, code: "INVALID_STATEMENT_MONTH", error: "账单月份格式应为 YYYY-MM" }, { status: 400 });
    if (!periodStart || !periodEnd) return NextResponse.json({ ok: false, code: "INVALID_PERIOD_DATE", error: "账单周期日期格式应为 YYYY-MM-DD" }, { status: 400 });
    if (periodStart > periodEnd) return NextResponse.json({ ok: false, code: "PERIOD_START_AFTER_END", error: "周期开始日期不能晚于结束日期" }, { status: 400 });
    if (dueDate && dueDate < periodEnd) return NextResponse.json({ ok: false, code: "DUE_DATE_BEFORE_PERIOD_END", error: "还款日不能早于周期结束日期" }, { status: 400 });

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit },
      select: {
        id: true,
        householdId: true,
        institutionId: true,
        kind: true,
        creditBillMode: true,
        billingDay: true,
        repaymentDay: true,
        repaymentOffsetDays: true,
        billingDayTxPeriod: true,
      },
    });
    if (!account) return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });
    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const billAccountIdSet = new Set(billAccountIds);
    const storageAccountId = billAccountIds[0] ?? account.id;
    const settingsAccountIds = account.institutionId
      ? (await prisma.account.findMany({
          where: { householdId, institutionId: account.institutionId, kind: AccountKind.bank_credit },
          select: { id: true },
          orderBy: { id: "asc" },
        })).map((row) => row.id)
      : [account.id];
    const otherSettingsAccountIds = settingsAccountIds.filter((id) => !billAccountIdSet.has(id));

    const cycles = await prisma.creditCardCycle.findMany({
      where: { accountId: storageAccountId },
      orderBy: { statementMonth: "asc" },
    });
    if (!cycles.some((cycle) => cycle.statementMonth === statementMonth)) {
      return NextResponse.json({ ok: false, code: "CYCLE_NOT_FOUND", error: "账单周期不存在，请先生成账单列表" }, { status: 404 });
    }

    // 一期账单的周期必须「在自己这个账单月内结束」并且「紧接上一期」。旧实现直接
    // 采纳提交值再向下顺推，一旦把某期写成了邻月的日期（例如 2017-06 提交成
    // 05.01 ~ 05.31），邻月就被重复覆盖、本月流水没有周期可落，后面每期还会跟着
    // 被挤成跨两个月的一期。这里在写库前挡住这种提交。
    if (!isCreditCyclePeriodInStatementMonth({
      statementMonth,
      periodEnd,
      billingDayTxPeriod: account.billingDayTxPeriod,
    })) {
      const parsedMonth = statementMonthDate(statementMonth)!;
      return NextResponse.json({
        ok: false,
        code: "CYCLE_END_OUT_OF_STATEMENT_MONTH",
        error: `${statementMonth} 的周期必须在 ${parsedMonth.monthIndex + 1} 月内结束（账单日为月末时取该月最后一天），请检查周期结束日期`,
      }, { status: 400 });
    }
    const cycleIndex = cycles.findIndex((cycle) => cycle.statementMonth === statementMonth);
    const previousCycle = cycleIndex > 0 ? cycles[cycleIndex - 1]! : null;
    const parsedStatementMonth = statementMonthDate(statementMonth)!;
    const previousMonthKey = (() => {
      const date = new Date(Date.UTC(parsedStatementMonth.year, parsedStatementMonth.monthIndex - 1, 1));
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    })();
    // 只有「上一期就是上一个月」时才要求首尾相接：中间缺月份（例如历史账单没生成）
    // 时，开始日本来就不该由上一期推出来。
    if (previousCycle && previousCycle.statementMonth === previousMonthKey) {
      const previousEnd = startOfDayUtc(previousCycle.periodEnd);
      const expectedStart = addDaysUtc(previousEnd, 1);
      if (startOfDayUtc(periodStart).getTime() !== expectedStart.getTime()) {
        return NextResponse.json({
          ok: false,
          code: "CYCLE_START_NOT_CONTIGUOUS",
          error: `周期开始日期必须紧接上一期结束日（${formatDateUtc(previousEnd)}）的次日，即 ${formatDateUtc(expectedStart)}`,
        }, { status: 400 });
      }
    }

    // The billing day is the closing date of the cycle, i.e. periodEnd. When
    // the user picks a month-end date, store the canonical month-end day (31)
    // so February/April/etc. continue closing on their actual last day.
    const billingDay = creditCardBillingDayFromCycleEndDate(periodEnd);
    const repaymentMode = account.repaymentOffsetDays != null ? "offset" : "fixed";
    const repaymentOffsetDays = (() => {
      if (!dueDate || repaymentMode !== "offset") return null;
      const parsed = statementMonthDate(statementMonth);
      if (!parsed) return null;
      return diffUtcDays(
        creditCardStatementDateForMonth(parsed.year, parsed.monthIndex, billingDay),
        dueDate,
      );
    })();
    if (
      repaymentOffsetDays != null &&
      (repaymentOffsetDays < 0 || repaymentOffsetDays > CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS)
    ) {
      return NextResponse.json({ ok: false, code: "INVALID_REPAYMENT_OFFSET_DAYS", error: `还款日偏移天数应为 0-${CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS} 之间的整数` }, { status: 400 });
    }
    const repaymentDay = dueDate && repaymentMode === "fixed" ? dueDate.getUTCDate() : null;
    const today = businessTodayUtcStart(await getHouseholdTimeZone(householdId));

    const adjustedCycles = cycles.map((cycle) => ({
      id: cycle.id,
      statementMonth: cycle.statementMonth,
      periodStart: startOfDayUtc(cycle.periodStart),
      periodEnd: startOfDayUtc(cycle.periodEnd),
      dueDate: cycle.dueDate ? startOfDayUtc(cycle.dueDate) : null,
      expenseAbs: toNumber(cycle.expenseAbs),
      income: toNumber(cycle.income),
      paid: toNumber(cycle.paid),
      rawBill: toNumber(cycle.rawBill),
      effectiveBill: toNumber(cycle.effectiveBill),
      cumulativeRemain: toNumber(cycle.cumulativeRemain),
      cumulativeOverpaid: toNumber(cycle.cumulativeOverpaid),
      isCurrentCycle: cycle.isCurrentCycle,
      isLocked: cycle.isLocked,
      lockSource: cycle.lockSource,
    }));

    const startIndex = adjustedCycles.findIndex((cycle) => cycle.statementMonth === statementMonth);
    adjustedCycles[startIndex]!.periodStart = periodStart;
    adjustedCycles[startIndex]!.periodEnd = periodEnd;
    adjustedCycles[startIndex]!.dueDate = dueDate;

    for (let i = startIndex + 1; i < adjustedCycles.length; i++) {
      const previous = adjustedCycles[i - 1]!;
      const current = adjustedCycles[i]!;
      const nextEnd = cycleEndForMonth(current.statementMonth, billingDay, account.billingDayTxPeriod);
      if (!nextEnd) continue;
      current.periodStart = addDaysUtc(previous.periodEnd, 1);
      current.periodEnd = nextEnd;
      current.dueDate = dueForCycle(current.statementMonth, billingDay, repaymentDay, repaymentOffsetDays);
    }

    const changedCycles = adjustedCycles.slice(startIndex);
    for (const cycle of changedCycles) {
      cycle.isLocked = true;
      cycle.lockSource = mergeCreditCardCycleLockSources(
        cycle.lockSource,
        CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
      );
    }
    const oldChangedCycles = cycles.slice(startIndex);
    const minDate = new Date(Math.min(
      ...changedCycles.map((cycle) => cycle.periodStart.getTime()),
      ...oldChangedCycles.map((cycle) => cycle.periodStart.getTime()),
    ));
    const maxDate = new Date(Math.max(
      ...changedCycles.map((cycle) => cycle.periodEnd.getTime()),
      ...oldChangedCycles.map((cycle) => cycle.periodEnd.getTime()),
    ));

    await prisma.$transaction(async (tx) => {
      await syncCreditCardInstitutionSettings(tx, {
        householdId,
        institutionId: account.institutionId,
        repaymentDay,
        repaymentOffsetDays,
        creditBillMode: account.creditBillMode,
        billingDayTxPeriod: account.billingDayTxPeriod,
      });
      if (!account.institutionId) {
        await tx.account.update({
          where: { id: account.id },
          data: { repaymentDay, repaymentOffsetDays },
        });
      }
      await recordCreditCardBillingDayChange(tx, {
        accountIds: settingsAccountIds,
        billingDay,
        effectiveDate: periodStart,
      });
      await syncCreditCardBillingDaysFromRules(tx, {
        accountIds: settingsAccountIds,
      });

      await tx.txRecord.updateMany({
        where: {
          AND: [
            { deletedAt: null },
            { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] },
            creditBillDateRangeWhere(minDate, addDaysUtc(maxDate, 1)),
          ],
        },
        data: { statementMonth: null },
      });

      for (const cycle of changedCycles) {
        await tx.txRecord.updateMany({
          where: {
            AND: [
              { deletedAt: null },
              { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] },
              creditBillDateRangeWhere(cycle.periodStart, addDaysUtc(cycle.periodEnd, 1)),
            ],
          },
          data: { statementMonth: cycle.statementMonth },
        });
      }
    });

    const overrides = await prisma.billOverride.findMany({ where: { accountId: storageAccountId } });
    const recalculatedSummaries: CreditBillSummary[] = [];
    for (const cycle of adjustedCycles) {
      const cycleWindow = {
        ...creditBillDateRangeWhere(cycle.periodStart, addDaysUtc(cycle.periodEnd, 1)),
        deletedAt: null,
      };
      const cycleFlowRows = await prisma.txRecord.findMany({
        where: {
          AND: [
            cycleWindow,
            { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] },
          ],
        },
        select: { accountId: true, toAccountId: true, amount: true, type: true, categoryName: true },
      });

      const flows = summarizeCreditBillSignedFlows(cycleFlowRows, billAccountIdSet);
      const expenseAbs = flows.expenseAbs;
      const income = flows.income;
      const rawBill = flows.bill;

      recalculatedSummaries.push({
        month: cycle.statementMonth,
        start: cycle.periodStart,
        end: cycle.periodEnd,
        due: cycle.dueDate,
        bill: rawBill,
        paid: 0,
        remain: 0,
        overpaid: 0,
        expenseAbs,
        income,
        isCurrentCycle: today >= cycle.periodStart && today < addDaysUtc(cycle.periodEnd, 1),
      });
    }

    const summariesWithPaid = applyNextCyclePaidToCreditBillSummaries(recalculatedSummaries);
    const summaryByMonth = new Map(summariesWithPaid.map((summary) => [summary.month, summary]));
    const creditCascade = computeCreditBillCascade({
      monthsForCascade: adjustedCycles.map((cycle) => cycle.statementMonth),
      summaryByMonth,
      overrides: overrides.map((override) => ({
        statementMonth: override.statementMonth,
        amount: toNumber(override.amount),
      })),
    });
    const cycleRows = buildCreditCardCyclePersistRows({
      billingDay,
      repaymentDay,
      repaymentOffsetDays,
      months: creditCascade.allMonthsForCascade,
      summaryByMonth,
      effectiveBillByMonth: creditCascade.effectiveBillByMonth,
      cumulativeByMonth: creditCascade.cumulativeByMonth,
      overrideByMonth: creditCascade.overrideByMonth,
      now: new Date(),
    });
    const cycleIdByMonth = new Map(adjustedCycles.map((cycle) => [cycle.statementMonth, cycle.id]));
    const adjustedCycleByMonth = new Map(adjustedCycles.map((cycle) => [cycle.statementMonth, cycle]));
    const changedMonthSet = new Set(changedCycles.map((cycle) => cycle.statementMonth));
    const overrideStatementMonthSet = new Set(overrides.map((override) => override.statementMonth));

    await prisma.$transaction(async (tx) => {
      for (const cycle of cycleRows) {
        const id = cycleIdByMonth.get(cycle.statementMonth);
        if (!id) continue;
        const adjustedCycle = adjustedCycleByMonth.get(cycle.statementMonth);
        const lockSource = mergeCreditCardCycleLockSources(cycle.lockSource, adjustedCycle?.lockSource);
        const isLocked = cycle.isLocked || Boolean(adjustedCycle?.isLocked);
        await tx.creditCardCycle.update({
          where: { id },
          data: {
            periodStart: cycle.periodStart,
            periodEnd: cycle.periodEnd,
            dueDate: cycle.dueDate,
            expenseAbs: String(cycle.expenseAbs),
            income: String(cycle.income),
            paid: String(cycle.paid),
            rawBill: String(cycle.rawBill),
            effectiveBill: String(cycle.effectiveBill),
            cumulativeRemain: String(cycle.cumulativeRemain),
            cumulativeOverpaid: String(cycle.cumulativeOverpaid),
            isCurrentCycle: cycle.isCurrentCycle,
            isLocked,
            lockSource,
          },
        });
      }
    });
    await invalidateCreditCardCycleCacheForAccountIds(otherSettingsAccountIds, { deleteManualCycles: false });

    revalidateAfterTxChange();
    revalidateAfterSettingsChange();
    return NextResponse.json({
      ok: true,
      data: {
        accountId: storageAccountId,
        billAccountIds,
        statementMonth,
        billingDay,
        repaymentDay,
        repaymentOffsetDays,
        updatedCycles: changedCycles.length,
        updatedRows: cycleRows
          .filter((cycle) => changedMonthSet.has(cycle.statementMonth))
          .map((cycle) => {
            const adjustedCycle = adjustedCycleByMonth.get(cycle.statementMonth);
            const periodStart = adjustedCycle?.periodStart ?? cycle.periodStart;
            const periodEnd = adjustedCycle?.periodEnd ?? cycle.periodEnd;
            const due = adjustedCycle?.dueDate ?? cycle.dueDate;
            return {
              month: cycle.statementMonth,
              periodStart: formatDateUtc(periodStart),
              periodEnd: formatDateUtc(periodEnd),
              dueDate: due ? formatDateUtc(due) : "",
              periodLabel: `${mdUtcDots(periodStart)} ~ ${mdUtcDots(periodEnd)}`,
              dueLabel: due ? formatDateUtc(due) : "-",
              expenseAbs: cycle.expenseAbs,
              income: cycle.income,
              paid: cycle.paid,
              effectiveBill: cycle.effectiveBill,
              isCurrentCycle: cycle.isCurrentCycle,
              hasOverride: overrideStatementMonthSet.has(cycle.statementMonth),
            };
          }),
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "更新账单周期失败" }, { status: 500 });
  }
}
