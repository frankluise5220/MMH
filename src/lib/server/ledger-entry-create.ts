/**
 * Shared "create one ordinary ledger row" action.
 *
 * This is the write path behind both the Web UI / MCP (`POST /api/v1/transactions/detail`)
 * and the built-in AI importer (`/api/v1/ai/import`). It deliberately takes a
 * transaction client and plain values instead of a `Request`, so callers can
 * batch, dedupe or resolve accounts without going through HTTP.
 *
 * Investment rows are NOT created here: fund / bond / wealth / stock entries
 * have their own business records and use their dedicated services.
 */
import type { Prisma, TxRecord } from "@prisma/client";
import { toStatementMonth } from "@/lib/date-utils";
import { creditBillEffectiveDate } from "@/lib/credit/billing";
import { normalizeCurrency } from "@/lib/currency";

export type PlainEntryAccount = {
  id: string;
  name: string;
  kind: string;
  billingDay?: number | null;
  billingDayTxPeriod?: string | null;
  currency?: string | null;
};

export type DbWriter = Prisma.TransactionClient | typeof import("@/lib/db/prisma").prisma;

/**
 * One billing-cycle rule for every writer: credit cards and loans file by the
 * effective date (posting date for income/expense), never by a hand-rolled
 * per-caller expression.
 */
export function resolvePlainStatementMonth(
  account: PlainEntryAccount | null | undefined,
  type: string,
  date: Date,
  postedAt: Date | null,
): string | null {
  if (!((account?.kind === "bank_credit" || account?.kind === "loan") && account.billingDay)) return null;
  return toStatementMonth(
    creditBillEffectiveDate({ type, date, postedAt }) ?? date,
    account.billingDay,
    account.billingDayTxPeriod ?? null,
  );
}

export type CreatePlainLedgerEntryInput = {
  householdId: string;
  type: "expense" | "income" | "transfer";
  date: Date;
  /** Signed amount, exactly as the caller wants it stored. */
  amount: number;
  account: PlainEntryAccount | null;
  toAccount?: PlainEntryAccount | null;
  category?: { id: string; name: string } | null;
  counterpartyInstitution?: { id: string; name: string } | null;
  note?: string | null;
  postedAt?: Date | null;
  currency?: string | null;
  source?: string | null;
  entryOrigin?: string | null;
  status?: string | null;
  /** Omit or pass "auto" to use the shared billing-cycle rule. */
  statementMonth?: string | null | "auto";
  /** Caller-specific columns (toNote, depositSourceEntryId, liability amounts…). */
  extra?: Record<string, unknown>;
};

export async function createPlainLedgerEntry(
  tx: DbWriter,
  input: CreatePlainLedgerEntryInput,
): Promise<TxRecord> {
  const statementMonth = input.statementMonth === undefined || input.statementMonth === "auto"
    ? resolvePlainStatementMonth(input.account, input.type, input.date, input.postedAt ?? null)
    : input.statementMonth;
  const institution = input.counterpartyInstitution;
  const data: Record<string, unknown> = {
    householdId: input.householdId,
    type: input.type,
    date: input.date,
    amount: input.amount,
    accountId: input.account?.id ?? undefined,
    accountName: input.account?.name ?? "未知账户",
    categoryId: input.category?.id ?? undefined,
    categoryName: input.category?.name ?? undefined,
    counterpartyInstitutionId: institution?.id ?? null,
    counterpartyInstitutionName: institution?.name ?? null,
    note: input.note ?? undefined,
    statementMonth: statementMonth ?? undefined,
    ...(input.toAccount
      ? { toAccountId: input.toAccount.id, toAccountName: input.toAccount.name }
      : {}),
    ...(input.postedAt !== undefined ? { postedAt: input.postedAt } : {}),
    ...(input.currency != null ? { currency: normalizeCurrency(input.currency) } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.entryOrigin ? { entryOrigin: input.entryOrigin } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.extra ?? {}),
  };
  return tx.txRecord.create({ data: data as Prisma.TxRecordUncheckedCreateInput });
}
