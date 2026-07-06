export type ScheduledTaskType = "fund_regular_invest" | "loan_repayment" | "transfer" | "insurance_premium";

export type ScheduledTaskPayload = {
  type: ScheduledTaskType;
  title?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  insuranceProductId?: string | null;
  annualRate?: number | null;
  mortgageLprDiscount?: number | null;
  repaymentMethod?: string | null;
  repaymentIntervalMonths?: number | null;
  originalTotalRuns?: number | null;
  loanRateAdjustments?: Array<{
    effectiveDate: string;
    annualRate: number;
  }>;
};

const SCHEDULED_TASK_MEMO_PREFIX = "MMH_SCHEDULED_TASK:";

export const SCHEDULED_TASK_TYPE_LABEL: Record<ScheduledTaskType, string> = {
  fund_regular_invest: "基金定投",
  loan_repayment: "还贷款",
  transfer: "转账",
  insurance_premium: "保费缴费",
};

export function normalizeScheduledTaskType(value: unknown): ScheduledTaskType {
  if (
    value === "fund_regular_invest" ||
    value === "loan_repayment" ||
    value === "transfer" ||
    value === "insurance_premium"
  ) {
    return value;
  }
  return "fund_regular_invest";
}

export function encodeScheduledTaskMemo(payload: ScheduledTaskPayload) {
  return `${SCHEDULED_TASK_MEMO_PREFIX}${JSON.stringify(payload)}`;
}

export function decodeScheduledTaskMemo(memo?: string | null): ScheduledTaskPayload {
  const value = String(memo ?? "").trim();
  if (!value.startsWith(SCHEDULED_TASK_MEMO_PREFIX)) return { type: "fund_regular_invest" };

  try {
    const parsed = JSON.parse(value.slice(SCHEDULED_TASK_MEMO_PREFIX.length)) as Partial<ScheduledTaskPayload>;
    const rawMortgageLprDiscount = parsed.mortgageLprDiscount as unknown;
    const mortgageLprDiscount =
      typeof rawMortgageLprDiscount === "number" && Number.isFinite(rawMortgageLprDiscount)
        ? rawMortgageLprDiscount
        : typeof rawMortgageLprDiscount === "string" &&
            rawMortgageLprDiscount.trim() &&
            Number.isFinite(Number(rawMortgageLprDiscount))
          ? Number(rawMortgageLprDiscount)
          : null;
    const type = normalizeScheduledTaskType(parsed.type);
    if (type) {
      return {
        type,
        title: parsed.title ?? null,
        fromAccountId: parsed.fromAccountId ?? null,
        toAccountId: parsed.toAccountId ?? null,
        insuranceProductId: parsed.insuranceProductId ?? null,
        annualRate: typeof parsed.annualRate === "number" && Number.isFinite(parsed.annualRate) ? parsed.annualRate : null,
        mortgageLprDiscount,
        repaymentMethod: typeof parsed.repaymentMethod === "string" ? parsed.repaymentMethod : null,
        repaymentIntervalMonths: typeof parsed.repaymentIntervalMonths === "number" && Number.isFinite(parsed.repaymentIntervalMonths) ? parsed.repaymentIntervalMonths : null,
        originalTotalRuns: typeof parsed.originalTotalRuns === "number" && Number.isFinite(parsed.originalTotalRuns) && parsed.originalTotalRuns > 0
          ? Math.floor(parsed.originalTotalRuns)
          : null,
        loanRateAdjustments: Array.isArray(parsed.loanRateAdjustments)
          ? parsed.loanRateAdjustments
              .map((item) => ({
                effectiveDate: typeof item?.effectiveDate === "string" ? item.effectiveDate.slice(0, 10) : "",
                annualRate: typeof item?.annualRate === "number" && Number.isFinite(item.annualRate) ? item.annualRate : NaN,
              }))
              .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && Number.isFinite(item.annualRate) && item.annualRate > 0)
              .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
          : [],
      };
    }
  } catch {
    // Legacy free-text memo: treat it as a fund regular-invest task.
  }

  return { type: "fund_regular_invest" };
}

export function scheduledTaskTypeLabel(type?: string | null) {
  return SCHEDULED_TASK_TYPE_LABEL[(type as ScheduledTaskType) || "fund_regular_invest"] ?? "计划任务";
}
