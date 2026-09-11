"use server";

import { AccountKind, Prisma, ReimbursementStatus, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeLoanPrincipalBalancesAsOf, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { statementMonthForTransfer } from "@/lib/transaction-semantics";

// Stored transfer note for reimbursement settlement entries (reimbursement collected).
const REIMBURSEMENT_COLLECT_NOTE = "\u62a5\u9500\u5230\u8d26";

type Db = Prisma.TransactionClient | typeof prisma;

export type ReimbursementActionResult =
  | { ok: true }
  | { ok: false; error: string };

export type ReimbursementItemData = {
  id: string;
  txRecordId: string;
  amount: number;
  entryDate: string;
  categoryName: string | null;
  note: string | null;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  invoiceAmount: number | null;
};

export type ReimbursementData = {
  id: string;
  title: string;
  status: "pending" | "reimbursed";
  totalAmount: number;
  note: string | null;
  createdAt: string;
  reimbursedDate: string | null;
  cashAccountName: string | null;
  items: ReimbursementItemData[];
};

export type ReimbursementCandidateData = {
  id: string;
  date: string;
  amount: number;
  categoryName: string | null;
  note: string | null;
  advanceAccountId: string;
};

export type ReimbursementOverviewData = {
  candidates: ReimbursementCandidateData[];
  reimbursements: ReimbursementData[];
};

function parseMoneyInput(value: FormDataEntryValue | null) {
  const parsed = parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseIdList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toMoney(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Resolve the receivable (advance) accounts and the counterparty/institution
 * ids that belong to one reimbursement object. Advance records store the
 * counterparty's plain id in counterpartyInstitutionId; institution objects
 * also cover counterparties that link back through sourceInstitutionId.
 */
async function resolveReimbursementObjectScope(db: Db, householdId: string, objectId: string, objectType: string) {
  const matchingObjectIds = [objectId];
  if (objectType === "institution") {
    const linked = await db.counterparty.findMany({
      where: { householdId, sourceInstitutionId: objectId },
      select: { id: true },
    });
    for (const item of linked) matchingObjectIds.push(item.id);
  }
  const accounts = await db.account.findMany({
    where: {
      householdId,
      kind: { in: [AccountKind.loan, AccountKind.settlement] },
      debtDirection: "receivable",
      isPlaceholder: { not: true },
      OR: [
        { counterpartyId: { in: matchingObjectIds } },
        { institutionId: { in: matchingObjectIds } },
      ],
    },
    select: { id: true },
  });
  return { advanceAccountIds: accounts.map((account) => account.id), matchingObjectIds };
}

async function collectUsedAdvanceRecordIds(db: Db, householdId: string) {
  const items = await db.reimbursementItem.findMany({
    where: { Reimbursement: { deletedAt: null, householdId } },
    select: { txRecordId: true },
  });
  return items.map((item) => item.txRecordId);
}

export async function getReimbursementOverview(
  objectId: string,
  objectType: "counterparty" | "institution",
): Promise<ReimbursementOverviewData> {
  const { householdId } = await getHouseholdScope();
  const scope = await resolveReimbursementObjectScope(prisma, householdId, objectId, objectType);
  const usedIds = await collectUsedAdvanceRecordIds(prisma, householdId);

  const records = scope.advanceAccountIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          deletedAt: null,
          householdId,
          source: "advance",
          counterpartyInstitutionId: { in: scope.matchingObjectIds },
          toAccountId: { in: scope.advanceAccountIds },
          ...(usedIds.length > 0 ? { id: { notIn: usedIds } } : {}),
        },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        select: { id: true, date: true, amount: true, categoryName: true, note: true, toAccountId: true },
      })
    : [];

  const reimbursements = await prisma.reimbursement.findMany({
    where: { householdId, counterpartyId: objectId, deletedAt: null },
    include: { items: { orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }] } },
    orderBy: [{ createdAt: "desc" }],
  });

  return {
    candidates: records.map((record) => ({
      id: record.id,
      date: record.date.toISOString().slice(0, 10),
      amount: toMoney(Math.abs(Number(record.amount))),
      categoryName: record.categoryName,
      note: record.note,
      advanceAccountId: record.toAccountId ?? "",
    })),
    reimbursements: reimbursements.map((reimbursement) => ({
      id: reimbursement.id,
      title: reimbursement.title,
      status: reimbursement.status,
      totalAmount: toMoney(Number(reimbursement.totalAmount)),
      note: reimbursement.note,
      createdAt: reimbursement.createdAt.toISOString(),
      reimbursedDate: reimbursement.reimbursedDate ? reimbursement.reimbursedDate.toISOString().slice(0, 10) : null,
      cashAccountName: reimbursement.cashAccountName,
      items: reimbursement.items.map((item) => ({
        id: item.id,
        txRecordId: item.txRecordId,
        amount: toMoney(Number(item.amount)),
        entryDate: item.entryDate.toISOString().slice(0, 10),
        categoryName: item.categoryName,
        note: item.note,
        invoiceCode: item.invoiceCode,
        invoiceNumber: item.invoiceNumber,
        invoiceAmount: item.invoiceAmount == null ? null : toMoney(Number(item.invoiceAmount)),
      })),
    })),
  };
}

export async function createReimbursement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const title = String(formData.get("title") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const counterpartyId = String(formData.get("counterpartyId") ?? "").trim();
  const counterpartyName = String(formData.get("counterpartyName") ?? "").trim();
  const objectType = String(formData.get("objectType") ?? "").trim();
  const itemIds = parseIdList(formData.get("itemIds"));
  if (!title) return { ok: false as const, error: "REIMBURSEMENT_TITLE_REQUIRED" };
  if (!counterpartyId) return { ok: false as const, error: "REIMBURSEMENT_OBJECT_REQUIRED" };
  if (itemIds.length === 0) return { ok: false as const, error: "REIMBURSEMENT_ITEMS_REQUIRED" };

  try {
    const scope = await resolveReimbursementObjectScope(prisma, householdId, counterpartyId, objectType);
    const usedIds = await collectUsedAdvanceRecordIds(prisma, householdId);
    const records = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        householdId,
        source: "advance",
        counterpartyInstitutionId: { in: scope.matchingObjectIds },
        toAccountId: { in: scope.advanceAccountIds },
        id: { in: itemIds },
        ...(usedIds.length > 0 ? { id: { notIn: usedIds } } : {}),
      },
      select: { id: true, date: true, amount: true, categoryName: true, note: true, toAccountId: true },
    });
    if (records.length !== itemIds.length) return { ok: false as const, error: "REIMBURSEMENT_ITEM_INVALID" };

    const totalAmount = toMoney(records.reduce((sum, record) => sum + Math.abs(Number(record.amount)), 0));
    await prisma.reimbursement.create({
      data: {
        householdId,
        title,
        counterpartyId,
        counterpartyName,
        totalAmount,
        note: note || null,
        items: {
          create: records.map((record) => ({
            txRecordId: record.id,
            advanceAccountId: record.toAccountId ?? "",
            amount: toMoney(Math.abs(Number(record.amount))),
            entryDate: record.date,
            categoryName: record.categoryName,
            note: record.note,
          })),
        },
      },
    });
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "REIMBURSEMENT_CREATE_FAILED" };
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

export async function reimburseReimbursement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!reimbursementId) return { ok: false as const, error: "REIMBURSEMENT_NOT_FOUND" };
  if (!cashAccountId) return { ok: false as const, error: "REIMBURSEMENT_CASH_ACCOUNT_REQUIRED" };
  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : null;
  if (!date) return { ok: false as const, error: "REIMBURSEMENT_DATE_INVALID" };

  const accountIdsToRefresh: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null },
        include: { items: true },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_NOT_FOUND");
      if (reimbursement.status !== ReimbursementStatus.pending) throw new Error("REIMBURSEMENT_ALREADY_REIMBURSED");

      const cashAccount = await tx.account.findFirst({
        where: { id: cashAccountId, householdId, isActive: true },
      });
      if (!cashAccount) throw new Error("REIMBURSEMENT_CASH_ACCOUNT_INVALID");
      if (isPureInvestmentAccount(cashAccount)) throw new Error("REIMBURSEMENT_CASH_ACCOUNT_INVALID");

      const totalsByAdvanceAccount = new Map<string, number>();
      for (const item of reimbursement.items) {
        totalsByAdvanceAccount.set(
          item.advanceAccountId,
          (totalsByAdvanceAccount.get(item.advanceAccountId) ?? 0) + toMoney(Number(item.amount)),
        );
      }
      const advanceAccountIds = Array.from(totalsByAdvanceAccount.keys());
      const advanceAccounts = await tx.account.findMany({
        where: { id: { in: advanceAccountIds }, householdId },
        select: { id: true, name: true, kind: true, investProductType: true, billingDay: true },
      });
      const advanceAccountById = new Map(advanceAccounts.map((account) => [account.id, account]));
      for (const accountId of advanceAccountIds) {
        if (!advanceAccountById.has(accountId)) throw new Error("REIMBURSEMENT_ADVANCE_ACCOUNT_MISSING");
      }

      // The receivable balance on each advance account must cover the claimed
      // amount, otherwise the return transfer would turn the balance negative.
      const balances = await computeLoanPrincipalBalancesAsOf(
        advanceAccounts.map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
        { householdId },
        new Date(),
        { client: tx },
      );
      for (const accountId of advanceAccountIds) {
        const groupTotal = totalsByAdvanceAccount.get(accountId) ?? 0;
        const balance = balances.get(accountId) ?? 0;
        if (balance + 1e-6 < groupTotal) throw new Error("REIMBURSEMENT_BALANCE_INSUFFICIENT");
      }

      for (const accountId of advanceAccountIds) {
        const advanceAccount = advanceAccountById.get(accountId)!;
        const groupTotal = totalsByAdvanceAccount.get(accountId) ?? 0;
        const statementMonth = statementMonthForTransfer(date, advanceAccount, cashAccount);
        await tx.txRecord.create({
          data: {
            accountId: advanceAccount.id,
            accountName: advanceAccount.name,
            toAccountId: cashAccount.id,
            toAccountName: cashAccount.name,
            amount: -groupTotal,
            type: TransactionType.transfer,
            date,
            statementMonth,
            source: "advance",
            note: REIMBURSEMENT_COLLECT_NOTE,
            counterpartyInstitutionId: reimbursement.counterpartyId,
            counterpartyInstitutionName: reimbursement.counterpartyName,
            householdId,
          },
        });
        accountIdsToRefresh.push(advanceAccount.id);
      }
      accountIdsToRefresh.push(cashAccount.id);

      await tx.reimbursement.update({
        where: { id: reimbursementId },
        data: {
          status: ReimbursementStatus.reimbursed,
          reimbursedDate: date,
          cashAccountId: cashAccount.id,
          cashAccountName: cashAccount.name,
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN";
    return { ok: false as const, error: message };
  }

  for (const accountId of new Set(accountIdsToRefresh)) {
    await recalcAndSaveAccountBalance(accountId).catch(() => {});
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

export async function deleteReimbursement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  if (!reimbursementId) return { ok: false as const, error: "REIMBURSEMENT_NOT_FOUND" };
  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_NOT_FOUND");
      if (reimbursement.status !== ReimbursementStatus.pending) throw new Error("REIMBURSEMENT_NOT_PENDING");
      await tx.reimbursement.delete({ where: { id: reimbursementId } });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN";
    return { ok: false as const, error: message };
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

export async function updateReimbursementItemInvoice(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const itemId = String(formData.get("itemId") ?? "").trim();
  const invoiceCode = String(formData.get("invoiceCode") ?? "").trim();
  const invoiceNumber = String(formData.get("invoiceNumber") ?? "").trim();
  const invoiceAmountRaw = parseMoneyInput(formData.get("invoiceAmount"));
  if (!itemId) return { ok: false as const, error: "REIMBURSEMENT_ITEM_NOT_FOUND" };
  if (invoiceAmountRaw < 0) return { ok: false as const, error: "REIMBURSEMENT_INVOICE_AMOUNT_INVALID" };
  try {
    await prisma.$transaction(async (tx) => {
      const item = await tx.reimbursementItem.findFirst({
        where: { id: itemId, Reimbursement: { householdId, deletedAt: null } },
      });
      if (!item) throw new Error("REIMBURSEMENT_ITEM_NOT_FOUND");
      await tx.reimbursementItem.update({
        where: { id: itemId },
        data: {
          invoiceCode: invoiceCode || null,
          invoiceNumber: invoiceNumber || null,
          invoiceAmount: invoiceAmountRaw > 0 ? invoiceAmountRaw : null,
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN";
    return { ok: false as const, error: message };
  }
  return { ok: true as const };
}
