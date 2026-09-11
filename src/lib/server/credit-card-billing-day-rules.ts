import { AccountKind, type Prisma } from "@prisma/client";

import { startOfDayUtc } from "@/lib/date-utils";
import {
  CREDIT_CARD_BILLING_DAY_INITIAL_DATE,
  CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
  CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
  creditCardBillingDayFromCycleEndDate,
  hasCreditCardCycleLockSource,
} from "@/lib/credit/billing";

const MIN_BILLING_DAY = 1;
const MAX_BILLING_DAY = 31;

type Writer = Prisma.TransactionClient;

type BillingDayRuleInput = {
  accountIds: readonly string[];
  billingDay: number | null | undefined;
  effectiveDate?: Date | null;
};

type BillingDayRuleRow = {
  id?: string;
  accountId: string;
  effectiveDate: Date;
  billingDay: number;
  updatedAt?: Date;
};

type CreditCardBillingDayEvidenceAccount = {
  id: string;
  billingDay: number | null;
};

function uniqueAccountIds(accountIds: readonly string[]) {
  return Array.from(new Set(accountIds.filter(Boolean)));
}

export function normalizeCreditCardBillingDay(value: number | null | undefined) {
  if (value == null) return null;
  const day = Math.trunc(value);
  return day >= MIN_BILLING_DAY && day <= MAX_BILLING_DAY ? day : null;
}

function activeBillingDayFromRows(
  rows: readonly BillingDayRuleRow[],
  asOf: Date,
) {
  const normalized = rows
    .map((row) => ({
      effectiveDate: startOfDayUtc(row.effectiveDate),
      billingDay: normalizeCreditCardBillingDay(row.billingDay),
    }))
    .filter((row): row is { effectiveDate: Date; billingDay: number } => row.billingDay != null)
    .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
  if (normalized.length === 0) return null;

  const target = startOfDayUtc(asOf).getTime();
  let active = normalized[0]!;
  for (const row of normalized) {
    if (row.effectiveDate.getTime() > target) break;
    active = row;
  }
  return active.billingDay;
}

function sameUtcDay(a: Date, b: Date) {
  return startOfDayUtc(a).getTime() === startOfDayUtc(b).getTime();
}

function hasLockedCycleEvidence(lockSource: string | null | undefined) {
  return (
    hasCreditCardCycleLockSource(lockSource, CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE) ||
    hasCreditCardCycleLockSource(lockSource, CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE)
  );
}

async function inferBillingDayEffectiveDatesFromLockedCycles(
  writer: Writer,
  accounts: readonly CreditCardBillingDayEvidenceAccount[],
) {
  const accountIds = uniqueAccountIds(accounts.map((account) => account.id));
  const targetBillingDayByAccountId = new Map(
    accounts
      .map((account) => [account.id, normalizeCreditCardBillingDay(account.billingDay)] as const)
      .filter(([, billingDay]) => billingDay != null),
  );
  if (accountIds.length === 0 || targetBillingDayByAccountId.size === 0) return new Map<string, Date>();

  const cycles = await writer.creditCardCycle.findMany({
    where: {
      accountId: { in: accountIds },
      isLocked: true,
      OR: [
        { lockSource: { contains: CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE } },
        { lockSource: { contains: CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE } },
      ],
    },
    select: {
      accountId: true,
      periodStart: true,
      periodEnd: true,
      lockSource: true,
    },
    orderBy: [{ accountId: "asc" }, { periodStart: "asc" }],
  });

  const inferred = new Map<string, Date>();
  for (const cycle of cycles) {
    if (inferred.has(cycle.accountId) || !hasLockedCycleEvidence(cycle.lockSource)) continue;
    const targetBillingDay = targetBillingDayByAccountId.get(cycle.accountId);
    if (targetBillingDay == null) continue;
    const periodStart = startOfDayUtc(cycle.periodStart);
    const periodEnd = startOfDayUtc(cycle.periodEnd);
    if (periodStart.getTime() > periodEnd.getTime()) continue;
    if (creditCardBillingDayFromCycleEndDate(periodEnd) !== targetBillingDay) continue;
    inferred.set(cycle.accountId, periodStart);
  }
  return inferred;
}

async function moveLaterMatchingRuleToEvidenceDate(
  writer: Writer,
  accountRows: BillingDayRuleRow[],
  billingDay: number,
  evidenceDate: Date,
) {
  const existingAtEvidenceDate = accountRows.find((row) => sameUtcDay(row.effectiveDate, evidenceDate));
  if (existingAtEvidenceDate) {
    if (normalizeCreditCardBillingDay(existingAtEvidenceDate.billingDay) === billingDay) return false;
    if (!existingAtEvidenceDate.id) return false;
    await writer.creditCardBillingDay.update({
      where: { id: existingAtEvidenceDate.id },
      data: { billingDay },
    });
    existingAtEvidenceDate.billingDay = billingDay;
    return true;
  }

  const evidenceTime = startOfDayUtc(evidenceDate).getTime();
  const target = accountRows
    .filter((row) => row.id && normalizeCreditCardBillingDay(row.billingDay) === billingDay)
    .filter((row) => startOfDayUtc(row.effectiveDate).getTime() > evidenceTime)
    .sort((a, b) => startOfDayUtc(a.effectiveDate).getTime() - startOfDayUtc(b.effectiveDate).getTime())[0];
  if (!target?.id) return false;

  await writer.creditCardBillingDay.update({
    where: { id: target.id },
    data: { effectiveDate: evidenceDate },
  });
  target.effectiveDate = evidenceDate;
  return true;
}

export async function ensureInitialCreditCardBillingDayRules(
  writer: Writer,
  input: BillingDayRuleInput,
) {
  const billingDay = normalizeCreditCardBillingDay(input.billingDay);
  if (!billingDay || input.accountIds.length === 0) return;

  for (const accountId of uniqueAccountIds(input.accountIds)) {
    await writer.creditCardBillingDay.upsert({
      where: {
        accountId_effectiveDate: {
          accountId,
          effectiveDate: CREDIT_CARD_BILLING_DAY_INITIAL_DATE,
        },
      },
      create: {
        accountId,
        effectiveDate: CREDIT_CARD_BILLING_DAY_INITIAL_DATE,
        billingDay,
      },
      update: {},
    });
  }
}

export async function recordCreditCardBillingDayChange(
  writer: Writer,
  input: BillingDayRuleInput,
) {
  const billingDay = normalizeCreditCardBillingDay(input.billingDay);
  if (!billingDay || input.accountIds.length === 0) return;
  const effectiveDate = input.effectiveDate
    ? startOfDayUtc(input.effectiveDate)
    : startOfDayUtc(new Date());

  for (const accountId of uniqueAccountIds(input.accountIds)) {
    await writer.creditCardBillingDay.upsert({
      where: {
        accountId_effectiveDate: {
          accountId,
          effectiveDate,
        },
      },
      create: {
        accountId,
        effectiveDate,
        billingDay,
      },
      update: {
        billingDay,
      },
    });
  }
}

export async function syncCreditCardBillingDaysFromRules(
  writer: Writer,
  input: {
    accountIds: readonly string[];
    asOf?: Date;
  },
) {
  const accountIds = uniqueAccountIds(input.accountIds);
  if (accountIds.length === 0) return new Map<string, number | null>();

  const asOf = input.asOf ?? new Date();
  const [accounts, rows] = await Promise.all([
    writer.account.findMany({
      where: { id: { in: accountIds }, kind: AccountKind.bank_credit },
      select: { id: true, billingDay: true },
    }),
    writer.creditCardBillingDay.findMany({
      where: { accountId: { in: accountIds } },
      select: { accountId: true, effectiveDate: true, billingDay: true },
      orderBy: [{ accountId: "asc" }, { effectiveDate: "asc" }],
    }),
  ]);
  const currentBillingDayByAccountId = new Map(
    accounts.map((account) => [account.id, account.billingDay] as const),
  );
  const rowsByAccountId = new Map<string, BillingDayRuleRow[]>();
  for (const row of rows) {
    const accountRows = rowsByAccountId.get(row.accountId) ?? [];
    accountRows.push(row);
    rowsByAccountId.set(row.accountId, accountRows);
  }

  const billingDayByAccountId = new Map<string, number | null>();
  const accountIdsByBillingDay = new Map<number | null, string[]>();
  for (const accountId of accountIds) {
    const billingDay = activeBillingDayFromRows(rowsByAccountId.get(accountId) ?? [], asOf);
    billingDayByAccountId.set(accountId, billingDay);
    if (!currentBillingDayByAccountId.has(accountId)) continue;
    if ((currentBillingDayByAccountId.get(accountId) ?? null) === billingDay) continue;
    const grouped = accountIdsByBillingDay.get(billingDay) ?? [];
    grouped.push(accountId);
    accountIdsByBillingDay.set(billingDay, grouped);
  }

  for (const [billingDay, ids] of accountIdsByBillingDay) {
    await writer.account.updateMany({
      where: { id: { in: ids }, kind: AccountKind.bank_credit },
      data: { billingDay },
    });
  }

  return billingDayByAccountId;
}

export async function reconcileCreditCardBillingDayRulesFromAccounts(
  writer: Writer,
  input: {
    householdId: string;
    accountIds: readonly string[];
    asOf?: Date;
  },
) {
  const accountIds = uniqueAccountIds(input.accountIds);
  if (accountIds.length === 0) return { repairedRules: 0, syncedAccounts: 0 };

  const accounts = await writer.account.findMany({
    where: {
      id: { in: accountIds },
      householdId: input.householdId,
      kind: AccountKind.bank_credit,
    },
    select: { id: true, billingDay: true },
  });
  if (accounts.length === 0) return { repairedRules: 0, syncedAccounts: 0 };

  const scopedAccountIds = accounts.map((account) => account.id);
  const rows = await writer.creditCardBillingDay.findMany({
    where: { accountId: { in: scopedAccountIds } },
    select: { id: true, accountId: true, effectiveDate: true, billingDay: true, updatedAt: true },
    orderBy: [{ accountId: "asc" }, { effectiveDate: "asc" }],
  });
  const rowsByAccountId = new Map<string, BillingDayRuleRow[]>();
  for (const row of rows) {
    const accountRows = rowsByAccountId.get(row.accountId) ?? [];
    accountRows.push(row);
    rowsByAccountId.set(row.accountId, accountRows);
  }

  let repairedRules = 0;
  const asOf = input.asOf ?? new Date();
  const cycleEvidenceEffectiveDateByAccountId = await inferBillingDayEffectiveDatesFromLockedCycles(writer, accounts);
  for (const account of accounts) {
    const accountBillingDay = normalizeCreditCardBillingDay(account.billingDay);
    const accountRows = rowsByAccountId.get(account.id) ?? [];
    if (accountBillingDay == null) continue;
    if (accountRows.length === 0) {
      await ensureInitialCreditCardBillingDayRules(writer, {
        accountIds: [account.id],
        billingDay: accountBillingDay,
      });
      repairedRules += 1;
      continue;
    }

    const cycleEvidenceDate = cycleEvidenceEffectiveDateByAccountId.get(account.id);
    if (cycleEvidenceDate) {
      const movedRule = await moveLaterMatchingRuleToEvidenceDate(
        writer,
        accountRows,
        accountBillingDay,
        cycleEvidenceDate,
      );
      if (movedRule) repairedRules += 1;
    }

    const activeBillingDay = activeBillingDayFromRows(accountRows, asOf);
    if (
      activeBillingDay !== accountBillingDay &&
      cycleEvidenceDate &&
      !accountRows.some((row) => sameUtcDay(row.effectiveDate, cycleEvidenceDate))
    ) {
      await recordCreditCardBillingDayChange(writer, {
        accountIds: [account.id],
        billingDay: accountBillingDay,
        effectiveDate: cycleEvidenceDate,
      });
      repairedRules += 1;
    }
  }

  const synced = await syncCreditCardBillingDaysFromRules(writer, {
    accountIds: scopedAccountIds,
    asOf,
  });
  return { repairedRules, syncedAccounts: synced.size };
}
