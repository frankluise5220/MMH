import { AccountKind, type Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

const resolutionCache = new Map<string, Map<string, { accountId: string | null; created: boolean }>>();

function debtResolveCacheGet(householdId: string, key: string): { accountId: string | null; created: boolean } | undefined {
  return resolutionCache.get(householdId)?.get(key);
}
function debtResolveCacheSet(householdId: string, key: string, val: { accountId: string | null; created: boolean }) {
  let m = resolutionCache.get(householdId);
  if (!m) { m = new Map(); resolutionCache.set(householdId, m); }
  m.set(key, val);
}

const DEBT_ACCOUNT_NAME_RE = /^(.+?)的往来款$/;

/**
 * Detects the "XX的往来款" pattern and extracts the counterparty name.
 * Returns null when the account name does not match this pattern.
 */
export function parseDebtAccountName(accountName: string): string | null {
  const match = accountName.trim().match(DEBT_ACCOUNT_NAME_RE);
  return match?.[1]?.trim() ?? null;
}

/**
 * Resolves or creates a loan-type Account for a counterparty whose name
 * appears in a "XX的往来款" style account name during import.
 *
 * 1. Extract the counterparty name from "XX的往来款".
 * 2. Look up a Counterparty by name or shortName within the household.
 * 3. If found, look for an existing loan-type Account linked to that Counterparty.
 * 4. If no account exists, create one (kind=loan, counterpartyId set).
 *
 * Ordinary counterparty settlement accounts are object-owned. Do not split or
 * rewrite them by payable/receivable direction during import.
 *
 * Returns the account ID, or null if the name doesn't match the pattern
 * or no matching Counterparty was found.
 */
export async function resolveDebtAccountByCounterpartyName(
  tx: Db,
  householdId: string,
  accountName: string,
  _direction: "payable" | "receivable" = "receivable",
): Promise<string | null> {
  const cacheKey = accountName;
  const cached = debtResolveCacheGet(householdId, cacheKey);
  if (cached !== undefined) return cached.accountId;
  // Try "XX的往来款" pattern first, then fall back to the raw name.
  const counterpartyName = parseDebtAccountName(accountName) ?? accountName.trim();
  if (!counterpartyName) { debtResolveCacheSet(householdId, cacheKey, { accountId: null, created: false }); return null; }

  let counterparty = await tx.counterparty.findFirst({
    where: {
      householdId,
      OR: [
        { name: counterpartyName },
        { shortName: counterpartyName },
      ],
    },
    select: { id: true, name: true, shortName: true },
  });
  if (!counterparty) { process.stderr.write("[resolveDebt] no counterparty for " + JSON.stringify(counterpartyName) + "\n"); return null; }

  // Look for an existing loan account linked to this counterparty
  const existing = await tx.account.findFirst({
    where: {
      householdId,
      counterpartyId: counterparty.id,
      kind: AccountKind.loan,
      isPlaceholder: { not: true },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
  });
  if (existing) { debtResolveCacheSet(householdId, cacheKey, { accountId: existing.id, created: false });
    if (!existing.isActive) {
      await tx.account.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
    }
    return existing.id;
  }

  // Create a new loan account for this counterparty
  const group =
    (await tx.accountGroup.findFirst({
      where: { householdId, name: { in: ["往来款", "借入/借出", "负债"] } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    })) ??
    (await tx.accountGroup.findFirst({
      where: { householdId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }));
  if (!group) { debtResolveCacheSet(householdId, cacheKey, { accountId: null, created: false }); return null; }
  const created = await tx.account.create({
    data: {
      name: accountName,
      kind: AccountKind.loan,
      debtDirection: "receivable",
      currency: "CNY",
      groupId: group.id,
      counterpartyId: counterparty.id,
      householdId,
      isActive: true,
    },
  });
  debtResolveCacheSet(householdId, cacheKey, { accountId: created.id, created: true });
  return created.id;
}
