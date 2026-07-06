export function roundLoanMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type LoanRateAdjustment = {
  effectiveDate: string;
  annualRate: number;
};

export function normalizeLoanRateAdjustments(adjustments?: LoanRateAdjustment[] | null) {
  return [...(adjustments ?? [])]
    .map((item) => ({
      effectiveDate: String(item.effectiveDate ?? "").slice(0, 10),
      annualRate: Number(item.annualRate),
    }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && Number.isFinite(item.annualRate) && item.annualRate > 0)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

export function getEffectiveLoanAnnualRate(params: {
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  date: string;
}) {
  let rate = params.baseAnnualRate ?? null;
  for (const item of normalizeLoanRateAdjustments(params.adjustments)) {
    if (item.effectiveDate <= params.date) rate = item.annualRate;
    else break;
  }
  return rate;
}

function dateOnlyToUtcMs(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateOnlyFromUtcMs(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

export function hasLoanRateAdjustmentInPeriod(params: {
  adjustments?: LoanRateAdjustment[] | null;
  startDateExclusive: string;
  endDateInclusive: string;
}) {
  return normalizeLoanRateAdjustments(params.adjustments).some(
    (item) => item.effectiveDate > params.startDateExclusive && item.effectiveDate <= params.endDateInclusive,
  );
}

export function calcLoanPeriodInterestByDailyRate(params: {
  principal: number;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  startDateExclusive: string;
  endDateInclusive: string;
}) {
  const principal = Math.max(0, params.principal);
  const startMs = dateOnlyToUtcMs(params.startDateExclusive);
  const endMs = dateOnlyToUtcMs(params.endDateInclusive);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || principal <= 0) return 0;

  let interest = 0;
  const dayMs = 24 * 60 * 60 * 1000;
  for (let day = startMs + dayMs; day <= endMs; day += dayMs) {
    const date = formatDateOnlyFromUtcMs(day);
    const rate = getEffectiveLoanAnnualRate({
      baseAnnualRate: params.baseAnnualRate,
      adjustments: params.adjustments,
      date,
    });
    if (rate != null && Number.isFinite(rate) && rate > 0) {
      interest += principal * (rate / 100) / 360;
    }
  }
  return roundLoanMoney(interest);
}

export function calcLoanScheduledAmount(params: {
  repaymentMethod?: string | null;
  annualRate?: number | null;
  principal: number;
  totalRuns: number;
  intervalMonths?: number | null;
}) {
  const method = params.repaymentMethod || "自由还款";
  const principal = Math.max(0, params.principal);
  const totalRuns = Math.max(0, params.totalRuns);
  if (
    principal <= 0 ||
    totalRuns <= 0 ||
    params.annualRate == null ||
    !Number.isFinite(params.annualRate) ||
    params.annualRate <= 0
  ) {
    return null;
  }

  const periodRate = (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1);
  if (!Number.isFinite(periodRate) || periodRate <= 0) return null;

  if (method === "等额本金") {
    return roundLoanMoney((principal / totalRuns) + (principal * periodRate));
  }
  if (method === "先还利息一次性还本") {
    return roundLoanMoney(principal * periodRate);
  }
  if (method !== "等额本息") return null;

  const factor = Math.pow(1 + periodRate, totalRuns);
  if (!Number.isFinite(factor) || factor <= 1) return null;
  return roundLoanMoney((principal * periodRate * factor) / (factor - 1));
}

export function calcLoanScheduledAmountExact(params: {
  repaymentMethod?: string | null;
  annualRate?: number | null;
  principal: number;
  totalRuns: number;
  intervalMonths?: number | null;
}) {
  const method = params.repaymentMethod || "自由还款";
  const principal = Math.max(0, params.principal);
  const totalRuns = Math.max(0, params.totalRuns);
  if (
    method !== "等额本息" ||
    principal <= 0 ||
    totalRuns <= 0 ||
    params.annualRate == null ||
    !Number.isFinite(params.annualRate) ||
    params.annualRate <= 0
  ) {
    return null;
  }

  const periodRate = (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1);
  const factor = Math.pow(1 + periodRate, totalRuns);
  if (!Number.isFinite(periodRate) || periodRate <= 0 || !Number.isFinite(factor) || factor <= 1) return null;
  return (principal * periodRate * factor) / (factor - 1);
}

export function calcLoanRunParts(params: {
  repaymentMethod?: string | null;
  annualRate?: number | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  scheduledAmountExact?: number | null;
  remainingPrincipal: number;
  remainingRuns: number;
}) {
  const method = params.repaymentMethod || "自由还款";
  const remainingPrincipal = Math.max(0, params.remainingPrincipal);
  const remainingRuns = Math.max(1, params.remainingRuns);
  const periodRate =
    params.annualRate != null && Number.isFinite(params.annualRate) && params.annualRate > 0
      ? (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1)
      : 0;
  const interest = periodRate > 0 ? roundLoanMoney(remainingPrincipal * periodRate) : 0;

  if (method === "先还利息一次性还本") {
    return {
      principal: remainingRuns <= 1 ? roundLoanMoney(remainingPrincipal) : 0,
      interest,
    };
  }

  if (method === "等额本金") {
    return {
      principal: roundLoanMoney(Math.min(remainingPrincipal, remainingPrincipal / remainingRuns)),
      interest,
    };
  }

  const scheduledAmount = Math.max(0, params.scheduledAmount);
  const scheduledAmountExact =
    params.scheduledAmountExact != null && Number.isFinite(params.scheduledAmountExact) && params.scheduledAmountExact > 0
      ? params.scheduledAmountExact
      : scheduledAmount;
  const principalExact = Math.min(remainingPrincipal, Math.max(0, scheduledAmountExact - interest));
  const principal = roundLoanMoney(principalExact);
  return {
    principal,
    principalExact,
    interest,
  };
}

export function calcLoanScheduledAmountForPeriodStart(params: {
  repaymentMethod?: string | null;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  remainingPrincipal: number;
  remainingRuns: number;
  periodStartDate?: string | null;
}) {
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  if (!params.periodStartDate || !adjustments.some((item) => item.effectiveDate <= params.periodStartDate!)) {
    return params.scheduledAmount;
  }
  const annualRate = getEffectiveLoanAnnualRate({
    baseAnnualRate: params.baseAnnualRate,
    adjustments,
    date: params.periodStartDate,
  });
  return (
    calcLoanScheduledAmount({
      repaymentMethod: params.repaymentMethod,
      annualRate,
      principal: params.remainingPrincipal,
      totalRuns: params.remainingRuns,
      intervalMonths: params.intervalMonths,
    }) ?? params.scheduledAmount
  );
}

export function calcLoanRunPartsWithRateAdjustments(params: {
  repaymentMethod?: string | null;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  scheduledAmountExact?: number | null;
  remainingPrincipal: number;
  remainingRuns: number;
  previousRunDate?: string | null;
  runDate: string;
}) {
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  const remainingPrincipal = Math.max(0, params.remainingPrincipal);
  const remainingRuns = Math.max(1, params.remainingRuns);
  const effectiveAnnualRate = getEffectiveLoanAnnualRate({
    baseAnnualRate: params.baseAnnualRate,
    adjustments,
    date: params.runDate,
  });
  const scheduledAmount =
    calcLoanScheduledAmount({
      repaymentMethod: params.repaymentMethod,
      annualRate: effectiveAnnualRate,
      principal: remainingPrincipal,
      totalRuns: remainingRuns,
      intervalMonths: params.intervalMonths,
    }) ?? params.scheduledAmount;
  const scheduledAmountExact =
    calcLoanScheduledAmountExact({
      repaymentMethod: params.repaymentMethod,
      annualRate: effectiveAnnualRate,
      principal: remainingPrincipal,
      totalRuns: remainingRuns,
      intervalMonths: params.intervalMonths,
    }) ?? params.scheduledAmountExact ?? scheduledAmount;

  if (
    params.previousRunDate &&
    hasLoanRateAdjustmentInPeriod({
      adjustments,
      startDateExclusive: params.previousRunDate,
      endDateInclusive: params.runDate,
    })
  ) {
    const periodStartAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: params.baseAnnualRate,
      adjustments,
      date: params.previousRunDate,
    });
    const periodStartScheduledAmount =
      calcLoanScheduledAmount({
        repaymentMethod: params.repaymentMethod,
        annualRate: periodStartAnnualRate,
        principal: remainingPrincipal,
        totalRuns: remainingRuns,
        intervalMonths: params.intervalMonths,
      }) ?? params.scheduledAmount;
    const periodStartScheduledAmountExact =
      calcLoanScheduledAmountExact({
        repaymentMethod: params.repaymentMethod,
        annualRate: periodStartAnnualRate,
        principal: remainingPrincipal,
        totalRuns: remainingRuns,
        intervalMonths: params.intervalMonths,
      }) ?? params.scheduledAmountExact ?? periodStartScheduledAmount;
    const periodStartParts = calcLoanRunParts({
      repaymentMethod: params.repaymentMethod,
      annualRate: periodStartAnnualRate,
      intervalMonths: params.intervalMonths,
      scheduledAmount: periodStartScheduledAmount,
      scheduledAmountExact: periodStartScheduledAmountExact,
      remainingPrincipal,
      remainingRuns,
    });
    const interest = calcLoanPeriodInterestByDailyRate({
      principal: remainingPrincipal,
      baseAnnualRate: params.baseAnnualRate,
      adjustments,
      startDateExclusive: params.previousRunDate,
      endDateInclusive: params.runDate,
    });
    const principal = roundLoanMoney(Math.min(remainingPrincipal, Math.max(0, periodStartParts.principal)));
    return {
      principal,
      interest,
      payment: roundLoanMoney(principal + interest),
      annualRate: effectiveAnnualRate,
      scheduledAmount,
      scheduledAmountExact,
      principalExact: periodStartParts.principalExact,
      usedDailyInterest: true,
    };
  }

  const parts = calcLoanRunParts({
    repaymentMethod: params.repaymentMethod,
    annualRate: effectiveAnnualRate,
    intervalMonths: params.intervalMonths,
    scheduledAmount,
    scheduledAmountExact,
    remainingPrincipal,
    remainingRuns,
  });
  return {
    principal: parts.principal,
    interest: parts.interest,
    payment: roundLoanMoney(parts.principal + parts.interest),
    annualRate: effectiveAnnualRate,
    scheduledAmount,
    scheduledAmountExact,
    principalExact: parts.principalExact,
    usedDailyInterest: false,
  };
}
