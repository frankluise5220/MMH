import { getLoanScheduledPlanRole, type ScheduledTaskPayload, type ScheduledTaskType } from "@/lib/scheduled-task";

/**
 * Outflow scheduled tasks: running one really takes money **out of an account**, so
 * "is the balance enough?" is a meaningful question for exactly these.
 *
 * This list must stay in sync with `OUTFLOW_REMINDER_KINDS` in
 * `src/lib/notifications.ts` — `ReminderKind` is a subset of `ScheduledTaskType`
 * using the same literals. Adding an outflow type in one place without the other
 * splits the two rules (the notification panel warns about a balance the executor
 * happily overdraws).
 */
export const OUTFLOW_SCHEDULED_TASK_TYPES: readonly ScheduledTaskType[] = [
  "fund_regular_invest",
  "loan_repayment",
  "transfer",
  "insurance_premium",
  "expense",
];

const OUTFLOW_SCHEDULED_TASK_TYPE_SET = new Set<string>(OUTFLOW_SCHEDULED_TASK_TYPES);

export function isOutflowScheduledTaskType(type: ScheduledTaskType | string | null | undefined): boolean {
  return typeof type === "string" && OUTFLOW_SCHEDULED_TASK_TYPE_SET.has(type);
}

/** Money epsilon: half a cent short is not an insufficient balance. */
export const SCHEDULED_TASK_BALANCE_EPSILON = 0.005;

/**
 * Whether the amount to withdraw exceeds the available balance.
 *
 * A missing or non-finite amount/balance returns false (never blocks). The balance
 * guard must only stop a task whose shortfall is actually computable — never park a
 * plan forever because the number could not be read.
 */
export function isScheduledTaskBalanceInsufficient(
  amount: number,
  balance: number | null | undefined,
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (typeof balance !== "number" || !Number.isFinite(balance)) return false;
  return amount > balance + SCHEDULED_TASK_BALANCE_EPSILON;
}

/**
 * The **funding account** of an outflow scheduled task — same rule as the executor
 * in `scheduled-task-executor`:
 * - fixed expense: booked on the plan's own account (`accountId`);
 * - fixed income: incoming, no balance question;
 * - transfer / insurance premium / fund regular invest / auto-debit loan repayment:
 *   debited from the cash account (`cashAccountId`);
 * - bill-only loan plans (`bill` role) move no money, so they never take part.
 * `null` means this plan does not spend from an account and can never be "insufficient".
 */
export function scheduledTaskFundingAccountId(
  plan: { accountId: string; cashAccountId?: string | null },
  task: ScheduledTaskPayload,
): string | null {
  if (!isOutflowScheduledTaskType(task.type)) return null;
  if (task.type === "loan_repayment" && getLoanScheduledPlanRole(task) === "bill") return null;
  if (task.type === "expense") return plan.accountId ?? null;
  return plan.cashAccountId ?? null;
}
