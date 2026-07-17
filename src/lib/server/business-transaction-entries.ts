import { FundSubtype, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { entryBusinessTypeLabel } from "@/lib/server/entry-business-link";

function ymd(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function linkSummary(rows: Array<{ businessType: string }>) {
  return {
    businessLinkCount: rows.length,
    businessLinkLabels: Array.from(new Set(rows.map((row) => entryBusinessTypeLabel(row.businessType)))),
  };
}

function isCashInAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.redeem || action === FundSubtype.switch_out || action === FundSubtype.dividend_cash;
}

function accountLabel(account?: { name?: string | null; Institution?: { shortName?: string | null; name?: string | null } | null } | null) {
  if (!account) return "";
  return [account.Institution?.shortName || account.Institution?.name || "", account.name || ""].filter(Boolean).join(" · ");
}

export async function loadInsuranceTransactionDetailLike(params: {
  householdId: string;
  accountId: string;
}) {
  const rows = await prisma.insuranceTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      deletedAt: null,
    },
    include: {
      CashAccount: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      Account: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      InsuranceProduct: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { businessType: true },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const action = row.action || "premium";
    const isRefund = action === "refund";
    const amount = Math.abs(toNumber(row.amount));
    const cashAccountName = row.CashAccount?.name ?? "";
    const businessAccountName = row.Account?.name ?? "";
    return {
      id: row.cashEntryId ?? row.id,
      businessTransactionId: row.id,
      date: ymd(row.tradeDate),
      postedAt: ymd(row.postedAt),
      createdAt: iso(row.createdAt),
      fundArrivalDate: ymd(row.arrivalDate),
      amount: isRefund ? amount : -amount,
      type: "investment",
      source: "insurance",
      accountId: isRefund ? row.accountId : row.cashAccountId,
      accountName: isRefund ? businessAccountName : cashAccountName,
      accountInstitutionName: isRefund ? row.Account.Institution?.shortName ?? row.Account.Institution?.name ?? "" : row.CashAccount?.Institution?.shortName ?? row.CashAccount?.Institution?.name ?? "",
      toAccountId: isRefund ? row.cashAccountId : row.accountId,
      toAccountName: isRefund ? cashAccountName : businessAccountName,
      toAccountInstitutionName: isRefund ? row.CashAccount?.Institution?.shortName ?? row.CashAccount?.Institution?.name ?? "" : row.Account.Institution?.shortName ?? row.Account.Institution?.name ?? "",
      fundSubtype: isRefund ? FundSubtype.redeem : FundSubtype.buy,
      fundProductType: null,
      fundName: row.InsuranceProduct?.name ?? "",
      insuranceProductName: row.InsuranceProduct?.name ?? "",
      insuranceProductId: row.insuranceProductId,
      insuranceAction: action,
      note: row.note,
      fundFee: row.fee == null ? null : toNumber(row.fee),
      realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
      coverageAmount: row.InsuranceProduct?.coverageAmount == null ? null : toNumber(row.InsuranceProduct.coverageAmount),
      paymentTermYears: row.InsuranceProduct?.paymentTermYears == null ? null : toNumber(row.InsuranceProduct.paymentTermYears),
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}

export async function loadDepositTransactionDetailLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.depositTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      CashAccount: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { businessType: true },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const principal = Math.abs(toNumber(row.principalAmount));
    const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
    return {
      id: row.cashEntryId ?? row.id,
      businessTransactionId: row.id,
      date: row.tradeDate,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      type: "investment",
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? arrivalAmount ?? principal : -principal,
      fundCode: null,
      fundName: row.productName ?? "",
      fundProductType: "deposit",
      fundSubtype: row.action,
      fundNav: row.annualRate,
      fundConfirmDate: null,
      fundArrivalDate: ymd(row.arrivalDate ?? row.maturityDate),
      fundArrivalAmount: row.arrivalAmount,
      depositAnnualRate: row.annualRate,
      depositInterest: row.interest,
      depositSourceEntryId: row.sourceDepositTransactionId,
      source: row.source,
      note: row.note,
      cashAccountLabel: accountLabel(row.CashAccount),
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}

export async function loadWealthTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.wealthTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: true,
      CashAccount: true,
      WealthProduct: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { businessType: true },
      },
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  const existingIds = rows.map((row) => row.id);
  const legacyRows = await prisma.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      id: existingIds.length > 0 ? { notIn: existingIds } : undefined,
      OR: [{ accountId: { in: accountIds } }, { toAccountId: { in: accountIds } }],
      type: { in: [TransactionType.investment, TransactionType.transfer] },
    },
    include: {
      account: true,
      toAccount: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  const projectedRows = rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
    return {
      id: row.cashEntryId ?? row.id,
      businessTransactionId: row.id,
      date: row.tradeDate,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? arrivalAmount ?? grossAmount : -grossAmount,
      fundCode: row.wealthProductId ?? row.productName ?? row.WealthProduct?.name ?? "",
      fundName: row.WealthProduct?.name ?? row.productName ?? "",
      fundProductType: "wealth",
      fundSubtype: row.action,
      fundArrivalAmount: row.arrivalAmount,
      depositAnnualRate: row.annualRate ?? row.WealthProduct?.annualRate ?? null,
      depositInterest: row.interest,
      wealthProductId: row.wealthProductId,
      WealthProduct: row.WealthProduct,
      source: row.source,
      note: row.note,
      ...linkSummary(row.EntryBusinessLink),
    };
  });

  const legacyProjectedRows = legacyRows.map((row) => {
    const isCashIn = accountIds.includes(row.accountId);
    const amount = toNumber(row.amount);
    const absAmount = Math.abs(amount);
    const productName = row.fundName || row.note || "历史理财";
    const fundCode = row.wealthProductId || row.fundName || `legacy-wealth:${isCashIn ? row.accountId : row.toAccountId ?? accountIds[0]}`;
    return {
      id: row.id,
      businessTransactionId: null,
      date: row.date,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      accountId: isCashIn ? row.accountId : row.accountId,
      accountName: row.account?.name ?? "",
      toAccountId: row.toAccountId,
      toAccountName: row.toAccount?.name ?? "",
      amount,
      fundCode,
      fundName: productName,
      fundProductType: "wealth",
      fundSubtype: isCashIn ? FundSubtype.redeem : FundSubtype.buy,
      fundArrivalAmount: isCashIn ? absAmount : null,
      depositAnnualRate: null,
      depositInterest: null,
      wealthProductId: row.wealthProductId,
      WealthProduct: null,
      source: row.source,
      note: row.note,
      businessLinkCount: 0,
      businessLinkLabels: [],
    };
  });

  return [...projectedRows, ...legacyProjectedRows].sort((a, b) => {
    const dateDiff = new Date(a.date as any).getTime() - new Date(b.date as any).getTime();
    if (dateDiff !== 0) return dateDiff;
    return new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime();
  });
}

export async function loadPreciousMetalTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.preciousMetalTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: true,
      CashAccount: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { businessType: true },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const amount = Math.abs(toNumber(row.amount));
    return {
      id: row.cashEntryId ?? row.id,
      businessTransactionId: row.id,
      date: row.tradeDate,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? amount : -amount,
      fundCode: row.metalTypeId,
      fundName: row.metalTypeName,
      fundProductType: "metal",
      fundSubtype: row.action,
      source: row.source,
      note: row.note,
      realizedProfit: row.realizedProfit,
      metalTypeId: row.metalTypeId,
      metalTypeName: row.metalTypeName,
      metalUnitId: row.metalUnitId,
      metalUnitName: row.metalUnitName,
      metalQuantity: row.quantity,
      metalUnitPrice: row.unitPrice,
      metalFee: row.fee,
      fundFee: row.fee,
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}
