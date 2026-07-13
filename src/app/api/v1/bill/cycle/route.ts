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
 * 更新某一期信用卡账单周期，并从该期开始按新的账单日/还款日重排后续已存在周期。
 * 接受的实体类型: Account.id + CreditCardCycle.statementMonth
 */
import { NextResponse } from "next/server";
import { AccountKind, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { addDaysUtc, clampDay, formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import {
  getCreditBillAccountIds,
  syncCreditCardInstitutionSettings,
} from "@/lib/server/credit-card-institution-settings";

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

function cycleEndForMonth(statementMonth: string, billingDay: number) {
  const parsed = statementMonthDate(statementMonth);
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.year, parsed.monthIndex, clampDay(parsed.year, parsed.monthIndex, billingDay)));
}

function dueForCycle(periodEnd: Date, billingDay: number, repaymentDay: number | null) {
  if (!repaymentDay || repaymentDay < 1) return null;
  const dueMonthOffset = repaymentDay <= billingDay ? 1 : 0;
  const dueMonth = periodEnd.getUTCMonth() + dueMonthOffset;
  const dueYear = periodEnd.getUTCFullYear() + Math.floor(dueMonth / 12);
  const dueMonthNorm = ((dueMonth % 12) + 12) % 12;
  return new Date(Date.UTC(dueYear, dueMonthNorm, clampDay(dueYear, dueMonthNorm, repaymentDay)));
}

export async function PATCH(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });

    const accountId = String(body.accountId ?? "").trim();
    const statementMonth = String(body.statementMonth ?? "").trim();
    const periodStart = parseDateOnly(body.periodStart);
    const periodEnd = parseDateOnly(body.periodEnd);
    const dueDate = body.dueDate ? parseDateOnly(body.dueDate) : null;

    if (!accountId || !statementMonth) return NextResponse.json({ ok: false, error: "缺少账户或账单月份" }, { status: 400 });
    if (!statementMonthDate(statementMonth)) return NextResponse.json({ ok: false, error: "账单月份格式不正确" }, { status: 400 });
    if (!periodStart || !periodEnd) return NextResponse.json({ ok: false, error: "账单周期日期格式不正确" }, { status: 400 });
    if (periodStart > periodEnd) return NextResponse.json({ ok: false, error: "周期开始日不能晚于结束日" }, { status: 400 });
    if (dueDate && dueDate < periodEnd) return NextResponse.json({ ok: false, error: "还款日不能早于账单结束日" }, { status: 400 });

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
      },
    });
    if (!account) return NextResponse.json({ ok: false, error: "信用卡账户不存在" }, { status: 404 });
    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const storageAccountId = billAccountIds[0] ?? account.id;

    const cycles = await prisma.creditCardCycle.findMany({
      where: { accountId: storageAccountId },
      orderBy: { statementMonth: "asc" },
    });
    if (!cycles.some((cycle) => cycle.statementMonth === statementMonth)) {
      return NextResponse.json({ ok: false, error: "这一期账单周期不存在，请先生成账单列表" }, { status: 404 });
    }

    const billingDay = periodEnd.getUTCDate();
    const repaymentDay = dueDate ? dueDate.getUTCDate() : null;
    const today = startOfDayUtc(new Date());

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
      const nextEnd = cycleEndForMonth(current.statementMonth, billingDay);
      if (!nextEnd) continue;
      current.periodStart = addDaysUtc(previous.periodEnd, 1);
      current.periodEnd = nextEnd;
      current.dueDate = dueForCycle(nextEnd, billingDay, repaymentDay);
    }

    const changedCycles = adjustedCycles.slice(startIndex);
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
        billingDay,
        repaymentDay,
        creditBillMode: account.creditBillMode,
      });
      if (!account.institutionId) {
        await tx.account.update({
          where: { id: account.id },
          data: { billingDay, repaymentDay },
        });
      }

      await tx.txRecord.updateMany({
        where: {
          deletedAt: null,
          OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }],
          date: { gte: minDate, lt: addDaysUtc(maxDate, 1) },
        },
        data: { statementMonth: null },
      });

      for (const cycle of changedCycles) {
        await tx.txRecord.updateMany({
          where: {
            deletedAt: null,
            OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }],
            date: { gte: cycle.periodStart, lt: addDaysUtc(cycle.periodEnd, 1) },
          },
          data: { statementMonth: cycle.statementMonth },
        });
      }
    });

    const overrides = await prisma.billOverride.findMany({ where: { accountId: storageAccountId } });
    const overrideByMonth = new Map(overrides.map((override) => [override.statementMonth, toNumber(override.amount)]));

    const recalculated: typeof adjustedCycles = [];
    for (const cycle of adjustedCycles) {
      const repayEnd = cycle.dueDate && cycle.dueDate.getTime() < today.getTime() ? cycle.dueDate : today;
      const cycleWindow = {
        OR: [
          { statementMonth: cycle.statementMonth, deletedAt: null },
          { statementMonth: null, date: { gte: cycle.periodStart, lt: addDaysUtc(cycle.periodEnd, 1) }, deletedAt: null },
        ],
      };
      const [expenseAgg, incomeAgg, transferOutAgg, cycleTransferInAgg, paidAgg] = await Promise.all([
        prisma.txRecord.aggregate({
          where: { AND: [cycleWindow, { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] }, { type: TransactionType.expense }] },
          _sum: { amount: true },
        }),
        prisma.txRecord.aggregate({
          where: { AND: [cycleWindow, { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] }, { type: TransactionType.income }] },
          _sum: { amount: true },
        }),
        prisma.txRecord.aggregate({
          where: {
            AND: [
              cycleWindow,
              { accountId: { in: billAccountIds } },
              { type: TransactionType.transfer },
              { amount: { lt: 0 } },
            ],
          },
          _sum: { amount: true },
        }),
        prisma.txRecord.aggregate({
          where: {
            AND: [
              cycleWindow,
              { toAccountId: { in: billAccountIds } },
              { type: TransactionType.transfer },
              { amount: { lt: 0 } },
            ],
          },
          _sum: { amount: true },
        }),
        prisma.txRecord.aggregate({
          where: {
            AND: [
              { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] },
              { type: TransactionType.transfer },
              { toAccountId: { in: billAccountIds } },
              { amount: { lt: 0 } },
              { date: { gte: addDaysUtc(cycle.periodEnd, 1), lt: addDaysUtc(repayEnd, 1) } },
            ],
          },
          _sum: { amount: true },
        }),
      ]);

      const outflow = toNumber(expenseAgg._sum.amount ?? 0) + toNumber(transferOutAgg._sum.amount ?? 0);
      const expenseAbs = Math.max(0, -outflow);
      const income = Math.max(0, toNumber(incomeAgg._sum.amount ?? 0)) + Math.max(0, -toNumber(cycleTransferInAgg._sum.amount ?? 0));
      const netCycle = outflow + toNumber(incomeAgg._sum.amount ?? 0);
      const rawBill = Math.max(0, -netCycle);
      const paid = Math.max(0, -toNumber(paidAgg._sum.amount ?? 0));

      recalculated.push({ ...cycle, expenseAbs, income, paid, rawBill });
    }

    let previousBalance = 0;
    for (const cycle of recalculated) {
      const override = overrideByMonth.get(cycle.statementMonth);
      const effectiveBill = override !== undefined ? override : Math.max(0, previousBalance + cycle.rawBill);
      const afterPaid = effectiveBill - cycle.paid;
      previousBalance = afterPaid;
      cycle.effectiveBill = effectiveBill;
      cycle.cumulativeRemain = Math.max(0, afterPaid);
      cycle.cumulativeOverpaid = Math.max(0, -afterPaid);
      cycle.isCurrentCycle = today >= cycle.periodStart && today < addDaysUtc(cycle.periodEnd, 1);
      cycle.isLocked = override !== undefined;
      cycle.lockSource = override !== undefined ? "override" : null;
    }

    await prisma.$transaction(async (tx) => {
      for (const cycle of recalculated) {
        await tx.creditCardCycle.update({
          where: { id: cycle.id },
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
            isLocked: cycle.isLocked,
            lockSource: cycle.lockSource,
          },
        });
      }
    });

    revalidateAfterTxChange();
    return NextResponse.json({
      ok: true,
      data: {
        accountId: storageAccountId,
        billAccountIds,
        statementMonth,
        billingDay,
        repaymentDay,
        updatedCycles: changedCycles.length,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "更新账单周期失败" }, { status: 500 });
  }
}
