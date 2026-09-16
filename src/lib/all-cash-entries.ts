import { isCashLedgerAccount, type AccountKindLike } from "@/lib/account-kind-utils";

export const ALL_CASH_DETAIL_SCOPE_ID = "__all_cash__";

export function isAllCashDetailScope(accountId: string | null | undefined) {
  return accountId === ALL_CASH_DETAIL_SCOPE_ID;
}

export function cashLedgerAccountIdsOf<T extends AccountKindLike & { id: string }>(accounts: T[]) {
  return accounts.filter(isCashLedgerAccount).map((account) => account.id);
}

/** 全部收支记录里，金额/显示日期按资金类账户一侧取。对向才是资金账户时走对向。 */
export function cashLedgerFlowAccountId(
  entry: { accountId?: string | null; toAccountId?: string | null },
  cashLedgerIds: ReadonlySet<string>,
) {
  const fromId = String(entry.accountId ?? "").trim();
  const toId = String(entry.toAccountId ?? "").trim();
  const fromIn = !!fromId && cashLedgerIds.has(fromId);
  const toIn = !!toId && cashLedgerIds.has(toId);
  if (toIn && !fromIn) return toId;
  if (fromIn) return fromId;
  return fromId || toId;
}
