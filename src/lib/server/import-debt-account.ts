import { AccountKind, type Prisma } from "@prisma/client";
import { parseDebtAccountName, parseImportPersonAttributedCandidate } from "@/lib/account-import-match";
import { assertCounterpartyDisplayNamesUnique } from "@/lib/server/counterparty-name-unique";
import { ensureInstitutionForCounterparty } from "@/lib/server/counterparty-sync";

type Db = Prisma.TransactionClient;
type CreatedImportAccount = { id: string; name: string; kind: string; institutionName?: string | null };

const resolutionCache = new Map<string, Map<string, { accountId: string | null; created: boolean }>>();

function debtResolveCacheGet(householdId: string, key: string): { accountId: string | null; created: boolean } | undefined {
  return resolutionCache.get(householdId)?.get(key);
}
function debtResolveCacheSet(householdId: string, key: string, val: { accountId: string | null; created: boolean }) {
  let m = resolutionCache.get(householdId);
  if (!m) { m = new Map(); resolutionCache.set(householdId, m); }
  m.set(key, val);
}

type DebtResolveOptions = {
  createCounterparty?: boolean;
  createAccount?: boolean;
  createdAccounts?: CreatedImportAccount[];
};

/**
 * Core: find-or-create a person Counterparty, then reuse/create a settlement
 * Account attributed to it. The account keeps the ORIGINAL import name
 * (原来是什么就是什么) — the 往来款 semantics live in kind=settlement +
 * counterpartyId, not in the name.
 *
 * 口径（2026-09-13）：只复用往来款账户。挂在往来对象上的 kind=loan 账户是贷款
 * 窗口建的贷款账户（按入口窗口判定），导入不得复用或改型——名下只有贷款账户时
 * 走下方 createAccount 新建往来款账户（同对象多账户允许）。
 */
async function resolveOrCreateSettlementForCounterparty(
  tx: Db,
  householdId: string,
  cacheKey: string,
  personName: string,
  accountName: string,
  options: DebtResolveOptions,
): Promise<string | null> {
  let counterparty = await tx.counterparty.findFirst({
    where: {
      householdId,
      OR: [
        { name: personName },
        { shortName: personName },
      ],
    },
    select: { id: true, name: true, shortName: true },
  });
  if (!counterparty && options.createCounterparty) {
    await assertCounterpartyDisplayNamesUnique(tx, { householdId, name: personName });
    const createdCounterparty = await tx.counterparty.create({
      data: { householdId, name: personName, shortName: null, type: "person" },
      select: { id: true, name: true, shortName: true, type: true, householdId: true, sourceInstitutionId: true },
    });
    await ensureInstitutionForCounterparty(tx, createdCounterparty);
    counterparty = createdCounterparty;
  }
  if (!counterparty) return null;

  const existing = await tx.account.findFirst({
    where: {
      householdId,
      counterpartyId: counterparty.id,
      kind: AccountKind.settlement,
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

  if (!options.createAccount) return null;

  // Create a new settlement account for this counterparty, keeping the original name.
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
      kind: AccountKind.settlement,
      debtDirection: "receivable",
      currency: "CNY",
      groupId: group.id,
      counterpartyId: counterparty.id,
      householdId,
      isActive: true,
    },
  });
  debtResolveCacheSet(householdId, cacheKey, { accountId: created.id, created: true });
  options.createdAccounts?.push({ id: created.id, name: created.name, kind: created.kind });
  return created.id;
}

/**
 * Resolves or creates a settlement Account for a counterparty whose name
 * appears in a "XX的往来款" style account name during import.
 *
 * 1. Extract the counterparty name from the "XX的往来款" style account name.
 * 2. Look up a Counterparty by name or shortName within the household.
 * 3. If found, look for an existing settlement Account linked to that Counterparty.
 * 4. If no account exists, create one (kind=settlement, counterpartyId set, 原名保留).
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
  options: DebtResolveOptions = {},
): Promise<string | null> {
  const cacheKey = accountName;
  const cached = options.createCounterparty || options.createAccount
    ? undefined
    : debtResolveCacheGet(householdId, cacheKey);
  if (cached !== undefined) return cached.accountId;
  // Try "XX的往来款" pattern first, then fall back to the raw name.
  const parsedCounterpartyName = parseDebtAccountName(accountName);
  if (!parsedCounterpartyName && (options.createCounterparty || options.createAccount)) return null;
  const counterpartyName = parsedCounterpartyName ?? accountName.trim();
  if (!counterpartyName) { debtResolveCacheSet(householdId, cacheKey, { accountId: null, created: false }); return null; }

  const resolved = await resolveOrCreateSettlementForCounterparty(tx, householdId, cacheKey, counterpartyName, accountName.trim(), options);
  return resolved;
}

/**
 * Loose fallback for non-owner person-prefixed names like「付斌的招行3833」:
 * 付斌 is not a ledger owner (not in AccountGroup names), so the name can only
 * be attributed to a settlement account under counterparty 付斌 (原名保留).
 *
 * Called LATE in the account-resolution chain (after every existing-account
 * match has failed) and only when the "创建往来款账户" option is enabled —
 * never during resolve-only lookups, and never for owner names (those go
 * through the owned-money-account path) or bank-like prefixes.
 */
export async function resolveDebtAccountByLoosePersonName(
  tx: Db,
  householdId: string,
  accountName: string,
  options: DebtResolveOptions = {},
): Promise<string | null> {
  const cacheKey = accountName;
  const cached = debtResolveCacheGet(householdId, cacheKey);
  if (cached !== undefined) return cached.accountId;
  const candidate = parseImportPersonAttributedCandidate(accountName, await loadHouseholdOwnerNames(tx, householdId));
  if (!candidate) return null;
  const resolved = await resolveOrCreateSettlementForCounterparty(tx, householdId, cacheKey, candidate.personName, accountName.trim(), options);
  if (resolved) return resolved;
  return null;
}

async function loadHouseholdOwnerNames(tx: Db, householdId: string): Promise<string[]> {
  const groups = await tx.accountGroup.findMany({
    where: { householdId },
    select: { name: true },
  });
  return groups.map((group) => group.name).filter(Boolean);
}
