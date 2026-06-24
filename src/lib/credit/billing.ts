import { addDaysUtc, clampDay, startOfDayUtc } from "@/lib/date-utils";

export type CreditBillSummary = {
  month: string;
  start: Date;
  end: Date;
  due: Date | null;
  bill: number;
  paid: number;
  remain: number;
  overpaid: number;
  expenseAbs: number;
  income: number;
  isCurrentCycle: boolean;
};

export type CreditBillCascadeRow = {
  month: string;
  bill: number;
  paid: number;
};

export type CreditBillOverrideInput = {
  statementMonth?: string | null;
  amount: number;
};

export type CreditBillCumulative = {
  cumulativeRemain: number;
  cumulativeOverpaid: number;
};

export type CreditCardCyclePersistRow = {
  statementMonth: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date | null;
  expenseAbs: number;
  income: number;
  paid: number;
  rawBill: number;
  effectiveBill: number;
  cumulativeRemain: number;
  cumulativeOverpaid: number;
  isCurrentCycle: boolean;
  isLocked: boolean;
  lockSource: string | null;
};

export function cycleForStatementMonth(
  statementMonth: string,
  billingDay: number,
  repaymentDay: number | null | undefined,
  now: Date,
) {
  const today = startOfDayUtc(now);
  const match = statementMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return null;

  const end = new Date(Date.UTC(year, monthIndex, clampDay(year, monthIndex, billingDay)));
  const prevEnd = new Date(Date.UTC(year, monthIndex - 1, clampDay(year, monthIndex - 1, billingDay)));
  const start = addDaysUtc(prevEnd, 1);
  const nextEnd = addDaysUtc(end, 1);
  const isCurrentCycle = today.getTime() >= start.getTime() && today.getTime() < nextEnd.getTime();

  const due =
    repaymentDay && repaymentDay >= 1
      ? (() => {
          const dueMonthOffset = repaymentDay <= billingDay ? 1 : 0;
          const dueMonth = end.getUTCMonth() + dueMonthOffset;
          const dueYear = end.getUTCFullYear() + Math.floor(dueMonth / 12);
          const dueMonthNorm = ((dueMonth % 12) + 12) % 12;
          return new Date(Date.UTC(dueYear, dueMonthNorm, clampDay(dueYear, dueMonthNorm, repaymentDay)));
        })()
      : null;

  return { start, end, due, today, isCurrentCycle };
}

export function fillMissingCreditBillSummaries(params: {
  months: string[];
  summaryByMonth: Map<string, CreditBillSummary>;
  billingDay: number;
  repaymentDay?: number | null;
  now: Date;
}) {
  const { months, summaryByMonth, billingDay, repaymentDay, now } = params;

  return months
    .map((month) => {
      const existing = summaryByMonth.get(month);
      if (existing) return existing;

      const base = cycleForStatementMonth(month, billingDay, repaymentDay ?? null, now);
      if (!base) return null;

      return {
        month,
        start: base.start,
        end: base.end,
        due: base.due,
        bill: 0,
        paid: 0,
        remain: 0,
        overpaid: 0,
        expenseAbs: 0,
        income: 0,
        isCurrentCycle: base.isCurrentCycle,
      } satisfies CreditBillSummary;
    })
    .filter((item): item is CreditBillSummary => !!item);
}

export function computeCreditBillCascade(params: {
  monthsForCascade: string[];
  summaryByMonth: Map<string, Pick<CreditBillSummary, "bill" | "paid">>;
  overrides: CreditBillOverrideInput[];
}) {
  const { monthsForCascade, summaryByMonth, overrides } = params;

  const overrideByMonth = new Map<string, number>(
    overrides
      .filter((item): item is { statementMonth: string; amount: number } => !!item.statementMonth)
      .map((item) => [item.statementMonth, Number(item.amount)]),
  );

  const allMonthsForCascade: CreditBillCascadeRow[] = Array.from(new Set(monthsForCascade))
    .sort((a, b) => a.localeCompare(b))
    .map((month) => {
      const summary = summaryByMonth.get(month);
      return {
        month,
        bill: summary?.bill ?? 0,
        paid: summary?.paid ?? 0,
      };
    });

  const effectiveBillByMonth = new Map<string, number>();
  let prevEffective = 0;
  for (const row of allMonthsForCascade) {
    const override = overrideByMonth.get(row.month);
    const effective = override !== undefined ? override : prevEffective + row.bill;
    effectiveBillByMonth.set(row.month, effective);
    prevEffective = effective;
  }

  const cumulativeByMonth = new Map<string, CreditBillCumulative>();
  for (const row of allMonthsForCascade) {
    const effectiveBill = effectiveBillByMonth.get(row.month) ?? row.bill;
    const afterPaid = effectiveBill - row.paid;
    cumulativeByMonth.set(row.month, {
      cumulativeRemain: Math.max(0, afterPaid),
      cumulativeOverpaid: Math.max(0, -afterPaid),
    });
  }

  return {
    overrideByMonth,
    allMonthsForCascade,
    effectiveBillByMonth,
    cumulativeByMonth,
  };
}

export function mergeCreditBillSummariesWithCascade(
  summaries: CreditBillSummary[],
  effectiveBillByMonth: Map<string, number>,
  cumulativeByMonth: Map<string, CreditBillCumulative>,
) {
  return summaries.map((summary) => {
    const cumulative = cumulativeByMonth.get(summary.month);
    const effectiveBill = effectiveBillByMonth.get(summary.month) ?? summary.bill;
    return {
      ...summary,
      effectiveBill,
      cumulativeRemain: cumulative?.cumulativeRemain ?? summary.remain,
      cumulativeOverpaid: cumulative?.cumulativeOverpaid ?? summary.overpaid,
    };
  });
}

export function buildCreditCardCyclePersistRows(params: {
  billingDay: number;
  repaymentDay?: number | null;
  months: CreditBillCascadeRow[];
  summaryByMonth: ReadonlyMap<string, CreditBillSummary>;
  effectiveBillByMonth: Map<string, number>;
  cumulativeByMonth: Map<string, CreditBillCumulative>;
  overrideByMonth: Map<string, number>;
  now: Date;
}) {
  const {
    billingDay,
    repaymentDay,
    months,
    summaryByMonth,
    effectiveBillByMonth,
    cumulativeByMonth,
    overrideByMonth,
    now,
  } = params;

  return months
    .map((row) => {
      const summary = summaryByMonth.get(row.month);
      const cycle = summary ?? cycleForStatementMonth(row.month, billingDay, repaymentDay ?? null, now);
      if (!cycle) return null;

      const effectiveBill = effectiveBillByMonth.get(row.month) ?? row.bill;
      const cumulative = cumulativeByMonth.get(row.month);
      const hasOverride = overrideByMonth.has(row.month);

      return {
        statementMonth: row.month,
        periodStart: cycle.start,
        periodEnd: cycle.end,
        dueDate: cycle.due ?? null,
        expenseAbs: summary?.expenseAbs ?? 0,
        income: summary?.income ?? 0,
        paid: summary?.paid ?? row.paid,
        rawBill: summary?.bill ?? row.bill,
        effectiveBill,
        cumulativeRemain: cumulative?.cumulativeRemain ?? 0,
        cumulativeOverpaid: cumulative?.cumulativeOverpaid ?? 0,
        isCurrentCycle: cycle.isCurrentCycle,
        isLocked: hasOverride,
        lockSource: hasOverride ? "override" : null,
      } satisfies CreditCardCyclePersistRow;
    })
    .filter((row): row is CreditCardCyclePersistRow => !!row);
}
