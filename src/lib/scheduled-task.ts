export type ScheduledTaskType = "fund_regular_invest" | "loan_repayment" | "transfer" | "insurance_premium";

export type ScheduledTaskPayload = {
  type: ScheduledTaskType;
  title?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  insuranceProductId?: string | null;
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
    const type = normalizeScheduledTaskType(parsed.type);
    if (type) {
      return {
        type,
        title: parsed.title ?? null,
        fromAccountId: parsed.fromAccountId ?? null,
        toAccountId: parsed.toAccountId ?? null,
        insuranceProductId: parsed.insuranceProductId ?? null,
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
