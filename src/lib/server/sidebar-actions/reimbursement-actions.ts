"use server";

import { AccountKind, Prisma, ReimbursementExpenseItem, ReimbursementKind, ReimbursementStatus, TransactionType } from "@prisma/client";
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

export type ReimbursementKindValue = "advance" | "travel";

export type ReimbursementExpenseItemValue =
  | "transport"
  | "lodging"
  | "meal"
  | "cityTransport"
  | "subsidy"
  | "conference"
  | "ticketing"
  | "refundFee"
  | "insurance"
  | "parking"
  | "toll"
  | "phone"
  | "other";

export type ReimbursementItemData = {
  id: string;
  txRecordId: string | null;
  amount: number;
  entryDate: string;
  categoryName: string | null;
  expenseItem: ReimbursementExpenseItemValue | null;
  fromPlace: string | null;
  toPlace: string | null;
  vehicle: string | null;
  note: string | null;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  invoiceAmount: number | null;
};

export type ReimbursementData = {
  id: string;
  title: string;
  kind: ReimbursementKindValue;
  status: "pending" | "reimbursed";
  totalAmount: number;
  note: string | null;
  travelStartDate: string | null;
  travelEndDate: string | null;
  travelReason: string | null;
  attachmentCount: number | null;
  createdAt: string;
  reimbursedDate: string | null;
  cashAccountName: string | null;
  items: ReimbursementItemData[];
};

/** One editable row submitted by the reimbursement form. */
export type ReimbursementItemInput = {
  txRecordId?: string | null;
  advanceAccountId?: string | null;
  expenseItem?: string | null;
  fromPlace?: string | null;
  toPlace?: string | null;
  vehicle?: string | null;
  amount: number;
  entryDate: string;
  categoryName?: string | null;
  note?: string | null;
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

function toMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function parseDateValue(value: FormDataEntryValue | string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseReimbursementKind(value: FormDataEntryValue | null): ReimbursementKind {
  return String(value ?? "").trim() === "travel" ? ReimbursementKind.travel : ReimbursementKind.advance;
}

function parseExpenseItem(value: string | null | undefined): ReimbursementExpenseItem | null {
  const raw = String(value ?? "").trim();
  return (Object.values(ReimbursementExpenseItem) as string[]).includes(raw)
    ? (raw as ReimbursementExpenseItem)
    : null;
}

/** Optional free-text cell: the form always sends a string, treat blank as null. */
function parseTextCell(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The form submits its editable item rows as a JSON array. */
function parseItemInputs(value: FormDataEntryValue | null): ReimbursementItemInput[] {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        txRecordId: typeof item.txRecordId === "string" && item.txRecordId ? item.txRecordId : null,
        advanceAccountId: typeof item.advanceAccountId === "string" && item.advanceAccountId ? item.advanceAccountId : null,
        expenseItem: typeof item.expenseItem === "string" ? item.expenseItem : null,
        fromPlace: parseTextCell(item.fromPlace),
        toPlace: parseTextCell(item.toPlace),
        vehicle: parseTextCell(item.vehicle),
        amount: Number(item.amount) || 0,
        entryDate: typeof item.entryDate === "string" ? item.entryDate : "",
        categoryName: typeof item.categoryName === "string" ? item.categoryName : null,
        note: typeof item.note === "string" ? item.note : null,
      }));
  } catch {
    return [];
  }
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
  // Hand-added rows carry no transaction, so only real ids can be claimed.
  return items.map((item) => item.txRecordId).filter((id): id is string => Boolean(id));
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
      kind: reimbursement.kind,
      status: reimbursement.status,
      totalAmount: toMoney(Number(reimbursement.totalAmount)),
      note: reimbursement.note,
      travelStartDate: reimbursement.travelStartDate
        ? reimbursement.travelStartDate.toISOString().slice(0, 10)
        : null,
      travelEndDate: reimbursement.travelEndDate ? reimbursement.travelEndDate.toISOString().slice(0, 10) : null,
      travelReason: reimbursement.travelReason,
      attachmentCount: reimbursement.attachmentCount,
      createdAt: reimbursement.createdAt.toISOString(),
      reimbursedDate: reimbursement.reimbursedDate ? reimbursement.reimbursedDate.toISOString().slice(0, 10) : null,
      cashAccountName: reimbursement.cashAccountName,
      items: reimbursement.items.map((item) => ({
        id: item.id,
        txRecordId: item.txRecordId,
        amount: toMoney(Number(item.amount)),
        entryDate: item.entryDate.toISOString().slice(0, 10),
        categoryName: item.categoryName,
        expenseItem: item.expenseItem,
        fromPlace: item.fromPlace,
        toPlace: item.toPlace,
        vehicle: item.vehicle,
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
  const kind = parseReimbursementKind(formData.get("kind"));
  const travelStartDate = parseDateValue(formData.get("travelStartDate"));
  const travelEndDate = parseDateValue(formData.get("travelEndDate"));
  const travelReason = String(formData.get("travelReason") ?? "").trim();
  const attachmentCountRaw = String(formData.get("attachmentCount") ?? "").trim();
  const attachmentCount = attachmentCountRaw ? Number.parseInt(attachmentCountRaw, 10) : 0;
  const items = parseItemInputs(formData.get("items")).filter((item) => toMoney(Math.abs(item.amount)) > 0);
  if (!title) return { ok: false as const, error: "REIMBURSEMENT_TITLE_REQUIRED" };
  if (!counterpartyId) return { ok: false as const, error: "REIMBURSEMENT_OBJECT_REQUIRED" };
  if (!Number.isFinite(attachmentCount) || attachmentCount < 0) {
    return { ok: false as const, error: "REIMBURSEMENT_ATTACHMENT_COUNT_INVALID" };
  }
  if (items.length === 0) return { ok: false as const, error: "REIMBURSEMENT_ITEMS_REQUIRED" };

  try {
    const scope = await resolveReimbursementObjectScope(prisma, householdId, counterpartyId, objectType);
    const advanceAccountIdSet = new Set(scope.advanceAccountIds);

    // Rows that reference a transaction must point at a live entry of this
    // household that is not already claimed by another reimbursement.
    const linkedIds = Array.from(
      new Set(items.map((item) => item.txRecordId).filter((id): id is string => Boolean(id))),
    );
    const recordById = new Map<
      string,
      {
        id: string;
        date: Date;
        categoryName: string | null;
        note: string | null;
        accountId: string | null;
        toAccountId: string | null;
      }
    >();
    if (linkedIds.length > 0) {
      const usedIds = await collectUsedAdvanceRecordIds(prisma, householdId);
      // `in` and `notIn` must live in the same `id` filter — spreading a second
      // `id` key would overwrite the first one and drop the `in` constraint.
      const records = await prisma.txRecord.findMany({
        where: {
          id: usedIds.length > 0 ? { in: linkedIds, notIn: usedIds } : { in: linkedIds },
          householdId,
          deletedAt: null,
        },
        select: { id: true, date: true, categoryName: true, note: true, accountId: true, toAccountId: true },
      });
      if (records.length !== linkedIds.length) return { ok: false as const, error: "REIMBURSEMENT_ITEM_INVALID" };
      for (const record of records) recordById.set(record.id, record);
    }

    const normalized: {
      txRecordId: string | null;
      advanceAccountId: string | null;
      expenseItem: ReimbursementExpenseItem | null;
      fromPlace: string | null;
      toPlace: string | null;
      vehicle: string | null;
      amount: number;
      entryDate: Date;
      categoryName: string | null;
      note: string | null;
    }[] = [];
    for (const item of items) {
      const record = item.txRecordId ? recordById.get(item.txRecordId) : undefined;
      const entryDate = record?.date ?? parseDateValue(item.entryDate);
      if (!entryDate) return { ok: false as const, error: "REIMBURSEMENT_DATE_INVALID" };
      // Only rows whose money actually moved through this object's advance
      // account settle against the receivable balance; hand-added rows (for
      // example a travel subsidy) carry no advance account and post as income.
      const advanceAccountId =
        item.advanceAccountId && advanceAccountIdSet.has(item.advanceAccountId)
          ? item.advanceAccountId
          : record?.accountId && advanceAccountIdSet.has(record.accountId)
            ? record.accountId
            : record?.toAccountId && advanceAccountIdSet.has(record.toAccountId)
              ? record.toAccountId
              : null;
      normalized.push({
        txRecordId: record?.id ?? null,
        advanceAccountId,
        expenseItem: parseExpenseItem(item.expenseItem),
        fromPlace: item.fromPlace ?? null,
        toPlace: item.toPlace ?? null,
        vehicle: item.vehicle ?? null,
        amount: toMoney(Math.abs(item.amount)),
        entryDate,
        categoryName: item.categoryName ?? record?.categoryName ?? null,
        note: item.note ?? record?.note ?? null,
      });
    }

    const totalAmount = toMoney(normalized.reduce((sum, item) => sum + item.amount, 0));
    await prisma.reimbursement.create({
      data: {
        householdId,
        title,
        kind,
        counterpartyId,
        counterpartyName,
        totalAmount,
        note: note || null,
        travelStartDate,
        travelEndDate,
        travelReason: travelReason || null,
        attachmentCount: attachmentCount > 0 ? attachmentCount : null,
        items: { create: normalized },
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

      // Clear each advance by its original principal, not the amount entered
      // on the reimbursement row. Prefer debtPrincipalAmount from the source
      // transaction and fall back to |amount|; manual rows have no source.
      const linkedRecordIds = Array.from(
        new Set(reimbursement.items.map((item) => item.txRecordId).filter((id): id is string => Boolean(id))),
      );
      const originalAmountByRecordId = new Map<string, number>();
      if (linkedRecordIds.length > 0) {
        const linkedRecords = await tx.txRecord.findMany({
          where: { id: { in: linkedRecordIds }, householdId, deletedAt: null },
          select: { id: true, amount: true, debtPrincipalAmount: true },
        });
        for (const record of linkedRecords) {
          const principal = record.debtPrincipalAmount == null ? Number(record.amount) : Number(record.debtPrincipalAmount);
          originalAmountByRecordId.set(record.id, toMoney(Math.abs(principal)));
        }
      }

      const settlements: { advanceAccountId: string; amount: number }[] = [];
      for (const item of reimbursement.items) {
        if (!item.advanceAccountId) continue;
        const originalAmount = item.txRecordId
          ? originalAmountByRecordId.get(item.txRecordId) ?? 0
          : toMoney(Math.abs(Number(item.amount)));
        if (originalAmount <= 0) continue;
        settlements.push({ advanceAccountId: item.advanceAccountId, amount: originalAmount });
      }
      const advanceTotal = toMoney(settlements.reduce((sum, item) => sum + item.amount, 0));
      // Reimbursement total minus original advance principal: positive is a
      // subsidy recorded as income; negative is the user's share recorded as expense.
      const balanceDiff = toMoney(toMoney(Number(reimbursement.totalAmount)) - advanceTotal);

      const advanceAccountIds = Array.from(new Set(settlements.map((item) => item.advanceAccountId)));
      const advanceAccounts = await tx.account.findMany({
        where: { id: { in: advanceAccountIds }, householdId },
        select: { id: true, name: true, kind: true, investProductType: true, billingDay: true },
      });
      const advanceAccountById = new Map(advanceAccounts.map((account) => [account.id, account]));
      for (const accountId of advanceAccountIds) {
        if (!advanceAccountById.has(accountId)) throw new Error("REIMBURSEMENT_ADVANCE_ACCOUNT_MISSING");
      }

      // The receivable balance on each advance account must cover the principal
      // being cleared, otherwise the return transfer would turn the balance negative.
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
      const clearingByAdvanceAccount = new Map<string, number>();
      for (const item of settlements) {
        clearingByAdvanceAccount.set(
          item.advanceAccountId,
          toMoney((clearingByAdvanceAccount.get(item.advanceAccountId) ?? 0) + item.amount),
        );
      }
      for (const accountId of advanceAccountIds) {
        const clearingTotal = clearingByAdvanceAccount.get(accountId) ?? 0;
        const balance = balances.get(accountId) ?? 0;
        if (balance + 1e-6 < clearingTotal) throw new Error("REIMBURSEMENT_BALANCE_INSUFFICIENT");
      }

      // Clear each advance with its own return entry and store the principal in
      // debtPrincipalAmount, matching the debt view's principal/interest split.
      for (const item of settlements) {
        const advanceAccount = advanceAccountById.get(item.advanceAccountId)!;
        const statementMonth = statementMonthForTransfer(date, advanceAccount, cashAccount);
        await tx.txRecord.create({
          data: {
            accountId: advanceAccount.id,
            accountName: advanceAccount.name,
            toAccountId: cashAccount.id,
            toAccountName: cashAccount.name,
            amount: -item.amount,
            debtPrincipalAmount: item.amount,
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

      // The difference is a subsidy when positive (income) or the user's share
      // when negative (expense).
      if (balanceDiff !== 0) {
        await tx.txRecord.create({
          data: {
            accountId: cashAccount.id,
            accountName: cashAccount.name,
            amount: balanceDiff > 0 ? balanceDiff : -Math.abs(balanceDiff),
            type: balanceDiff > 0 ? TransactionType.income : TransactionType.expense,
            date,
            statementMonth: statementMonthForTransfer(date, cashAccount, cashAccount),
            source: "advance",
            note: reimbursement.title,
            categoryName: reimbursement.title,
            counterpartyInstitutionId: reimbursement.counterpartyId,
            counterpartyInstitutionName: reimbursement.counterpartyName,
            householdId,
          },
        });
      }

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
