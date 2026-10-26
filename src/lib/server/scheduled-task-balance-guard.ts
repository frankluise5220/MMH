import { AccountKind, RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { startOfDayUtc, toNumber } from "@/lib/date-utils";
import {
  isScheduledTaskBalanceInsufficient,
  scheduledTaskFundingAccountId,
} from "@/lib/scheduled-task-balance";
import type { ScheduledTaskPayload } from "@/lib/scheduled-task";
import { getMaintainedAccountBalances } from "@/lib/server/account-balance";
import {
  getSystemSetting,
  SCHEDULED_TASK_BALANCE_GUARD_SETTING_NAME,
} from "@/lib/server/system-setting";

/**
 * Scheduled-task **balance guard** (household setting, default off).
 *
 * With the guard on, automatic execution never books a task whose funding account
 * cannot cover it: the plan stays where it is (`nextRunDate` is not advanced, so it
 * stays overdue = the task reads as **failed**), and the user decides whether to
 * spend anyway through the notification panel's "ignore balance and generate".
 *
 * The failure is deliberately **derived**, not a stored plan state:
 * - the truth is the combination of "plan is overdue" + "funding account is short"
 *   + "guard is on", all three recomputable at any time;
 * - a stored `failed` status would add a state machine (is a failed plan still
 *   `active`? does automatic execution retry it?) and a plan that is never retried
 *   is a permanently dead plan;
 * - the manual entry points (`/api/v1/regular-invest/execute`, `/batch-execute`)
 *   never look at the balance, so "force generate" needs no new endpoint.
 */
type ScheduledTaskBalanceGuardPlan = {
  id: string;
  accountId: string;
  cashAccountId: string | null;
  amount: unknown;
  nextRunDate: Date;
  status: string;
  task: ScheduledTaskPayload;
};

export type ScheduledTaskBalanceBlock = {
  planId: string;
  fundingAccountId: string;
  fundingAccountName: string;
  /** Amount to withdraw for this run (positive). */
  amount: number;
  /** Balance still available when this plan was reached (earlier same-account plans deducted). */
  balance: number;
};

async function isScheduledTaskBalanceGuardEnabled(householdId: string): Promise<boolean> {
  const stored = await getSystemSetting(SCHEDULED_TASK_BALANCE_GUARD_SETTING_NAME, { householdId });
  return stored === "true" || stored === "1";
}

/**
 * Plans the balance guard blocks, keyed by plan id.
 *
 * Only `active` plans that are **due** (`nextRunDate` <= today) and belong to an
 * outflow type are considered — a plan that is not due yet cannot have "failed
 * because of the balance". With the guard off the result is always empty, so
 * callers do not read the setting themselves.
 *
 * Plans sharing one funding account deduct from the available balance in due-date
 * order (id as tie-break) instead of each being compared against the full balance:
 * with 1000 available and 600 + 600 due on the same day both would otherwise pass
 * and automatic execution would still overdraw, which makes the guard pointless.
 * "Earliest due first" is reproducible regardless of execution order.
 */
export async function resolveScheduledTaskBalanceBlocks(params: {
  householdId: string;
  plans: ScheduledTaskBalanceGuardPlan[];
  now?: Date;
}): Promise<Map<string, ScheduledTaskBalanceBlock>> {
  const blocks = new Map<string, ScheduledTaskBalanceBlock>();
  if (params.plans.length === 0) return blocks;
  if (!(await isScheduledTaskBalanceGuardEnabled(params.householdId))) return blocks;

  const today = startOfDayUtc(params.now ?? new Date());
  const candidates: Array<{ plan: ScheduledTaskBalanceGuardPlan; fundingAccountId: string }> = [];
  for (const plan of params.plans) {
    if (plan.status !== RegularInvestStatus.active) continue;
    if (startOfDayUtc(plan.nextRunDate) > today) continue;
    const fundingAccountId = scheduledTaskFundingAccountId(plan, plan.task);
    if (!fundingAccountId) continue;
    candidates.push({ plan, fundingAccountId });
  }
  if (candidates.length === 0) return blocks;

  const fundingAccountIds = [...new Set(candidates.map((entry) => entry.fundingAccountId))];
  const accounts = await prisma.account.findMany({
    where: { id: { in: fundingAccountIds }, householdId: params.householdId },
    select: { id: true, name: true, kind: true, investProductType: true, billingDay: true },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const balances = await getMaintainedAccountBalances(accounts, { householdId: params.householdId });

  const ordered = [...candidates].sort(
    (left, right) =>
      left.plan.nextRunDate.getTime() - right.plan.nextRunDate.getTime() ||
      left.plan.id.localeCompare(right.plan.id),
  );
  const availableByAccountId = new Map<string, number>(
    fundingAccountIds.map((id) => [id, balances.get(id) ?? 0]),
  );

  for (const { plan, fundingAccountId } of ordered) {
    const account = accountById.get(fundingAccountId);
    // Account deleted (or from another household): that is not an insufficient
    // balance, so let the executor report its own error instead.
    if (!account) continue;
    // A credit card's "balance" is not a spendable-cash figure (the balance fold
    // always yields 0 for `bank_credit`), so judging with it would warn every day.
    if (account.kind === AccountKind.bank_credit) continue;
    const amount = Math.abs(toNumber(plan.amount));
    if (!(amount > 0)) continue;
    const available = availableByAccountId.get(fundingAccountId) ?? 0;
    if (!isScheduledTaskBalanceInsufficient(amount, available)) {
      availableByAccountId.set(fundingAccountId, available - amount);
      continue;
    }
    blocks.set(plan.id, {
      planId: plan.id,
      fundingAccountId,
      fundingAccountName: account.name,
      amount,
      balance: available,
    });
  }

  return blocks;
}

/** Shared reason text for execution details / receipts. */
export function scheduledTaskBalanceBlockReason(block: ScheduledTaskBalanceBlock): string {
  return `Insufficient balance: ${block.fundingAccountName} has ${block.balance.toFixed(2)}, needs ${block.amount.toFixed(2)}`;
}
