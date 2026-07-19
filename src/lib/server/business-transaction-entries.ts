import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { isWealthHoldingCleared, resetWealthHoldingBucket } from "@/lib/invest-balance";
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
      cashEntryId: row.cashEntryId,
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
      cashEntryId: row.cashEntryId,
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
  const unitBuckets = new Map<string, { principal: number; units: number; cycleHasUnits: boolean }>();
  const remainingUnitsByTransactionId = new Map<string, number | null>();
  for (const row of rows) {
    const isCashIn = isCashInAction(row.action);
    const isDividend = row.action === FundSubtype.dividend_cash;
    const key = `${row.accountId}:${row.wealthProductId ?? row.productName ?? `wealth:${row.id}`}`;
    const bucket = unitBuckets.get(key) ?? { principal: 0, units: 0, cycleHasUnits: false };
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const units = row.units == null ? null : Math.abs(toNumber(row.units));

    if (!isDividend) {
      if (isCashIn) {
        bucket.principal -= grossAmount;
        if (units != null) {
          bucket.cycleHasUnits = true;
          bucket.units -= units;
        }
        if (isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)) {
          resetWealthHoldingBucket(bucket);
        }
      } else {
        bucket.principal += grossAmount;
        if (units != null) {
          bucket.cycleHasUnits = true;
          bucket.units += units;
        }
      }
    }

    unitBuckets.set(key, bucket);
    remainingUnitsByTransactionId.set(row.id, bucket.cycleHasUnits ? Number(Math.max(0, bucket.units).toFixed(6)) : null);
  }

  const projectedRows = rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const isDividend = row.action === FundSubtype.dividend_cash;
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
    const profit = row.realizedProfit == null
      ? toNumber(row.interest) - toNumber(row.fee)
      : toNumber(row.realizedProfit);
    return {
      id: row.cashEntryId ?? row.id,
      cashEntryId: row.cashEntryId,
      businessTransactionId: row.id,
      date: row.tradeDate,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      accountId: isCashIn ? row.accountId : row.cashAccountId,
      accountName: isCashIn ? row.Account.name : row.CashAccount?.name ?? "",
      toAccountId: isCashIn ? row.cashAccountId : row.accountId,
      toAccountName: isCashIn ? row.CashAccount?.name ?? "" : row.Account.name,
      amount: isCashIn ? arrivalAmount ?? grossAmount : -grossAmount,
      wealthPrincipalAmount: grossAmount,
      fundCode: null,
      fundName: row.WealthProduct?.name ?? row.productName ?? "",
      fundProductType: "wealth",
      fundSubtype: row.action,
      fundUnits: row.units == null ? null : toNumber(row.units),
      wealthRemainingUnits: remainingUnitsByTransactionId.get(row.id) ?? null,
      fundNav: row.nav == null ? null : toNumber(row.nav),
      fundArrivalAmount: row.arrivalAmount,
      depositAnnualRate: row.annualRate ?? row.WealthProduct?.annualRate ?? null,
      depositInterest: row.interest,
      realizedProfit: isCashIn ? profit : null,
      wealthProductId: row.wealthProductId,
      WealthProduct: row.WealthProduct,
      source: row.source,
      note: row.note,
      ...linkSummary(row.EntryBusinessLink),
    };
  });

  return projectedRows.sort((a, b) => {
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
      cashEntryId: row.cashEntryId,
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
