"use server";

import { AccountKind, Prisma, ReimbursementExpenseItem, ReimbursementKind, ReimbursementStatus, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeLoanPrincipalBalancesAsOf, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { statementMonthForTransfer } from "@/lib/transaction-semantics";
import { evaluateArithmeticExpression } from "@/lib/arithmetic-expression";
import {
  SYSTEM_REIMBURSEMENT_ALLOWANCE_CATEGORY,
  SYSTEM_REIMBURSEMENT_GENERAL_SHORTFALL_CATEGORY,
  SYSTEM_REIMBURSEMENT_TRAVEL_SHORTFALL_CATEGORY,
} from "@/lib/default-categories";

// Stored transfer note for reimbursement settlement entries (reimbursement collected).
const REIMBURSEMENT_COLLECT_NOTE = "\u62a5\u9500\u5230\u8d26";

type Db = Prisma.TransactionClient | typeof prisma;

export type ReimbursementActionResult =
  | { ok: true }
  | { ok: false; error: string };

export type ReimbursementKindValue = "advance" | "travel" | "general";

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
  outsideTransportAmount: number | null;
  cityTransportAmount: number | null;
  subsidyAmount: number | null;
  lodgingAmount: number | null;
  days: number | null;
  entryDate: string;
  categoryName: string | null;
  expenseItem: ReimbursementExpenseItemValue | null;
  fromPlace: string | null;
  toPlace: string | null;
  note: string | null;
  invoiceCode: string | null;
  invoiceNumber: string | null;
  invoiceAmount: number | null;
};

export type ReimbursementLinkedTransactionData = {
  txRecordId: string;
  date: string;
  amount: number;
  categoryName: string | null;
  note: string | null;
};

export type ReimbursementData = {
  id: string;
  batchId: string | null;
  advanceAccountId: string | null;
  documentNumber: string | null;
  title: string;
  kind: ReimbursementKindValue;
  status: "pending" | "reimbursed";
  approvalStatus: "pending_approval" | "pending" | "reimbursed";
  totalAmount: number;
  approvedAmount: number | null;
  approvalDate: string | null;
  approvalNote: string | null;
  actualAmount: number | null;
  linkedTransactionTotal: number;
  note: string | null;
  advanceAccountName: string | null;
  travelStartDate: string | null;
  travelEndDate: string | null;
  travelReason: string | null;
  attachmentCount: number | null;
  createdAt: string;
  reimbursedDate: string | null;
  cashAccountName: string | null;
  paymentTxRecordId: string | null;
  settlements: ReimbursementSettlementData[];
  items: ReimbursementItemData[];
  linkedTransactions: ReimbursementLinkedTransactionData[];
};

export type ReimbursementSettlementData = {
  id: string;
  amount: number;
  feeAmount: number;
  writeOffAmount: number;
  balanceDiffMode: "loss" | "remain";
  date: string;
  cashAccountId: string;
  cashAccountName: string;
  note: string | null;
};

export type ReimbursementBatchData = {
  id: string;
  title: string;
  note: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  documentCount: number;
  totalAmount: number;
  advanceAccountId: string;
  advanceAccountName: string | null;
  approvedAmount: number;
  actualAmount: number;
  linkedTransactionTotal: number;
  pendingApprovalCount: number;
  status: "pending_approval" | "pending" | "reimbursed" | "mixed";
};

/** One editable row submitted by the reimbursement form. */
export type ReimbursementItemInput = {
  txRecordId?: string | null;
  advanceAccountId?: string | null;
  expenseItem?: string | null;
  fromPlace?: string | null;
  toPlace?: string | null;
  amount: number;
  outsideTransportAmount?: number | null;
  cityTransportAmount?: number | null;
  subsidyAmount?: number | null;
  lodgingAmount?: number | null;
  days?: number | null;
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
  batches: ReimbursementBatchData[];
  reimbursements: ReimbursementData[];
};

function parseMoneyInput(value: FormDataEntryValue | null) {
  const parsed = evaluateArithmeticExpression(String(value ?? "").replace(/,/g, "").trim());
  return parsed != null && Number.isFinite(parsed) ? parsed : 0;
}

function parseDaysInput(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  const parsed = evaluateArithmeticExpression(raw);
  return parsed == null ? Number.NaN : parsed;
}

function toMoney(value: number) {
  return Math.round(value * 100) / 100;
}

type ReimbursementSettlementCalculation = {
  incomeAmount: number;
  balanceDiff: number;
  clearingAmount: number;
  writeOffAmount: number;
  differenceAmount: number;
};

function calculateReimbursementSettlement(
  linkedTransactionTotal: number,
  actualAmount: number,
  balanceDiffMode: "loss" | "remain",
): ReimbursementSettlementCalculation {
  const linkedTotal = toMoney(Math.max(0, linkedTransactionTotal));
  const received = toMoney(Math.max(0, actualAmount));
  const balanceDiff = toMoney(Math.max(0, linkedTotal - received));
  const clearingAmount = toMoney(
    balanceDiffMode === "loss" ? linkedTotal : Math.min(received, linkedTotal),
  );

  return {
    incomeAmount: toMoney(Math.max(0, received - linkedTotal)),
    balanceDiff,
    clearingAmount,
    writeOffAmount: balanceDiffMode === "loss" ? balanceDiff : 0,
    differenceAmount: toMoney(received - linkedTotal),
  };
}

function reimbursementLinkedTransactionAmount(
  amount: unknown,
  principalAmount: unknown,
) {
  const principal = principalAmount == null ? Number(amount) : Number(principalAmount);
  return toMoney(Math.abs(Number.isFinite(principal) ? principal : 0));
}

function parseDateValue(value: FormDataEntryValue | string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const parsed = dateOnly
    ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseReimbursementKind(value: FormDataEntryValue | null): ReimbursementKind {
  const raw = String(value ?? "").trim();
  if (raw === "travel") return ReimbursementKind.travel;
  if (raw === "general") return ReimbursementKind.general;
  return ReimbursementKind.advance;
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
        amount: Number(item.amount) || 0,
        outsideTransportAmount: item.outsideTransportAmount == null ? null : (Number(item.outsideTransportAmount) || 0),
        cityTransportAmount: item.cityTransportAmount == null ? null : (Number(item.cityTransportAmount) || 0),
        subsidyAmount: item.subsidyAmount == null ? null : (Number(item.subsidyAmount) || 0),
        lodgingAmount: item.lodgingAmount == null ? null : (Number(item.lodgingAmount) || 0),
        days: item.days == null ? null : (Number(item.days) || 0),
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
      liabilityDirection: "receivable",
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
  const links = await db.reimbursementTransaction.findMany({
    where: { Reimbursement: { deletedAt: null, householdId } },
    select: { txRecordId: true },
  });
  return links.map((link) => link.txRecordId);
}

function inferTravelExpenseItem(categoryName: string | null | undefined, note: string | null | undefined) {
  const text = `${categoryName ?? ""} ${note ?? ""}`.toLowerCase();
  if (/高铁|火车|铁路|飞机|航班|长途|客运|动车|\b(rail|train|flight|airfare|long.distance|coach)\b/.test(text)) return ReimbursementExpenseItem.transport;
  if (/地铁|公交|打的|打车|出租|网约车|\b(subway|metro|bus|taxi|cab|ride.?hail)\b/.test(text)) return ReimbursementExpenseItem.cityTransport;
  return null;
}

function resolveTravelAmounts(item: {
  amount: Prisma.Decimal;
  outsideTransportAmount: Prisma.Decimal | null;
  cityTransportAmount: Prisma.Decimal | null;
  subsidyAmount: Prisma.Decimal | null;
  lodgingAmount: Prisma.Decimal | null;
  expenseItem: ReimbursementExpenseItem | null;
  categoryName: string | null;
  note: string | null;
}) {
  const stored = [
    item.outsideTransportAmount,
    item.cityTransportAmount,
    item.subsidyAmount,
    item.lodgingAmount,
  ];
  if (stored.some((value) => value != null)) {
    return {
      outsideTransportAmount: item.outsideTransportAmount == null ? 0 : toMoney(Number(item.outsideTransportAmount)),
      cityTransportAmount: item.cityTransportAmount == null ? 0 : toMoney(Number(item.cityTransportAmount)),
      subsidyAmount: item.subsidyAmount == null ? 0 : toMoney(Number(item.subsidyAmount)),
      lodgingAmount: item.lodgingAmount == null ? 0 : toMoney(Number(item.lodgingAmount)),
    };
  }
  const fallbackAmount = toMoney(Number(item.amount));
  const expenseItem = item.expenseItem ?? inferTravelExpenseItem(item.categoryName, item.note);
  return {
    outsideTransportAmount: expenseItem === ReimbursementExpenseItem.transport ? fallbackAmount : 0,
    cityTransportAmount: expenseItem === ReimbursementExpenseItem.cityTransport ? fallbackAmount : 0,
    subsidyAmount: expenseItem === ReimbursementExpenseItem.subsidy || expenseItem === ReimbursementExpenseItem.meal ? fallbackAmount : 0,
    lodgingAmount: expenseItem === ReimbursementExpenseItem.lodging ? fallbackAmount : 0,
  };
}

export async function getReimbursementOverview(
  objectId: string,
  objectType: "counterparty" | "institution",
  advanceAccountId: string,
): Promise<ReimbursementOverviewData> {
  try {
    const { householdId } = await getHouseholdScope();
    // Global mode: an empty advanceAccountId aggregates every reimbursable
    // counterparty's advance (receivable) accounts in the household.
    const globalMode = !advanceAccountId.trim();
    let advanceAccountIds: string[] = [];
    const advanceAccountNames = new Map<string, string>();
    const accountDisplayName = (account: { name: string; Counterparty: { name: string; shortName: string | null } | null }) =>
      account.Counterparty?.shortName?.trim() || account.Counterparty?.name || account.name;
    if (globalMode) {
      const accounts = await prisma.account.findMany({
        where: {
          householdId,
          kind: { in: [AccountKind.loan, AccountKind.settlement] },
          liabilityDirection: "receivable",
          isPlaceholder: { not: true },
          Counterparty: { isReimbursable: true },
        },
        select: { id: true, name: true, Counterparty: { select: { name: true, shortName: true } } },
      });
      advanceAccountIds = accounts.map((account) => account.id);
      for (const account of accounts) advanceAccountNames.set(account.id, accountDisplayName(account));
    } else {
      const scope = await resolveReimbursementObjectScope(prisma, householdId, objectId, objectType);
      if (!scope.advanceAccountIds.includes(advanceAccountId)) return { candidates: [], batches: [], reimbursements: [] };
      advanceAccountIds = [advanceAccountId];
      const account = await prisma.account.findFirst({
        where: { id: advanceAccountId, householdId },
        select: { id: true, name: true, Counterparty: { select: { name: true, shortName: true } } },
      });
      if (account) advanceAccountNames.set(account.id, accountDisplayName(account));
    }
    const usedIds = await collectUsedAdvanceRecordIds(prisma, householdId);

    const records = advanceAccountIds.length > 0
      ? await prisma.txRecord.findMany({
        where: {
          deletedAt: null,
          householdId,
          source: "advance",
          toAccountId: { in: advanceAccountIds },
          ...(usedIds.length > 0 ? { id: { notIn: usedIds } } : {}),
        },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
        select: { id: true, date: true, amount: true, categoryName: true, note: true, toAccountId: true },
        })
      : [];

    const reimbursements = await prisma.reimbursement.findMany({
    where: { householdId, advanceAccountId: { in: advanceAccountIds }, deletedAt: null },
    include: {
      items: { orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }] },
      linkedTransactions: { select: { txRecordId: true } },
      settlements: { select: { id: true, amount: true, feeAmount: true, writeOffAmount: true, balanceDiffMode: true, date: true, cashAccountId: true, cashAccountName: true, note: true } },
    },
    orderBy: [{ createdAt: "desc" }],
  });
    const paymentTxRecordIds = reimbursements
      .map((reimbursement) => reimbursement.paymentTxRecordId)
      .filter((id): id is string => Boolean(id));
    const validPaymentTxRecordIds = new Set(
      paymentTxRecordIds.length > 0
        ? (await prisma.txRecord.findMany({
          where: { householdId, id: { in: paymentTxRecordIds }, deletedAt: null },
          select: { id: true },
        })).map((record) => record.id)
        : [],
    );
    const isReimbursed = (paymentTxRecordId: string | null) =>
      Boolean(paymentTxRecordId && validPaymentTxRecordIds.has(paymentTxRecordId));
    const staleReimbursementIds = reimbursements
      .filter((reimbursement) => reimbursement.status === ReimbursementStatus.reimbursed && !isReimbursed(reimbursement.paymentTxRecordId))
      .map((reimbursement) => reimbursement.id);
    const newlyReimbursedIds = reimbursements
      .filter((reimbursement) => reimbursement.status !== ReimbursementStatus.reimbursed && isReimbursed(reimbursement.paymentTxRecordId))
      .map((reimbursement) => reimbursement.id);
    if (staleReimbursementIds.length > 0) {
      await prisma.reimbursement.updateMany({
        where: { householdId, id: { in: staleReimbursementIds }, deletedAt: null },
        data: {
          status: ReimbursementStatus.pending,
          reimbursedDate: null,
          cashAccountId: null,
          cashAccountName: null,
          paymentTxRecordId: null,
        },
      });
    }
    if (newlyReimbursedIds.length > 0) {
      await prisma.reimbursement.updateMany({
        where: { householdId, id: { in: newlyReimbursedIds }, deletedAt: null },
        data: { status: ReimbursementStatus.reimbursed },
      });
    }
    const linkedTransactionIds = Array.from(new Set(reimbursements.flatMap((reimbursement) => reimbursement.linkedTransactions.map((link) => link.txRecordId))));
    const linkedRecords = linkedTransactionIds.length > 0
      ? await prisma.txRecord.findMany({
        where: { id: { in: linkedTransactionIds }, householdId },
        select: { id: true, date: true, amount: true, principalAmount: true, categoryName: true, note: true },
      })
      : [];
    const linkedRecordById = new Map(linkedRecords.map((record) => [record.id, record]));
    const batches = await prisma.reimbursementBatch.findMany({
    where: { householdId, advanceAccountId: { in: advanceAccountIds } },
    include: {
      reimbursements: {
        where: { deletedAt: null },
        select: {
          totalAmount: true,
          approvedAmount: true,
          approvalDate: true,
          approvalNote: true,
          status: true,
          paymentTxRecordId: true,
          note: true,
          travelReason: true,
          travelStartDate: true,
          travelEndDate: true,
          items: { select: { entryDate: true } },
          linkedTransactions: { select: { txRecordId: true } },
          settlements: { select: { amount: true } },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }],
  });

    return {
    batches: batches.map((batch) => ({
      id: batch.id,
      title: batch.title,
      note: batch.note,
      startDate: batch.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: batch.endDate?.toISOString().slice(0, 10) ?? null,
      createdAt: batch.createdAt.toISOString(),
      documentCount: batch.reimbursements.length,
      totalAmount: toMoney(batch.reimbursements.reduce((sum, reimbursement) => sum + Number(reimbursement.totalAmount), 0)),
      advanceAccountId: batch.advanceAccountId,
      advanceAccountName: advanceAccountNames.get(batch.advanceAccountId) ?? null,
      approvedAmount: toMoney(batch.reimbursements.reduce((sum, reimbursement) => sum + Number(reimbursement.approvedAmount ?? 0), 0)),
      linkedTransactionTotal: toMoney(batch.reimbursements.reduce(
        (sum, reimbursement) => sum + reimbursement.linkedTransactions.reduce(
          (linkedSum, link) => linkedSum + reimbursementLinkedTransactionAmount(
            linkedRecordById.get(link.txRecordId)?.amount,
            linkedRecordById.get(link.txRecordId)?.principalAmount,
          ),
          0,
        ),
        0,
      )),
      actualAmount: toMoney(batch.reimbursements.reduce(
        (sum, reimbursement) => sum + (isReimbursed(reimbursement.paymentTxRecordId) && reimbursement.settlements.length > 0
          ? reimbursement.settlements.reduce((settled, settlement) => settled + Number(settlement.amount), 0)
          : isReimbursed(reimbursement.paymentTxRecordId) ? Number(reimbursement.totalAmount) : 0),
        0,
      )),
      status: (() => {
        const paidCount = batch.reimbursements.filter((item) => isReimbursed(item.paymentTxRecordId)).length;
        const unpaidItems = batch.reimbursements.filter((item) => !isReimbursed(item.paymentTxRecordId));
        if (batch.reimbursements.length > 0 && paidCount === batch.reimbursements.length) return "reimbursed" as const;
        if (paidCount > 0) return "mixed" as const;
        if (unpaidItems.some((item) => item.approvedAmount == null)) return "pending_approval" as const;
        return "pending" as const;
      })(),
      pendingApprovalCount: batch.reimbursements.filter((item) => item.approvedAmount == null && !isReimbursed(item.paymentTxRecordId)).length,
    })),
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
      batchId: reimbursement.batchId,
      advanceAccountId: reimbursement.advanceAccountId,
      documentNumber: reimbursement.documentNumber,
      title: reimbursement.title,
      kind: reimbursement.kind,
      status: isReimbursed(reimbursement.paymentTxRecordId) ? ReimbursementStatus.reimbursed : ReimbursementStatus.pending,
      approvalStatus: isReimbursed(reimbursement.paymentTxRecordId)
        ? "reimbursed"
        : reimbursement.approvedAmount == null ? "pending_approval" : "pending",
      totalAmount: toMoney(Number(reimbursement.totalAmount)),
      approvedAmount: reimbursement.approvedAmount == null ? null : toMoney(Number(reimbursement.approvedAmount)),
      approvalDate: reimbursement.approvalDate?.toISOString().slice(0, 10) ?? null,
      approvalNote: reimbursement.approvalNote,
      linkedTransactionTotal: toMoney(reimbursement.linkedTransactions.reduce(
        (sum, link) => sum + reimbursementLinkedTransactionAmount(
          linkedRecordById.get(link.txRecordId)?.amount,
          linkedRecordById.get(link.txRecordId)?.principalAmount,
        ),
        0,
      )),
      actualAmount: reimbursement.settlements.length > 0
        && isReimbursed(reimbursement.paymentTxRecordId)
        ? toMoney(reimbursement.settlements.reduce((sum, settlement) => sum + Number(settlement.amount), 0))
        : isReimbursed(reimbursement.paymentTxRecordId) ? toMoney(Number(reimbursement.totalAmount)) : null,
      note: reimbursement.note,
      advanceAccountName: reimbursement.advanceAccountId ? advanceAccountNames.get(reimbursement.advanceAccountId) ?? null : null,
      travelStartDate: reimbursement.travelStartDate
        ? reimbursement.travelStartDate.toISOString().slice(0, 10)
        : null,
      travelEndDate: reimbursement.travelEndDate ? reimbursement.travelEndDate.toISOString().slice(0, 10) : null,
      travelReason: reimbursement.travelReason,
      attachmentCount: reimbursement.attachmentCount,
      createdAt: reimbursement.createdAt.toISOString(),
      reimbursedDate: isReimbursed(reimbursement.paymentTxRecordId) && reimbursement.reimbursedDate
        ? reimbursement.reimbursedDate.toISOString().slice(0, 10)
        : null,
      cashAccountName: isReimbursed(reimbursement.paymentTxRecordId) ? reimbursement.cashAccountName : null,
      paymentTxRecordId: isReimbursed(reimbursement.paymentTxRecordId) ? reimbursement.paymentTxRecordId : null,
      settlements: isReimbursed(reimbursement.paymentTxRecordId) ? reimbursement.settlements.map((settlement) => ({
        id: settlement.id,
        amount: toMoney(Number(settlement.amount)),
        feeAmount: toMoney(Number(settlement.feeAmount)),
        writeOffAmount: toMoney(Number(settlement.writeOffAmount)),
        balanceDiffMode: settlement.balanceDiffMode === "remain" ? "remain" : "loss",
        date: settlement.date.toISOString().slice(0, 10),
        cashAccountId: settlement.cashAccountId,
        cashAccountName: settlement.cashAccountName,
        note: settlement.note,
      })) : [],
      items: reimbursement.items.map((item) => {
        const travelAmounts = resolveTravelAmounts(item);
        return {
        id: item.id,
        txRecordId: item.txRecordId,
        amount: toMoney(Number(item.amount)),
        outsideTransportAmount: travelAmounts.outsideTransportAmount,
        cityTransportAmount: travelAmounts.cityTransportAmount,
        subsidyAmount: travelAmounts.subsidyAmount,
        lodgingAmount: travelAmounts.lodgingAmount,
        days: item.days ?? null,
        entryDate: item.entryDate.toISOString().slice(0, 10),
        categoryName: item.categoryName,
        expenseItem: item.expenseItem,
        fromPlace: item.fromPlace,
        toPlace: item.toPlace,
        note: item.note,
        invoiceCode: item.invoiceCode,
        invoiceNumber: item.invoiceNumber,
        invoiceAmount: item.invoiceAmount == null ? null : toMoney(Number(item.invoiceAmount)),
        };
      }),
      linkedTransactions: reimbursement.linkedTransactions.flatMap((link) => {
        const record = linkedRecordById.get(link.txRecordId);
        return record ? [{
          txRecordId: record.id,
          date: record.date.toISOString().slice(0, 10),
          amount: toMoney(Math.abs(Number(record.amount))),
          categoryName: record.categoryName,
          note: record.note,
        }] : [];
      }),
    })),
    };
  } catch (error) {
    console.error("Failed to load reimbursement overview", {
      objectId,
      objectType,
      advanceAccountId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

export async function createReimbursementBatch(formData: FormData): Promise<ReimbursementActionResult & { batchId?: string }> {
  const { householdId } = await getHouseholdScope();
  const advanceAccountId = String(formData.get("advanceAccountId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const startDateValue = String(formData.get("startDate") ?? "").trim();
  const endDateValue = String(formData.get("endDate") ?? "").trim();
  const startDate = startDateValue ? parseDateValue(startDateValue) : null;
  const endDate = endDateValue ? parseDateValue(endDateValue) : null;
  if (!advanceAccountId) return { ok: false, error: "REIMBURSEMENT_ADVANCE_ACCOUNT_REQUIRED" };
  if (!title) return { ok: false, error: "REIMBURSEMENT_BATCH_TITLE_REQUIRED" };
  if ((startDateValue && !startDate) || (endDateValue && !endDate) || (startDate && endDate && startDate > endDate)) {
    return { ok: false, error: "REIMBURSEMENT_BATCH_DATE_RANGE_INVALID" };
  }
  const account = await prisma.account.findFirst({
    where: { id: advanceAccountId, householdId, kind: { in: [AccountKind.loan, AccountKind.settlement] }, liabilityDirection: "receivable" },
    select: { id: true },
  });
  if (!account) return { ok: false, error: "REIMBURSEMENT_ADVANCE_ACCOUNT_INVALID" };
  const batch = await prisma.reimbursementBatch.create({
    data: { householdId, advanceAccountId, title, note: note || null, startDate, endDate },
  });
  revalidateAfterTxChange();
  return { ok: true, batchId: batch.id };
}

export async function updateReimbursementBatch(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const batchId = String(formData.get("batchId") ?? "").trim();
  const advanceAccountId = String(formData.get("advanceAccountId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const startDateValue = String(formData.get("startDate") ?? "").trim();
  const endDateValue = String(formData.get("endDate") ?? "").trim();
  const startDate = startDateValue ? parseDateValue(startDateValue) : null;
  const endDate = endDateValue ? parseDateValue(endDateValue) : null;
  if (!batchId) return { ok: false, error: "REIMBURSEMENT_BATCH_NOT_FOUND" };
  if (!title) return { ok: false, error: "REIMBURSEMENT_BATCH_TITLE_REQUIRED" };
  if ((startDateValue && !startDate) || (endDateValue && !endDate) || (startDate && endDate && startDate > endDate)) {
    return { ok: false, error: "REIMBURSEMENT_BATCH_DATE_RANGE_INVALID" };
  }
  const result = await prisma.reimbursementBatch.updateMany({
    where: { id: batchId, householdId, advanceAccountId },
    data: { title, note: note || null, startDate, endDate },
  });
  if (result.count === 0) return { ok: false, error: "REIMBURSEMENT_BATCH_NOT_FOUND" };
  revalidateAfterTxChange();
  return { ok: true };
}

export async function deleteReimbursementBatch(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const batchId = String(formData.get("batchId") ?? "").trim();
  const advanceAccountId = String(formData.get("advanceAccountId") ?? "").trim();
  if (!batchId) return { ok: false, error: "REIMBURSEMENT_BATCH_NOT_FOUND" };
  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.reimbursementBatch.findFirst({
      where: { id: batchId, householdId, advanceAccountId },
      select: { id: true },
    });
    if (!batch) return { ok: false as const, error: "REIMBURSEMENT_BATCH_NOT_FOUND" };
    const documentCount = await tx.reimbursement.count({ where: { batchId: batch.id } });
    if (documentCount > 0) {
      return { ok: false as const, error: `REIMBURSEMENT_BATCH_HAS_DOCUMENTS:${documentCount}` };
    }
    await tx.reimbursementBatch.delete({ where: { id: batch.id } });
    return { ok: true as const };
  });
  if (!result.ok) return result;
  revalidateAfterTxChange();
  return { ok: true };
}

export async function createReimbursement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const documentNumber = String(formData.get("documentNumber") ?? "").trim();
  const submittedTitle = String(formData.get("title") ?? "").trim();
  const title = documentNumber || submittedTitle;
  const note = String(formData.get("note") ?? "").trim();
  const counterpartyId = String(formData.get("counterpartyId") ?? "").trim();
  const counterpartyName = String(formData.get("counterpartyName") ?? "").trim();
  let requestedAdvanceAccountId = String(formData.get("advanceAccountId") ?? "").trim();
  let requestedBatchId = String(formData.get("batchId") ?? "").trim();
  const objectType = String(formData.get("objectType") ?? "").trim();
  const kind = parseReimbursementKind(formData.get("kind"));
  const travelStartDate = parseDateValue(formData.get("travelStartDate"));
  const travelEndDate = parseDateValue(formData.get("travelEndDate"));
  const travelReason = String(formData.get("travelReason") ?? "").trim();
  const attachmentCountRaw = String(formData.get("attachmentCount") ?? "").trim();
  const attachmentCountValue = attachmentCountRaw ? evaluateArithmeticExpression(attachmentCountRaw) : 0;
  const attachmentCount = attachmentCountValue == null ? Number.NaN : Math.round(attachmentCountValue);
  const items = parseItemInputs(formData.get("items")).filter((item) => toMoney(Math.abs(item.amount)) > 0);
  const requestedTransactionIds = Array.from(new Set(
    String(formData.get("transactionIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  ));
  if (!title) return { ok: false as const, error: "REIMBURSEMENT_TITLE_REQUIRED" };
  if (!counterpartyId) return { ok: false as const, error: "REIMBURSEMENT_OBJECT_REQUIRED" };
  if (!requestedAdvanceAccountId) return { ok: false as const, error: "REIMBURSEMENT_ADVANCE_ACCOUNT_REQUIRED" };
  if (!Number.isFinite(attachmentCount) || attachmentCount < 0) {
    return { ok: false as const, error: "REIMBURSEMENT_ATTACHMENT_COUNT_INVALID" };
  }
  if (items.length === 0) return { ok: false as const, error: "REIMBURSEMENT_ITEMS_REQUIRED" };

  try {
    const scope = await resolveReimbursementObjectScope(prisma, householdId, counterpartyId, objectType);
    const advanceAccountIdSet = new Set(scope.advanceAccountIds);
    if (!advanceAccountIdSet.has(requestedAdvanceAccountId)) {
      return { ok: false as const, error: "REIMBURSEMENT_ADVANCE_ACCOUNT_INVALID" };
    }
    if (requestedBatchId) {
      const batch = await prisma.reimbursementBatch.findFirst({
        where: { id: requestedBatchId, householdId, advanceAccountId: requestedAdvanceAccountId },
        select: { id: true, advanceAccountId: true },
      });
      if (!batch || !advanceAccountIdSet.has(batch.advanceAccountId)) {
        return { ok: false as const, error: "REIMBURSEMENT_BATCH_INVALID" };
      }
    }

    // Reimbursement transactions belong to the document, independently of its expense rows.
    const linkedIds = requestedTransactionIds;
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
          source: "advance",
          toAccountId: requestedAdvanceAccountId,
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
      amount: number;
      outsideTransportAmount: number | null;
      cityTransportAmount: number | null;
      subsidyAmount: number | null;
      lodgingAmount: number | null;
      days: number | null;
      entryDate: Date;
      categoryName: string | null;
      note: string | null;
    }[] = [];
    for (const item of items) {
      const entryDate = parseDateValue(item.entryDate);
      if (!entryDate) return { ok: false as const, error: "REIMBURSEMENT_DATE_INVALID" };
      // Only rows whose money actually moved through this object's advance
      // account settle against the receivable balance; hand-added rows (for
      // example a travel subsidy) carry no advance account and post as income.
      normalized.push({
        txRecordId: null,
        advanceAccountId: item.advanceAccountId === requestedAdvanceAccountId ? item.advanceAccountId : null,
        expenseItem: parseExpenseItem(item.expenseItem) ?? (kind === ReimbursementKind.travel
          ? inferTravelExpenseItem(item.categoryName, item.note)
          : null),
        fromPlace: item.fromPlace ?? null,
        toPlace: item.toPlace ?? null,
        amount: toMoney(Math.abs(item.amount)),
        outsideTransportAmount: kind === ReimbursementKind.travel
          ? toMoney(Math.abs(item.outsideTransportAmount ?? (["transport", "ticketing", "toll", "refundFee", "insurance"].includes(item.expenseItem ?? "") ? item.amount : 0)))
          : null,
        cityTransportAmount: kind === ReimbursementKind.travel
          ? toMoney(Math.abs(item.cityTransportAmount ?? (["cityTransport", "parking"].includes(item.expenseItem ?? "") ? item.amount : 0)))
          : null,
        subsidyAmount: kind === ReimbursementKind.travel
          ? toMoney(Math.abs(item.subsidyAmount ?? (["subsidy", "meal"].includes(item.expenseItem ?? "") ? item.amount : 0)))
          : null,
        lodgingAmount: kind === ReimbursementKind.travel
          ? toMoney(Math.abs(item.lodgingAmount ?? (item.expenseItem === "lodging" ? item.amount : 0)))
          : null,
        days: kind === ReimbursementKind.travel && item.days != null ? Math.max(0, Math.floor(item.days)) : null,
        entryDate,
        categoryName: item.categoryName ?? null,
        note: item.note ?? null,
      });
    }

    const totalAmount = toMoney(normalized.reduce((sum, item) => sum + item.amount, 0));
    await prisma.$transaction(async (tx) => {
      const existingBatch = requestedBatchId
        ? await tx.reimbursementBatch.findFirst({
          where: { id: requestedBatchId, householdId, advanceAccountId: requestedAdvanceAccountId },
          select: { id: true, reimbursements: { where: { deletedAt: null }, select: { paymentTxRecordId: true } } },
        })
        : null;
      if (existingBatch?.reimbursements.length) {
        const paymentTxRecordIds = existingBatch.reimbursements
          .map((reimbursement) => reimbursement.paymentTxRecordId)
          .filter((id): id is string => Boolean(id));
        const uniquePaymentTxRecordIds = [...new Set(paymentTxRecordIds)];
        const validPaymentCount = paymentTxRecordIds.length
          ? await tx.txRecord.count({ where: { householdId, id: { in: uniquePaymentTxRecordIds }, deletedAt: null } })
          : 0;
        if (paymentTxRecordIds.length === existingBatch.reimbursements.length && validPaymentCount === uniquePaymentTxRecordIds.length) {
          throw new Error("REIMBURSEMENT_BATCH_ALREADY_PAID");
        }
      }
      const batch = existingBatch ?? await tx.reimbursementBatch.create({
          data: { householdId, advanceAccountId: requestedAdvanceAccountId, title },
          select: { id: true },
        });
      await tx.reimbursement.create({
        data: {
          householdId,
          batchId: batch.id,
          advanceAccountId: requestedAdvanceAccountId,
          documentNumber: documentNumber || null,
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
          linkedTransactions: { create: linkedIds.map((txRecordId) => ({ txRecordId })) },
        },
      });
    });
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "REIMBURSEMENT_CREATE_FAILED" };
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

export async function reimburseReimbursement(
  formData: FormData,
  transactionClient?: Prisma.TransactionClient,
  sharedAccountIdsToRefresh?: Set<string>,
): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const actualAmount = toMoney(parseMoneyInput(formData.get("actualAmount")));
  const feeAmount = toMoney(parseMoneyInput(formData.get("feeAmount")));
  const balanceDiffMode = String(formData.get("balanceDiffMode") ?? "loss").trim();
  const settlementNote = String(formData.get("note") ?? "").trim();
  if (!reimbursementId) return { ok: false as const, error: "REIMBURSEMENT_NOT_FOUND" };
  if (!cashAccountId) return { ok: false as const, error: "REIMBURSEMENT_CASH_ACCOUNT_REQUIRED" };
  if (actualAmount <= 0) return { ok: false as const, error: "REIMBURSEMENT_ACTUAL_AMOUNT_INVALID" };
  if (balanceDiffMode !== "loss" && balanceDiffMode !== "remain") return { ok: false as const, error: "REIMBURSEMENT_BALANCE_DIFF_MODE_INVALID" };
  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : null;
  if (!date) return { ok: false as const, error: "REIMBURSEMENT_DATE_INVALID" };

  const accountIdsToRefresh: string[] = [];
  try {
    const settle = async (tx: Prisma.TransactionClient) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null },
        include: { linkedTransactions: true },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_NOT_FOUND");
      if (reimbursement.status !== ReimbursementStatus.pending) throw new Error("REIMBURSEMENT_ALREADY_REIMBURSED");
      if (!reimbursement.advanceAccountId) throw new Error("REIMBURSEMENT_ADVANCE_ACCOUNT_MISSING");

      const cashAccount = await tx.account.findFirst({
        where: { id: cashAccountId, householdId, isActive: true },
      });
      if (!cashAccount) throw new Error("REIMBURSEMENT_CASH_ACCOUNT_INVALID");
      if (isPureInvestmentAccount(cashAccount)) throw new Error("REIMBURSEMENT_CASH_ACCOUNT_INVALID");

      const linkedRecordIds = Array.from(
        new Set(reimbursement.linkedTransactions.map((link) => link.txRecordId)),
      );
      const originalAmountByRecordId = new Map<string, number>();
      const linkedRecords = linkedRecordIds.length > 0
        ? await tx.txRecord.findMany({
          where: {
            id: { in: linkedRecordIds },
            householdId,
            deletedAt: null,
            source: "advance",
            toAccountId: reimbursement.advanceAccountId ?? undefined,
          },
          select: { id: true, amount: true, principalAmount: true, categoryId: true, categoryName: true },
        })
        : [];
      if (linkedRecordIds.length > 0) {
        if (linkedRecords.length !== linkedRecordIds.length) {
          throw new Error("REIMBURSEMENT_TRANSACTION_NOT_FOUND");
        }
        for (const record of linkedRecords) {
          originalAmountByRecordId.set(
            record.id,
            reimbursementLinkedTransactionAmount(record.amount, record.principalAmount),
          );
        }
      }

      const settlements = linkedRecordIds.flatMap((txRecordId) => {
        const amount = originalAmountByRecordId.get(txRecordId) ?? 0;
        return amount > 0 && reimbursement.advanceAccountId
          ? [{ txRecordId, advanceAccountId: reimbursement.advanceAccountId, amount }]
          : [];
      });
      const advanceTotal = toMoney(settlements.reduce((sum, item) => sum + item.amount, 0));
      const settlementCalculation = calculateReimbursementSettlement(
        advanceTotal,
        actualAmount,
        balanceDiffMode,
      );
      const linkedCategoryIds = new Set(linkedRecords.map((record) => record.categoryId ?? ""));
      const linkedCategoryNames = new Set(linkedRecords.map((record) => record.categoryName?.trim() ?? ""));
      const sharedCategoryId = linkedCategoryIds.size === 1 ? linkedRecords[0]?.categoryId ?? null : null;
      const sharedCategoryName = linkedCategoryIds.size === 1 && linkedCategoryNames.size === 1
        ? linkedRecords[0]?.categoryName?.trim() || null
        : null;
      const differenceCategoryName = settlementCalculation.differenceAmount >= 0
        ? SYSTEM_REIMBURSEMENT_ALLOWANCE_CATEGORY
        : reimbursement.kind === ReimbursementKind.travel
          ? SYSTEM_REIMBURSEMENT_TRAVEL_SHORTFALL_CATEGORY
          : SYSTEM_REIMBURSEMENT_GENERAL_SHORTFALL_CATEGORY;

      const advanceAccountIds = Array.from(new Set([
        reimbursement.advanceAccountId,
        ...settlements.map((item) => item.advanceAccountId),
      ]));
      const advanceAccounts = await tx.account.findMany({
        where: {
          id: { in: advanceAccountIds },
          householdId,
          kind: { in: [AccountKind.loan, AccountKind.settlement] },
          liabilityDirection: "receivable",
        },
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
      let remainingToClear = settlementCalculation.clearingAmount;
      const clearingItems = settlements.flatMap((item) => {
        const amount = toMoney(Math.min(item.amount, remainingToClear));
        remainingToClear = toMoney(remainingToClear - amount);
        return amount > 0 ? [{ ...item, amount }] : [];
      });
      const clearingByAdvanceAccount = new Map<string, number>();
      for (const item of clearingItems) {
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

      const createdTransactionIds: string[] = [];

      // Keep one settlement transaction for the cash ledger. The principal
      // field records the reimbursement amount applied to advances while the
      // signed amount records the actual cash receipt.
      const advanceAccount = advanceAccountById.get(reimbursement.advanceAccountId);
      if (!advanceAccount) throw new Error("REIMBURSEMENT_ADVANCE_ACCOUNT_MISSING");
      const statementMonth = statementMonthForTransfer(date, advanceAccount, cashAccount);
      const transfer = await tx.txRecord.create({
        data: {
          accountId: advanceAccount.id,
          accountName: advanceAccount.name,
          toAccountId: cashAccount.id,
          toAccountName: cashAccount.name,
          amount: -actualAmount,
          principalAmount: settlementCalculation.clearingAmount,
          type: TransactionType.transfer,
          date,
          statementMonth,
          source: "reimbursement",
          categoryId: sharedCategoryId,
          categoryName: sharedCategoryName,
          reimbursementDifferenceAmount: new Prisma.Decimal(settlementCalculation.differenceAmount),
          reimbursementDifferenceCategoryName: differenceCategoryName,
          note: REIMBURSEMENT_COLLECT_NOTE,
          counterpartyInstitutionId: reimbursement.counterpartyId,
          counterpartyInstitutionName: reimbursement.counterpartyName,
          householdId,
        },
      });
      createdTransactionIds.push(transfer.id);
      for (const accountId of advanceAccountIds) accountIdsToRefresh.push(accountId);
      accountIdsToRefresh.push(cashAccount.id);

      await tx.reimbursement.update({
        where: { id: reimbursementId },
        data: {
          status: ReimbursementStatus.reimbursed,
          reimbursedDate: date,
          cashAccountId: cashAccount.id,
          cashAccountName: cashAccount.name,
          paymentTxRecordId: createdTransactionIds[0] ?? null,
          note: settlementNote || null,
        },
      });
      await tx.reimbursementSettlement.create({
        data: {
          reimbursementId: reimbursement.id,
          amount: new Prisma.Decimal(actualAmount),
          feeAmount: new Prisma.Decimal(feeAmount),
          writeOffAmount: new Prisma.Decimal(settlementCalculation.writeOffAmount),
          balanceDiffMode: balanceDiffMode as "loss" | "remain",
          date,
          cashAccountId: cashAccount.id,
          cashAccountName: cashAccount.name,
          note: settlementNote || null,
          transactions: {
            create: createdTransactionIds.map((txRecordId) => ({ txRecordId })),
          },
        },
      });
    };
    if (transactionClient) await settle(transactionClient);
    else await prisma.$transaction(settle);
  } catch (error) {
    const message = error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN";
    return { ok: false as const, error: message };
  }

  if (sharedAccountIdsToRefresh) {
    for (const accountId of accountIdsToRefresh) sharedAccountIdsToRefresh.add(accountId);
  } else for (const accountId of new Set(accountIdsToRefresh)) {
    await recalcAndSaveAccountBalance(accountId).catch((error) => {
      console.error("Failed to recalculate reimbursement account balance", { accountId, error });
    });
  }
  if (!transactionClient) revalidateAfterTxChange();
  return { ok: true as const };
}

async function removeReimbursementSettlementTransactions(
  tx: Prisma.TransactionClient,
  householdId: string,
  settlementId: string,
) {
  const settlement = await tx.reimbursementSettlement.findFirst({
    where: { id: settlementId, Reimbursement: { householdId, deletedAt: null } },
    include: { transactions: { select: { txRecordId: true } } },
  });
  if (!settlement) throw new Error("REIMBURSEMENT_SETTLEMENT_NOT_FOUND");
  if (settlement.transactions.length === 0) throw new Error("REIMBURSEMENT_SETTLEMENT_LEGACY_UNEDITABLE");
  const txRecordIds = settlement.transactions.map((item) => item.txRecordId);
  const deletedAt = new Date();
  await tx.txRecord.updateMany({
    where: { id: { in: txRecordIds }, householdId, deletedAt: null },
    data: { deletedAt },
  });
  await tx.reimbursementSettlement.delete({ where: { id: settlementId } });
  return txRecordIds;
}

export async function deleteReimbursementSettlement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const settlementId = String(formData.get("settlementId") ?? "").trim();
  if (!settlementId) return { ok: false, error: "REIMBURSEMENT_SETTLEMENT_NOT_FOUND" };
  const accountIds = new Set<string>();
  try {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.reimbursementSettlement.findFirst({
        where: { id: settlementId, Reimbursement: { householdId, deletedAt: null } },
        select: { reimbursementId: true, cashAccountId: true },
      });
      if (!settlement) throw new Error("REIMBURSEMENT_SETTLEMENT_NOT_FOUND");
      const reimbursement = await tx.reimbursement.findUnique({
        where: { id: settlement.reimbursementId },
        select: { advanceAccountId: true },
      });
      if (reimbursement?.advanceAccountId) accountIds.add(reimbursement.advanceAccountId);
      accountIds.add(settlement.cashAccountId);
      await removeReimbursementSettlementTransactions(tx, householdId, settlementId);
      await tx.reimbursement.update({
        where: { id: settlement.reimbursementId },
        data: { status: ReimbursementStatus.pending, reimbursedDate: null, cashAccountId: null, cashAccountName: null, paymentTxRecordId: null },
      });
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN" };
  }
  for (const accountId of accountIds) {
    await recalcAndSaveAccountBalance(accountId).catch((error) => {
      console.error("Failed to recalculate reimbursement account balance", { accountId, error });
    });
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function updateReimbursementSettlement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const settlementId = String(formData.get("settlementId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const actualAmount = toMoney(parseMoneyInput(formData.get("actualAmount")));
  const feeAmount = toMoney(parseMoneyInput(formData.get("feeAmount")));
  const balanceDiffMode = String(formData.get("balanceDiffMode") ?? "loss").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!settlementId) return { ok: false, error: "REIMBURSEMENT_SETTLEMENT_NOT_FOUND" };
  if (!cashAccountId) return { ok: false, error: "REIMBURSEMENT_CASH_ACCOUNT_REQUIRED" };
  if (actualAmount <= 0) return { ok: false, error: "REIMBURSEMENT_ACTUAL_AMOUNT_INVALID" };
  if (balanceDiffMode !== "loss" && balanceDiffMode !== "remain") return { ok: false, error: "REIMBURSEMENT_BALANCE_DIFF_MODE_INVALID" };
  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : null;
  if (!date) return { ok: false, error: "REIMBURSEMENT_DATE_INVALID" };

  const accountIds = new Set<string>();
  try {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.reimbursementSettlement.findFirst({
        where: { id: settlementId, Reimbursement: { householdId, deletedAt: null } },
        select: { reimbursementId: true, cashAccountId: true },
      });
      if (!settlement) throw new Error("REIMBURSEMENT_SETTLEMENT_NOT_FOUND");
      const reimbursement = await tx.reimbursement.findUnique({
        where: { id: settlement.reimbursementId },
        select: { advanceAccountId: true, status: true },
      });
      if (!reimbursement || reimbursement.status !== ReimbursementStatus.reimbursed) throw new Error("REIMBURSEMENT_SETTLEMENT_NOT_FOUND");
      if (reimbursement.advanceAccountId) accountIds.add(reimbursement.advanceAccountId);
      accountIds.add(settlement.cashAccountId);
      accountIds.add(cashAccountId);
      await removeReimbursementSettlementTransactions(tx, householdId, settlementId);
      await tx.reimbursement.update({
        where: { id: settlement.reimbursementId },
        data: { status: ReimbursementStatus.pending, reimbursedDate: null, cashAccountId: null, cashAccountName: null, paymentTxRecordId: null },
      });
      const settlementForm = new FormData();
      settlementForm.set("reimbursementId", settlement.reimbursementId);
      settlementForm.set("cashAccountId", cashAccountId);
      settlementForm.set("date", date.toISOString());
      settlementForm.set("actualAmount", String(actualAmount));
      settlementForm.set("feeAmount", String(feeAmount));
      settlementForm.set("balanceDiffMode", balanceDiffMode);
      settlementForm.set("note", note);
      const result = await reimburseReimbursement(settlementForm, tx, accountIds);
      if (!result.ok) throw new Error(result.error);
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN" };
  }
  for (const accountId of accountIds) {
    await recalcAndSaveAccountBalance(accountId).catch((error) => {
      console.error("Failed to recalculate reimbursement account balance", { accountId, error });
    });
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function reimburseReimbursementBatch(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const batchId = String(formData.get("batchId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const approvedAmountsRaw = String(formData.get("approvedAmounts") ?? "").trim();
  const feeAmountsRaw = String(formData.get("feeAmounts") ?? "").trim();
  if (!batchId || !cashAccountId || !date) return { ok: false, error: "REIMBURSEMENT_BATCH_SETTLEMENT_FIELDS_REQUIRED" };

  const reimbursements = await prisma.reimbursement.findMany({
    where: { householdId, batchId, deletedAt: null, status: ReimbursementStatus.pending },
    select: { id: true, approvedAmount: true, totalAmount: true },
    orderBy: [{ createdAt: "asc" }],
  });
  if (reimbursements.length === 0) return { ok: false, error: "REIMBURSEMENT_BATCH_NO_PENDING_DOCUMENTS" };
  const balanceDiffMode = String(formData.get("balanceDiffMode") ?? "loss").trim();
  if (balanceDiffMode !== "loss" && balanceDiffMode !== "remain") return { ok: false, error: "REIMBURSEMENT_BALANCE_DIFF_MODE_INVALID" };
  let approvedAmounts: Record<string, number> = {};
  let feeAmounts: Record<string, number> = {};
  if (approvedAmountsRaw) {
    try {
      const parsed = JSON.parse(approvedAmountsRaw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      approvedAmounts = Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, parseMoneyInput(value)]));
    } catch {
      return { ok: false, error: "REIMBURSEMENT_APPROVED_AMOUNT_INVALID" };
    }
  }
  if (feeAmountsRaw) {
    try {
      const parsed = JSON.parse(feeAmountsRaw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      feeAmounts = Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, parseMoneyInput(value)]));
    } catch {
      return { ok: false, error: "REIMBURSEMENT_FEE_AMOUNT_INVALID" };
    }
  }

  const accountIdsToRefresh = new Set<string>();
  try {
    await prisma.$transaction(async (tx) => {
      const currentReimbursements = await tx.reimbursement.findMany({
        where: { householdId, batchId, deletedAt: null, status: ReimbursementStatus.pending },
        select: { id: true, approvedAmount: true, totalAmount: true },
        orderBy: [{ createdAt: "asc" }],
      });
      if (currentReimbursements.length !== reimbursements.length) throw new Error("REIMBURSEMENT_BATCH_CHANGED_RETRY");
      for (const reimbursement of currentReimbursements) {
        const hasDraftAmount = Object.prototype.hasOwnProperty.call(approvedAmounts, reimbursement.id);
        const draftAmount = hasDraftAmount ? toMoney(approvedAmounts[reimbursement.id]) : null;
        const feeAmount = Object.prototype.hasOwnProperty.call(feeAmounts, reimbursement.id)
          ? toMoney(feeAmounts[reimbursement.id])
          : 0;
        if (draftAmount !== null) {
          if (draftAmount < 0) throw new Error("REIMBURSEMENT_APPROVED_AMOUNT_INVALID");
          if (draftAmount > Number(reimbursement.totalAmount)) throw new Error("REIMBURSEMENT_APPROVED_AMOUNT_EXCEEDS_CLAIM");
          await tx.reimbursement.update({
            where: { id: reimbursement.id },
            data: { approvedAmount: new Prisma.Decimal(draftAmount) },
          });
        }
        const settlementForm = new FormData();
        settlementForm.set("reimbursementId", reimbursement.id);
        settlementForm.set("cashAccountId", cashAccountId);
        settlementForm.set("date", date);
        const approvedValue = draftAmount ?? Number(reimbursement.approvedAmount ?? reimbursement.totalAmount);
        const actualAmount = toMoney(approvedValue + feeAmount);
        if (actualAmount <= 0) throw new Error("REIMBURSEMENT_ACTUAL_AMOUNT_INVALID");
        settlementForm.set("actualAmount", String(actualAmount));
        settlementForm.set("feeAmount", String(feeAmount));
        settlementForm.set("balanceDiffMode", balanceDiffMode);
        settlementForm.set("note", note);
        const result = await reimburseReimbursement(settlementForm, tx, accountIdsToRefresh);
        if (!result.ok) throw new Error(result.error);
      }
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN" };
  }
  for (const accountId of accountIdsToRefresh) {
    await recalcAndSaveAccountBalance(accountId).catch((error) => {
      console.error("Failed to recalculate reimbursement account balance", { accountId, error });
    });
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function approveReimbursement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const approvedAmount = parseMoneyInput(formData.get("approvedAmount"));
  const approvalDate = parseDateValue(formData.get("approvalDate"));
  const approvalNote = String(formData.get("approvalNote") ?? "").trim() || null;
  if (!reimbursementId) return { ok: false, error: "REIMBURSEMENT_NOT_FOUND" };
  if (!approvalDate) return { ok: false, error: "REIMBURSEMENT_APPROVAL_DATE_INVALID" };
  if (approvedAmount < 0) return { ok: false, error: "REIMBURSEMENT_APPROVED_AMOUNT_INVALID" };
  const approvedValue = toMoney(approvedAmount);
  try {
    const reimbursement = await prisma.reimbursement.findFirst({
      where: {
        id: reimbursementId,
        householdId,
        deletedAt: null,
        status: ReimbursementStatus.pending,
      },
      select: { id: true, totalAmount: true },
    });
    if (!reimbursement) return { ok: false, error: "REIMBURSEMENT_NOT_PENDING" };
    if (approvedValue > Number(reimbursement.totalAmount)) return { ok: false, error: "REIMBURSEMENT_APPROVED_AMOUNT_EXCEEDS_CLAIM" };
    await prisma.reimbursement.update({
      where: { id: reimbursementId },
      data: {
        approvedAmount: new Prisma.Decimal(approvedValue),
        approvalDate,
        approvalNote,
      },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN" };
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function cancelReimbursementApproval(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  if (!reimbursementId) return { ok: false, error: "REIMBURSEMENT_NOT_FOUND" };
  try {
    const reimbursement = await prisma.reimbursement.findFirst({
      where: { id: reimbursementId, householdId, deletedAt: null },
      select: { id: true, status: true, paymentTxRecordId: true },
    });
    if (!reimbursement) return { ok: false, error: "REIMBURSEMENT_NOT_FOUND" };
    const activePayment = reimbursement.paymentTxRecordId
      ? await prisma.txRecord.findFirst({
        where: { id: reimbursement.paymentTxRecordId, householdId, deletedAt: null },
        select: { id: true },
      })
      : null;
    if (activePayment) {
      return { ok: false, error: "REIMBURSEMENT_APPROVAL_CANNOT_CANCEL_AFTER_PAYMENT" };
    }
    await prisma.reimbursement.update({
      where: { id: reimbursementId },
      data: { approvedAmount: null, approvalDate: null, approvalNote: null },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN" };
  }
  revalidateAfterTxChange();
  return { ok: true };
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

// ─── Update reimbursement header ─────────────────────────────────────────────
export async function updateReimbursement(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  if (!reimbursementId) return { ok: false as const, error: "REIMBURSEMENT_NOT_FOUND" };
  const documentNumber = String(formData.get("documentNumber") ?? "").trim();
  const submittedTitle = String(formData.get("title") ?? "").trim();
  const title = documentNumber || submittedTitle;
  const travelStartDateRaw = String(formData.get("travelStartDate") ?? "").trim();
  const travelEndDateRaw = String(formData.get("travelEndDate") ?? "").trim();
  const travelReason = String(formData.get("travelReason") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const batchId = String(formData.get("batchId") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "").trim();
  const kind = kindRaw ? parseReimbursementKind(kindRaw) : null;
  const attachmentCountRaw = String(formData.get("attachmentCount") ?? "").trim();
  if (!title) return { ok: false as const, error: "REIMBURSEMENT_TITLE_REQUIRED" };
  const attachmentCountValue = attachmentCountRaw ? evaluateArithmeticExpression(attachmentCountRaw) : null;
  const attachmentCount = attachmentCountRaw
    ? attachmentCountValue == null ? Number.NaN : Math.round(attachmentCountValue)
    : null;
  const travelStartDate = parseDateValue(travelStartDateRaw);
  const travelEndDate = parseDateValue(travelEndDateRaw);
  if (attachmentCountRaw && (attachmentCount == null || !Number.isInteger(attachmentCount) || attachmentCount < 0)) {
    return { ok: false as const, error: "REIMBURSEMENT_ATTACHMENT_COUNT_INVALID" };
  }
  if ((travelStartDateRaw && (!travelStartDate || Number.isNaN(travelStartDate.getTime())))
    || (travelEndDateRaw && (!travelEndDate || Number.isNaN(travelEndDate.getTime())))) {
    return { ok: false as const, error: "REIMBURSEMENT_DATE_INVALID" };
  }
  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_NOT_FOUND");
      if (reimbursement.status !== ReimbursementStatus.pending) throw new Error("REIMBURSEMENT_NOT_PENDING");
      let batch = batchId
        ? await tx.reimbursementBatch.findFirst({
          where: { id: batchId, householdId, ...(reimbursement.advanceAccountId ? { advanceAccountId: reimbursement.advanceAccountId } : {}) },
          select: { id: true, advanceAccountId: true },
        })
        : null;
      if (!batch && !batchId && reimbursement.advanceAccountId) {
        batch = await tx.reimbursementBatch.create({
          data: { householdId, advanceAccountId: reimbursement.advanceAccountId, title },
          select: { id: true, advanceAccountId: true },
        });
      }
      if (!batch) throw new Error("REIMBURSEMENT_BATCH_INVALID");
      const batchReimbursements = await tx.reimbursement.findMany({
        where: { batchId: batch.id, deletedAt: null },
        select: { paymentTxRecordId: true },
      });
      if (batchReimbursements.length > 0) {
        const paymentTxRecordIds = batchReimbursements
          .map((item) => item.paymentTxRecordId)
          .filter((id): id is string => Boolean(id));
        const uniquePaymentTxRecordIds = [...new Set(paymentTxRecordIds)];
        const validPaymentCount = paymentTxRecordIds.length
          ? await tx.txRecord.count({ where: { householdId, id: { in: uniquePaymentTxRecordIds }, deletedAt: null } })
          : 0;
        if (paymentTxRecordIds.length === batchReimbursements.length && validPaymentCount === uniquePaymentTxRecordIds.length) {
          throw new Error("REIMBURSEMENT_BATCH_ALREADY_PAID");
        }
      }
      await tx.reimbursement.update({
        where: { id: reimbursementId },
        data: {
          documentNumber: documentNumber || null,
          title,
          ...(kind ? { kind } : {}),
          travelStartDate,
          travelEndDate,
          travelReason: travelReason || null,
          note: note || null,
          attachmentCount,
          batchId: batch.id,
          advanceAccountId: reimbursement.advanceAccountId ?? batch.advanceAccountId,
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN";
    return { ok: false as const, error: message };
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

// ─── Update reimbursement item ────────────────────────────────────────────────
export async function updateReimbursementItem(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const itemId = String(formData.get("itemId") ?? "").trim();
  const expenseItem = String(formData.get("expenseItem") ?? "").trim() || null;
  const categoryName = String(formData.get("categoryName") ?? "").trim() || null;
  const fromPlace = String(formData.get("fromPlace") ?? "").trim() || null;
  const toPlace = String(formData.get("toPlace") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  const days = parseDaysInput(formData.get("days"));
  const amountRaw = parseMoneyInput(formData.get("amount"));
  const outsideTransportAmount = parseMoneyInput(formData.get("outsideTransportAmount"));
  const cityTransportAmount = parseMoneyInput(formData.get("cityTransportAmount"));
  const subsidyAmount = parseMoneyInput(formData.get("subsidyAmount"));
  const lodgingAmount = parseMoneyInput(formData.get("lodgingAmount"));
  const isTravelRow = ["outsideTransportAmount", "cityTransportAmount", "subsidyAmount", "lodgingAmount"]
    .some((field) => formData.has(field));
  if (expenseItem && !parseExpenseItem(expenseItem)) return { ok: false as const, error: "REIMBURSEMENT_ITEM_INVALID" };
  const normalizedAmount = isTravelRow
    ? toMoney(outsideTransportAmount + cityTransportAmount + subsidyAmount + lodgingAmount)
    : amountRaw;
  const entryDateRaw = String(formData.get("entryDate") ?? "").trim();
  if (!itemId) return { ok: false as const, error: "REIMBURSEMENT_ITEM_NOT_FOUND" };
  if (normalizedAmount < 0 || (!isTravelRow && amountRaw <= 0)) return { ok: false as const, error: "REIMBURSEMENT_ITEM_AMOUNT_INVALID" };
  if (days !== null && (!Number.isInteger(days) || days < 0)) return { ok: false as const, error: "REIMBURSEMENT_ITEM_DAYS_INVALID" };
  if (!entryDateRaw) return { ok: false as const, error: "REIMBURSEMENT_ITEM_DATE_INVALID" };
  const entryDate = parseDateValue(entryDateRaw);
  if (!entryDate || isNaN(entryDate.getTime())) return { ok: false as const, error: "REIMBURSEMENT_ITEM_DATE_INVALID" };
  try {
    await prisma.$transaction(async (tx) => {
      // First verify the item belongs to a pending reimbursement in this household
      const reimbursement = await tx.reimbursement.findFirst({
        where: { householdId, deletedAt: null, status: ReimbursementStatus.pending, items: { some: { id: itemId } } },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_ITEM_NOT_FOUND");
      const reimbursementId = reimbursement.id;
      const items = await tx.reimbursementItem.findMany({ where: { reimbursementId } });
      const otherTotal = items.filter((i) => i.id !== itemId).reduce((sum, i) => sum + Number(i.amount), 0);
      const newTotal = toMoney(otherTotal + normalizedAmount);
      await tx.reimbursementItem.update({
        where: { id: itemId },
        data: {
          categoryName,
          expenseItem: expenseItem as ReimbursementExpenseItem | null,
          fromPlace,
          toPlace,
          note,
          amount: new Prisma.Decimal(normalizedAmount),
          outsideTransportAmount: isTravelRow ? new Prisma.Decimal(toMoney(outsideTransportAmount)) : null,
          cityTransportAmount: isTravelRow ? new Prisma.Decimal(toMoney(cityTransportAmount)) : null,
          subsidyAmount: isTravelRow ? new Prisma.Decimal(toMoney(subsidyAmount)) : null,
          lodgingAmount: isTravelRow ? new Prisma.Decimal(toMoney(lodgingAmount)) : null,
          days,
          entryDate,
        },
      });
      await tx.reimbursement.update({
        where: { id: reimbursementId },
        data: { totalAmount: new Prisma.Decimal(newTotal) },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN";
    return { ok: false as const, error: message };
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

export async function createReimbursementItem(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const expenseItem = String(formData.get("expenseItem") ?? "").trim() || null;
  const categoryName = String(formData.get("categoryName") ?? "").trim() || null;
  const fromPlace = String(formData.get("fromPlace") ?? "").trim() || null;
  const toPlace = String(formData.get("toPlace") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  const days = parseDaysInput(formData.get("days"));
  const amountRaw = parseMoneyInput(formData.get("amount"));
  const outsideTransportAmount = parseMoneyInput(formData.get("outsideTransportAmount"));
  const cityTransportAmount = parseMoneyInput(formData.get("cityTransportAmount"));
  const subsidyAmount = parseMoneyInput(formData.get("subsidyAmount"));
  const lodgingAmount = parseMoneyInput(formData.get("lodgingAmount"));
  const isTravelRow = ["outsideTransportAmount", "cityTransportAmount", "subsidyAmount", "lodgingAmount"]
    .some((field) => formData.has(field));
  if (expenseItem && !parseExpenseItem(expenseItem)) return { ok: false as const, error: "REIMBURSEMENT_ITEM_INVALID" };
  const normalizedAmount = isTravelRow
    ? toMoney(outsideTransportAmount + cityTransportAmount + subsidyAmount + lodgingAmount)
    : amountRaw;
  const entryDateRaw = String(formData.get("entryDate") ?? "").trim();
  if (!reimbursementId) return { ok: false as const, error: "REIMBURSEMENT_NOT_FOUND" };
  if (normalizedAmount < 0 || (!isTravelRow && amountRaw <= 0)) return { ok: false as const, error: "REIMBURSEMENT_ITEM_AMOUNT_INVALID" };
  if (days !== null && (!Number.isInteger(days) || days < 0)) return { ok: false as const, error: "REIMBURSEMENT_ITEM_DAYS_INVALID" };
  if (!entryDateRaw) return { ok: false as const, error: "REIMBURSEMENT_ITEM_DATE_INVALID" };
  const entryDate = parseDateValue(entryDateRaw);
  if (!entryDate || isNaN(entryDate.getTime())) return { ok: false as const, error: "REIMBURSEMENT_ITEM_DATE_INVALID" };
  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null, status: ReimbursementStatus.pending },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_NOT_FOUND");
      await tx.reimbursementItem.create({
        data: {
          reimbursementId,
          txRecordId: null,
          advanceAccountId: reimbursement.advanceAccountId ?? null,
          amount: new Prisma.Decimal(normalizedAmount),
          ...(isTravelRow ? {
            outsideTransportAmount: new Prisma.Decimal(toMoney(outsideTransportAmount)),
            cityTransportAmount: new Prisma.Decimal(toMoney(cityTransportAmount)),
            subsidyAmount: new Prisma.Decimal(toMoney(subsidyAmount)),
            lodgingAmount: new Prisma.Decimal(toMoney(lodgingAmount)),
          } : {}),
          days,
          entryDate,
          categoryName,
          expenseItem: expenseItem as ReimbursementExpenseItem | null,
          fromPlace,
          toPlace,
          note,
        },
      });
      const items = await tx.reimbursementItem.findMany({ where: { reimbursementId }, select: { amount: true } });
      await tx.reimbursement.update({
        where: { id: reimbursementId },
        data: { totalAmount: new Prisma.Decimal(toMoney(items.reduce((sum, item) => sum + Number(item.amount), 0))) },
      });
    });
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "REIMBURSEMENT_UNKNOWN" };
  }
  revalidateAfterTxChange();
  return { ok: true as const };
}

export async function linkReimbursementTransaction(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const txRecordId = String(formData.get("txRecordId") ?? "").trim();
  if (!reimbursementId || !txRecordId) return { ok: false, error: "REIMBURSEMENT_ITEM_INVALID" };

  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null, status: ReimbursementStatus.pending },
      });
      if (!reimbursement?.advanceAccountId) throw new Error("REIMBURSEMENT_NOT_FOUND");
      const existingLink = await tx.reimbursementTransaction.findUnique({ where: { txRecordId }, select: { id: true } });
      if (existingLink) throw new Error("REIMBURSEMENT_ITEM_INVALID");
      const record = await tx.txRecord.findFirst({
        where: {
          id: txRecordId,
          householdId,
          deletedAt: null,
          source: "advance",
          toAccountId: reimbursement.advanceAccountId,
        },
        select: { id: true, date: true, amount: true, categoryName: true, note: true, accountId: true, toAccountId: true },
      });
      if (!record) throw new Error("REIMBURSEMENT_ITEM_INVALID");
      await tx.reimbursementTransaction.create({ data: { reimbursementId, txRecordId: record.id } });
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_ITEM_INVALID" };
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function linkReimbursementTransactions(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const rawIds = String(formData.get("txRecordIds") ?? "").trim();
  let txRecordIds: string[] = [];
  try {
    const parsed = JSON.parse(rawIds) as unknown;
    txRecordIds = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
  } catch {
    txRecordIds = rawIds.split(",").map((value) => value.trim()).filter(Boolean);
  }
  txRecordIds = Array.from(new Set(txRecordIds));
  if (!reimbursementId || txRecordIds.length === 0) return { ok: false, error: "REIMBURSEMENT_ITEM_INVALID" };

  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null, status: ReimbursementStatus.pending },
        select: { id: true, advanceAccountId: true },
      });
      if (!reimbursement?.advanceAccountId) throw new Error("REIMBURSEMENT_NOT_FOUND");
      const records = await tx.txRecord.findMany({
        where: {
          id: { in: txRecordIds },
          householdId,
          deletedAt: null,
          source: "advance",
          toAccountId: reimbursement.advanceAccountId,
        },
        select: { id: true },
      });
      if (records.length !== txRecordIds.length) throw new Error("REIMBURSEMENT_ITEM_INVALID");
      const existingLinks = await tx.reimbursementTransaction.findMany({
        where: { txRecordId: { in: txRecordIds } },
        select: { txRecordId: true, reimbursementId: true },
      });
      if (existingLinks.some((link) => link.reimbursementId !== reimbursementId)) throw new Error("REIMBURSEMENT_ITEM_INVALID");
      const linkedIds = new Set(existingLinks.map((link) => link.txRecordId));
      const newIds = records.map((record) => record.id).filter((id) => !linkedIds.has(id));
      if (newIds.length > 0) {
        await tx.reimbursementTransaction.createMany({
          data: newIds.map((txRecordId) => ({ reimbursementId, txRecordId })),
        });
      }
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_ITEM_INVALID" };
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function unlinkReimbursementTransaction(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const txRecordId = String(formData.get("txRecordId") ?? "").trim();
  if (!reimbursementId || !txRecordId) return { ok: false, error: "REIMBURSEMENT_ITEM_NOT_FOUND" };

  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null, status: ReimbursementStatus.pending },
        select: { id: true },
      });
      if (!reimbursement) throw new Error("REIMBURSEMENT_NOT_FOUND");
      const result = await tx.reimbursementTransaction.deleteMany({ where: { reimbursementId, txRecordId } });
      if (result.count === 0) throw new Error("REIMBURSEMENT_TRANSACTION_NOT_FOUND");
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_ITEM_NOT_FOUND" };
  }
  revalidateAfterTxChange();
  return { ok: true };
}

export async function deleteReimbursementItem(formData: FormData): Promise<ReimbursementActionResult> {
  const { householdId } = await getHouseholdScope();
  const reimbursementId = String(formData.get("reimbursementId") ?? "").trim();
  const itemId = String(formData.get("itemId") ?? "").trim();
  if (!reimbursementId || !itemId) return { ok: false, error: "REIMBURSEMENT_ITEM_NOT_FOUND" };

  try {
    await prisma.$transaction(async (tx) => {
      const reimbursement = await tx.reimbursement.findFirst({
        where: { id: reimbursementId, householdId, deletedAt: null, status: ReimbursementStatus.pending },
        include: { items: { where: { id: itemId } } },
      });
      const item = reimbursement?.items[0];
      if (!reimbursement || !item) throw new Error("REIMBURSEMENT_ITEM_NOT_FOUND");
      await tx.reimbursementItem.delete({ where: { id: item.id } });
      const remainingItems = await tx.reimbursementItem.findMany({ where: { reimbursementId }, select: { amount: true } });
      await tx.reimbursement.update({
        where: { id: reimbursementId },
        data: { totalAmount: new Prisma.Decimal(toMoney(remainingItems.reduce((sum, row) => sum + Number(row.amount), 0))) },
      });
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "REIMBURSEMENT_ITEM_DELETE_FAILED" };
  }
  revalidateAfterTxChange();
  return { ok: true };
}
