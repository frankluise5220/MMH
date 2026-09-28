import { FundSubtype, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { isWealthHoldingCleared, resetWealthHoldingBucket } from "@/lib/invest-balance";
import { entryBusinessTypeLabel } from "@/lib/server/entry-business-link";
import { optionalPrismaFindMany } from "@/lib/server/optional-prisma-delegate";
import { calculateWealthCashDividendProfit, calculateWealthPositionsFromEntries, inferWealthUnitNav } from "@/lib/wealth-position";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";

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

function linkSummary(rows: Array<{
  businessType: string;
  cashEntryId?: string | null;
  CashEntry?: { id: string; deletedAt?: Date | null } | null;
}>) {
  const validRows = rows.filter((row) => {
    if (!("cashEntryId" in row)) return true;
    if (!row.cashEntryId) return false;
    return !!row.CashEntry && row.CashEntry.deletedAt == null;
  });
  return {
    businessLinkCount: validRows.length,
    businessLinkLabels: Array.from(new Set(validRows.map((row) => entryBusinessTypeLabel(row.businessType)))),
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
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
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

  const rows = await prisma.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      OR: [
        { accountId: { in: accountIds } },
        { toAccountId: { in: accountIds } },
      ],
    },
    include: {
      DepositProduct: { select: { id: true, name: true, shortName: true } },
      account: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      toAccount: {
        include: { Institution: { select: { name: true, shortName: true } } },
      },
      EntryBusinessLinkBusiness: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => {
    const subtype = row.fundSubtype ?? FundSubtype.buy;
    const isCashIn = isCashInAction(subtype);
    const principal = Math.abs(toNumber(row.amount));
    const arrivalAmount = row.fundArrivalAmount == null ? null : Math.abs(toNumber(row.fundArrivalAmount));
    const principalAmount =
      isCashIn && subtype !== FundSubtype.dividend_cash
        ? Math.max(0, (arrivalAmount ?? principal) - toNumber(row.depositInterest) + toNumber(row.fundFee))
        : principal;
    const businessAccount = isCashIn ? row.account : row.toAccount ?? row.account;
    const cashAccount = isCashIn ? row.toAccount : row.account;

    return {
      id: row.id,
      cashEntryId: row.id,
      businessTransactionId: row.id,
      date: ymd(row.date),
      createdAt: iso(row.createdAt),
      deletedAt: iso(row.deletedAt),
      type: "investment",
      accountId: isCashIn ? businessAccount.id : cashAccount?.id ?? null,
      accountName: isCashIn ? businessAccount.name : cashAccount?.name ?? "",
      toAccountId: isCashIn ? cashAccount?.id ?? null : businessAccount.id,
      toAccountName: isCashIn ? cashAccount?.name ?? "" : businessAccount.name,
      amount: isCashIn ? arrivalAmount ?? principalAmount : -principalAmount,
      fundCode: null,
      fundName: row.DepositProduct?.name ?? row.fundName ?? row.fundCode ?? "",
      depositProductId: row.depositProductId ?? row.DepositProduct?.id ?? null,
      fundProductType: "deposit",
      fundSubtype: subtype,
      fundNav: row.depositAnnualRate == null ? null : toNumber(row.depositAnnualRate),
      fundConfirmDate: ymd(row.fundConfirmDate),
      fundArrivalDate: ymd(row.fundArrivalDate),
      fundArrivalAmount: row.fundArrivalAmount,
      depositAnnualRate: row.depositAnnualRate,
      depositInterest: row.depositInterest,
      depositSourceEntryId: row.depositSourceEntryId,
      depositMaturityAction: row.depositMaturityAction,
      depositInterestPayoutFrequency: row.depositInterestPayoutFrequency,
      depositInterestCalcBasis: row.depositInterestCalcBasis,
      source: row.source,
      note: row.note,
      cashAccountLabel: accountLabel(cashAccount),
      ...linkSummary(row.EntryBusinessLinkBusiness),
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
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });
  const profitByTransactionId = new Map<string, number>();
  const rowsByAccountId = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByAccountId.get(row.accountId) ?? [];
    list.push(row);
    rowsByAccountId.set(row.accountId, list);
  }
  for (const accountRows of rowsByAccountId.values()) {
    const fundUnitsDecimals = normalizeFundUnitsDecimals(accountRows[0]?.Account?.fundUnitsDecimals, 2);
    const calc = calculateWealthPositionsFromEntries(
      accountRows.map((row) => ({
        id: row.id,
        cashEntryId: row.cashEntryId,
        productKey: `${row.accountId}:${row.wealthProductId ?? row.productName ?? `wealth:${row.id}`}`,
        action: row.action,
        tradeDate: row.tradeDate,
        createdAt: row.createdAt,
        grossAmount: row.grossAmount,
        arrivalAmount: row.arrivalAmount,
        units: row.units,
        nav: row.nav,
        interest: row.interest,
        fee: row.fee,
      })),
      fundUnitsDecimals,
    );
    for (const [entryId, profit] of calc.realizedProfitByTransactionId) {
      profitByTransactionId.set(entryId, profit);
    }
  }
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


  const cashEntryIds = Array.from(
    new Set(rows.map((row) => row.cashEntryId).filter((id): id is string => Boolean(id))),
  );
  const linkedCashEntries = cashEntryIds.length === 0
    ? []
    : await prisma.txRecord.findMany({
        where: { id: { in: cashEntryIds }, deletedAt: null },
        select: { id: true, date: true },
      });
  const cashDateById = new Map(linkedCashEntries.map((entry) => [entry.id, entry.date]));

  const projectedRows = rows.map((row) => {
    const isCashIn = isCashInAction(row.action);
    const isDividend = row.action === FundSubtype.dividend_cash;
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
    const displayNav = inferWealthUnitNav({
      nav: row.nav,
      grossAmount: grossAmount,
      arrivalAmount: arrivalAmount,
      units: row.units,
    });
    const profit = profitByTransactionId.get(row.id)
      ?? (isDividend
        ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
        : row.realizedProfit == null
          ? (toNumber(row.interest) - toNumber(row.fee))
          : toNumber(row.realizedProfit));
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
      fundNav: displayNav == null ? null : displayNav,
      fundArrivalAmount: row.arrivalAmount,
      fundArrivalDate: ymd(
        row.arrivalDate ?? (row.cashEntryId ? cashDateById.get(row.cashEntryId) : null),
      ),
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

/**
 * 债券明细（bond_transactions）。
 *
 * 债券不复用理财/基金链路：债券没有份额与净值，grossAmount 直接是本金现金流，
 * interest 是本期票息，所以这里不产出 fundUnits / fundNav / wealthRemainingUnits，
 * 也不参与份额桶清算。仅复用「本金桶 → 已实现收益」这一条共享计算（units 恒为 null），
 * 与 recalcWealthPositions / invest-balance 保持同一口径。
 */
export async function loadBondTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await prisma.bondTransaction.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
    },
    include: {
      Account: true,
      CashAccount: true,
      BondProduct: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
  });

  const profitByTransactionId = new Map<string, number>();
  const rowsByAccountId = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByAccountId.get(row.accountId) ?? [];
    list.push(row);
    rowsByAccountId.set(row.accountId, list);
  }
  for (const accountRows of rowsByAccountId.values()) {
    const fundUnitsDecimals = normalizeFundUnitsDecimals(accountRows[0]?.Account?.fundUnitsDecimals, 2);
    const calc = calculateWealthPositionsFromEntries(
      accountRows.map((row) => ({
        id: row.id,
        cashEntryId: row.cashEntryId,
        productKey: `${row.accountId}:${row.bondProductId ?? row.productName ?? `bond:${row.id}`}`,
        action: row.action,
        tradeDate: row.tradeDate,
        createdAt: row.createdAt,
        grossAmount: row.grossAmount,
        arrivalAmount: row.arrivalAmount,
        units: null,
        nav: null,
        interest: row.interest,
        fee: row.fee,
      })),
      fundUnitsDecimals,
    );
    for (const [entryId, profit] of calc.realizedProfitByTransactionId) {
      profitByTransactionId.set(entryId, profit);
    }
  }

  const cashEntryIds = Array.from(
    new Set(rows.map((row) => row.cashEntryId).filter((id): id is string => Boolean(id))),
  );
  const linkedCashEntries = cashEntryIds.length === 0
    ? []
    : await prisma.txRecord.findMany({
        where: { id: { in: cashEntryIds }, deletedAt: null },
        select: { id: true, date: true },
      });
  const cashDateById = new Map(linkedCashEntries.map((entry) => [entry.id, entry.date]));

  return rows
    .map((row) => {
      const isCashIn = isCashInAction(row.action);
      const isDividend = row.action === FundSubtype.dividend_cash;
      const grossAmount = Math.abs(toNumber(row.grossAmount));
      const arrivalAmount = row.arrivalAmount == null ? null : Math.abs(toNumber(row.arrivalAmount));
      const profit = profitByTransactionId.get(row.id)
        ?? (isDividend
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : row.realizedProfit == null
            ? (toNumber(row.interest) - toNumber(row.fee))
            : toNumber(row.realizedProfit));
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
        bondPrincipalAmount: grossAmount,
        bondName: row.BondProduct?.name ?? row.productName ?? "",
        bondProductId: row.bondProductId,
        // 存单归属：子行（付息/赎回/核销）指回所属存单；买入行本身即存单（为 null）。
        // 编辑子行时要据此预选存单下拉。
        sourceBondTransactionId: row.sourceBondTransactionId,
        // 债单条款投影：录入弹窗的持仓下拉需要「名称/利率/期限」，债券这里给自己的
        // 债单对象（不借用 WealthProduct 字段名去承载债券语义）。
        BondProduct: row.BondProduct
          ? {
              name: row.BondProduct.name,
              shortName: row.BondProduct.shortName,
              annualRate: row.BondProduct.annualRate,
              termDays: row.BondProduct.termDays,
            }
          : null,
        fundProductType: "bond",
        fundSubtype: row.action,
        bondInterest: row.interest,
        bondArrivalAmount: row.arrivalAmount,
        bondArrivalDate: ymd(
          row.arrivalDate ?? (row.cashEntryId ? cashDateById.get(row.cashEntryId) : null),
        ),
        bondAnnualRate: row.annualRate ?? row.BondProduct?.annualRate ?? null,
        bondFee: row.fee,
        realizedProfit: isCashIn ? profit : null,
        source: row.source,
        note: row.note,
        ...linkSummary(row.EntryBusinessLink),
      };
    })
    .sort((a, b) => {
      const dateDiff = new Date(b.date as any).getTime() - new Date(a.date as any).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime();
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
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
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

export async function loadPropertyTransactionEntryLike(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return [];

  const rows = await optionalPrismaFindMany<any>(
    prisma,
    "propertyTransaction",
    {
      where: {
        householdId: params.householdId,
        accountId: { in: accountIds },
        deletedAt: null,
      },
      include: {
        Account: { select: { name: true, currency: true } },
        CashAccount: { select: { name: true, currency: true } },
        PropertyAsset: { select: { name: true } },
        EntryBusinessLink: {
          where: { deletedAt: null },
          select: {
            businessType: true,
            cashEntryId: true,
            CashEntry: { select: { id: true, deletedAt: true } },
          },
        },
      },
      orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
    },
    { tableNames: ["property_transactions"] },
  );

  // Older property rows may have lost their direct cashEntryId while the
  // corresponding EntryBusinessLink still retains the cash-side reference.
  // Resolve both shapes so the detail table keeps the standard TxRecord data
  // (category, posted date, attachments, tags, and institution) available.
  const linkedCashEntryIdByPropertyId = new Map<string, string>();
  for (const row of rows) {
    if (row.cashEntryId) continue;
    const linkedCashEntryId = row.EntryBusinessLink.find((link: { cashEntryId?: string | null; CashEntry?: { id: string; deletedAt?: Date | null } | null }) =>
      Boolean(link.cashEntryId && link.CashEntry && link.CashEntry.deletedAt == null),
    )?.cashEntryId;
    if (linkedCashEntryId) linkedCashEntryIdByPropertyId.set(row.id, linkedCashEntryId);
  }
  const cashEntryIds = Array.from(new Set(rows.map((row) => row.cashEntryId ?? linkedCashEntryIdByPropertyId.get(row.id)).filter(Boolean)));
  const cashEntries = cashEntryIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          householdId: params.householdId,
          id: { in: cashEntryIds },
          deletedAt: null,
        },
        select: {
          id: true,
          type: true,
          source: true,
          amount: true,
          accountId: true,
          toAccountId: true,
          debtPrincipalAmount: true,
          debtInterestAmount: true,
          debtFeeAmount: true,
          categoryId: true,
          categoryName: true,
          postedAt: true,
          currency: true,
          counterpartyInstitutionId: true,
          counterpartyInstitutionName: true,
          Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
          EntryTag: {
            select: {
              tagId: true,
              Tag: {
                select: {
                  name: true,
                  color: true,
                },
              },
            },
          },
        },
      })
    : [];
  const cashEntryById = new Map(cashEntries.map((row) => [row.id, row]));

  return rows.map((row) => {
    const candidateCashEntryId = row.cashEntryId ?? linkedCashEntryIdByPropertyId.get(row.id) ?? null;
    const cashEntry = candidateCashEntryId ? cashEntryById.get(candidateCashEntryId) ?? null : null;
    const linkedCashEntryId = cashEntry?.id ?? null;
    const isCashIn = row.action === "sale";
    const amount = Math.abs(toNumber(row.amount));
    const fee = row.fee == null ? null : toNumber(row.fee);
    const tax = row.tax == null ? null : toNumber(row.tax);
    const type = cashEntry?.type === "income" || cashEntry?.type === "expense"
      ? cashEntry.type
      : isCashIn
        ? "income"
        : "expense";
    return {
      id: linkedCashEntryId ?? row.id,
      cashEntryId: linkedCashEntryId,
      businessTransactionId: row.id,
      date: ymd(row.tradeDate),
      postedAt: cashEntry?.postedAt ? ymd(cashEntry.postedAt) : ymd(row.tradeDate),
      createdAt: iso(row.createdAt),
      deletedAt: iso(row.deletedAt),
      accountId: row.cashAccountId ?? row.accountId,
      accountName: row.CashAccount?.name ?? row.Account.name,
      toAccountId: row.accountId,
      toAccountName: row.Account.name,
      currency: cashEntry?.currency ?? row.CashAccount?.currency ?? row.Account.currency ?? "CNY",
      amount: isCashIn ? amount : -amount,
      type,
      categoryId: cashEntry?.categoryId ?? null,
      categoryName: cashEntry?.categoryName ?? null,
      counterpartyInstitutionId: cashEntry?.counterpartyInstitutionId ?? null,
      counterpartyInstitutionName: cashEntry?.counterpartyInstitutionName ?? null,
      entryTags: cashEntry?.EntryTag ?? [],
      attachments: (cashEntry?.Attachment ?? []).map((attachment: { id: string; name: string | null; mimeType: string | null; url: string | null }) => ({
        id: attachment.id,
        name: attachment.name ?? "",
        mimeType: attachment.mimeType,
        url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
      })),
      fundCode: row.propertyAssetId,
      fundName: row.PropertyAsset?.name ?? "",
      fundProductType: "property",
      fundSubtype: row.action,
      // Keep the underlying TxRecord's own shape so the client can tell a
      // loan/debt-funded purchase (transfer + debt_* source) apart from a
      // plain expense and route the edit action to the debt/loan dialog.
      cashEntryType: cashEntry?.type ?? null,
      cashEntrySource: cashEntry?.source ?? null,
      cashEntryAccountId: cashEntry?.accountId ?? null,
      cashEntryToAccountId: cashEntry?.toAccountId ?? null,
      cashEntryAmount: cashEntry?.amount == null ? null : toNumber(cashEntry.amount),
      debtPrincipalAmount: cashEntry?.debtPrincipalAmount == null ? null : toNumber(cashEntry.debtPrincipalAmount),
      debtInterestAmount: cashEntry?.debtInterestAmount == null ? null : toNumber(cashEntry.debtInterestAmount),
      debtFeeAmount: cashEntry?.debtFeeAmount == null ? null : toNumber(cashEntry.debtFeeAmount),
      fundFee: fee,
      realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
      propertyAssetId: row.propertyAssetId,
      propertyAction: row.action,
      propertySettlementDate: ymd(row.settlementDate),
      propertyTax: tax,
      source: row.source,
      note: row.note,
      ...linkSummary(row.EntryBusinessLink),
    };
  });
}
