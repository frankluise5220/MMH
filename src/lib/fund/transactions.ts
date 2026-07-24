import { FundCashFlowKind, FundSubtype, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { entryBusinessTypeLabel, upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";

type Tx = Prisma.TransactionClient;

function isRefundRow(row: { fundSubtype?: string | null; source?: string | null }) {
  return row.fundSubtype === FundSubtype.buy_failed && row.source === "regular_invest_refund";
}

function isCashReceiptSubtype(subtype: string | null | undefined) {
  return subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out || subtype === FundSubtype.dividend_cash;
}

function fundAccountIdOf(row: { fundSubtype?: string | null; accountId: string; toAccountId?: string | null }) {
  return isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
    ? row.accountId
    : row.toAccountId ?? row.accountId;
}

function cashAccountIdOf(row: { fundSubtype?: string | null; accountId: string; toAccountId?: string | null }) {
  return isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
    ? row.toAccountId ?? null
    : row.accountId;
}

function cashFlowKindOf(row: { fundSubtype?: string | null; source?: string | null }) {
  if (isRefundRow(row)) return FundCashFlowKind.refund_in;
  if (row.fundSubtype === FundSubtype.buy || row.fundSubtype === FundSubtype.buy_failed) return FundCashFlowKind.buy_out;
  if (row.fundSubtype === FundSubtype.redeem || row.fundSubtype === FundSubtype.switch_out) return FundCashFlowKind.redeem_in;
  if (row.fundSubtype === FundSubtype.dividend_cash) return FundCashFlowKind.dividend_in;
  if (row.fundSubtype === FundSubtype.dividend_reinvest) return FundCashFlowKind.dividend_reinvest_internal;
  if (row.fundSubtype === FundSubtype.switch_in) return FundCashFlowKind.switch_in;
  return FundCashFlowKind.other;
}

function signedFundAmount(ft: {
  fundSubtype: string;
  grossAmount: unknown;
  arrivalAmount?: unknown;
}) {
  const gross = Math.abs(toNumber(ft.grossAmount));
  if (ft.fundSubtype === FundSubtype.buy || ft.fundSubtype === FundSubtype.buy_failed || ft.fundSubtype === FundSubtype.switch_in) return -gross;
  return Math.abs(toNumber(ft.arrivalAmount ?? ft.grossAmount));
}

export async function syncFundTransactionsFromTxRecords(entryIds: string[], client: Tx | typeof prisma = prisma) {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (!ids.length) return;

  const seedRows = await client.txRecord.findMany({
    where: { id: { in: ids }, fundCode: { not: null } },
  });
  const mainIds = new Set<string>();
  for (const row of seedRows) {
    if (isRefundRow(row)) {
      if (row.fundSourceEntryId) mainIds.add(row.fundSourceEntryId);
    } else {
      mainIds.add(row.id);
    }
  }
  if (!mainIds.size) return;

  const mainRows = await client.txRecord.findMany({
    where: { id: { in: Array.from(mainIds) }, fundCode: { not: null } },
  });

  for (const main of mainRows) {
    if (!main.householdId || !main.fundCode || isRefundRow(main)) continue;
    const fundAccountId = fundAccountIdOf(main);
    if (!fundAccountId) continue;
    const fundSubtype = main.fundSubtype ?? (toNumber(main.amount) < 0 ? FundSubtype.buy : FundSubtype.redeem);
    const linkedCashRows = await client.$queryRaw<any[]>(Prisma.sql`
      SELECT cash.*
      FROM "entry_business_links" link
      JOIN "transactions" cash ON cash."id" = link."cashEntryId"
      WHERE link."businessEntryId" = ${main.id}
        AND link."cashEntryId" IS NOT NULL
        AND link."deletedAt" IS NULL
        AND cash."deletedAt" IS NULL
      ORDER BY cash."date" ASC, cash."createdAt" ASC
    `);
    const primaryCashRow = linkedCashRows[0] ?? null;
    const cashAccountId = primaryCashRow?.accountId ?? cashAccountIdOf(main);

    const ft = await client.fundTransaction.upsert({
      where: { cashEntryId: main.id },
      create: {
        id: main.id,
        householdId: main.householdId,
        fundAccountId,
        cashAccountId,
        cashEntryId: main.id,
        fundCode: main.fundCode,
        fundName: main.fundName,
        fundProductType: main.fundProductType ?? "fund",
        fundSubtype,
        source: main.source,
        applyDate: main.date,
        confirmDate: main.fundConfirmDate,
        arrivalDate: main.fundArrivalDate,
        grossAmount: Math.abs(toNumber(main.amount)),
        arrivalAmount: main.fundArrivalAmount,
        fee: main.fundFee,
        nav: main.fundNav,
        units: main.fundUnits,
        realizedProfit: main.realizedProfit,
        regularInvestPlanId: main.regularInvestPlanId,
        note: main.note,
        deletedAt: main.deletedAt,
      },
      update: {
        householdId: main.householdId,
        fundAccountId,
        cashAccountId,
        fundCode: main.fundCode,
        fundName: main.fundName,
        fundProductType: main.fundProductType ?? "fund",
        fundSubtype,
        source: main.source,
        applyDate: main.date,
        confirmDate: main.fundConfirmDate,
        arrivalDate: main.fundArrivalDate,
        grossAmount: Math.abs(toNumber(main.amount)),
        arrivalAmount: main.fundArrivalAmount,
        fee: main.fundFee,
        nav: main.fundNav,
        units: main.fundUnits,
        realizedProfit: main.realizedProfit,
        regularInvestPlanId: main.regularInvestPlanId,
        note: main.note,
        deletedAt: main.deletedAt,
      },
    });

    await upsertEntryBusinessCashFlowLink(client, {
      householdId: main.householdId,
      cashEntryId: primaryCashRow?.id ?? main.id,
      businessEntryId: main.id,
      fundTransactionId: ft.id,
      businessType: "fund",
      cashFlowDirection: toNumber(primaryCashRow?.amount ?? main.amount) < 0 ? "outflow" : "inflow",
      source: main.source,
      note: "Linked cash flow to fund transaction",
      metadata: {
        splitRecord: !!primaryCashRow,
        independentBusinessTransaction: true,
      },
    });

    const fallbackRefundDateFilters = [main.fundArrivalDate, main.fundConfirmDate, main.date]
      .filter((date): date is Date => !!date)
      .flatMap((date) => [{ date }, { fundConfirmDate: date }, { fundArrivalDate: date }]);
    const refunds = await client.txRecord.findMany({
      where: {
        fundSubtype: FundSubtype.buy_failed,
        source: "regular_invest_refund",
        deletedAt: null,
        OR: [
          { fundSourceEntryId: main.id },
          ...(main.fundSubtype === FundSubtype.buy_failed && fallbackRefundDateFilters.length > 0
            ? [{
                fundSourceEntryId: null,
                householdId: main.householdId,
                fundCode: main.fundCode,
                accountId: fundAccountId,
                toAccountId: cashAccountId,
                ...(main.regularInvestPlanId ? { regularInvestPlanId: main.regularInvestPlanId } : {}),
                OR: fallbackRefundDateFilters,
              }]
            : []),
        ],
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });
    const unlinkedRefundIds = refunds
      .filter((row) => !row.fundSourceEntryId)
      .map((row) => row.id);
    if (unlinkedRefundIds.length > 0) {
      await client.txRecord.updateMany({
        where: { id: { in: unlinkedRefundIds }, fundSourceEntryId: null },
        data: { fundSourceEntryId: main.id },
      });
    }
    const cashRows = linkedCashRows.length > 0 ? [...linkedCashRows, ...refunds] : [main, ...refunds];

    await client.fundTransactionCashFlow.deleteMany({ where: { fundTransactionId: ft.id } });
    if (cashRows.length) {
      await client.fundTransactionCashFlow.createMany({
        data: cashRows.map((row) => ({
          id: `${isRefundRow(row) ? "cfr" : "cff"}_${row.id}`,
          fundTransactionId: ft.id,
          txRecordId: row.id,
          kind: row.id === primaryCashRow?.id ? cashFlowKindOf(main) : cashFlowKindOf(row),
          amount: Math.abs(toNumber(row.fundArrivalAmount ?? row.amount)),
          flowDate: isCashReceiptSubtype(row.fundSubtype ?? main.fundSubtype) || isRefundRow(row)
            ? row.fundArrivalDate ?? row.date
            : row.date,
          accountId: row.id === primaryCashRow?.id
            ? row.accountId
            : isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
            ? row.toAccountId
            : row.accountId,
        })),
        skipDuplicates: true,
      });
    }

    const refundAmount = refunds.reduce((sum, row) => sum + Math.abs(toNumber(row.fundArrivalAmount ?? row.amount)), 0);
    const lastRefundDate = refunds.reduce<Date | null>((latest, row) => {
      const date = row.fundArrivalDate ?? row.date;
      return !latest || date > latest ? date : latest;
    }, null);
    await client.fundTransaction.update({
      where: { id: ft.id },
      data: {
        refundAmount,
        arrivalDate: lastRefundDate ?? main.fundArrivalDate,
      },
    });
  }
}

export async function loadFundTransactionEntryLike(params: {
  accountId: string;
  householdId: string;
  fundCode?: string;
  entryScope?: "account" | "fund";
}) {
  const rows = await prisma.fundTransaction.findMany({
    where: {
      householdId: params.householdId,
      fundAccountId: params.accountId,
      deletedAt: null,
      ...(params.entryScope === "account" ? {} : { fundCode: params.fundCode || undefined }),
    },
    include: {
      cashFlows: true,
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: {
          businessType: true,
          cashEntryId: true,
          CashEntry: { select: { id: true, deletedAt: true } },
        },
      },
    },
    orderBy: [{ applyDate: "desc" }, { createdAt: "desc" }],
  });

  const entries: any[] = [];
  for (const row of rows) {
    const mainFlow = row.cashFlows.find((flow) => flow.txRecordId === row.cashEntryId) ?? row.cashFlows[0];
    const validBusinessLinks = row.EntryBusinessLink.filter((link) => (
      !!link.cashEntryId && !!link.CashEntry && link.CashEntry.deletedAt == null
    ));
    const businessLinkLabels = Array.from(new Set(validBusinessLinks.map((link) => entryBusinessTypeLabel(link.businessType))));
    entries.push({
      id: row.cashEntryId ?? row.id,
      fundTransactionId: row.id,
      date: row.applyDate,
      createdAt: row.createdAt,
      amount: signedFundAmount(row),
      accountId: isCashReceiptSubtype(row.fundSubtype) ? row.fundAccountId : row.cashAccountId,
      accountName: null,
      toAccountId: isCashReceiptSubtype(row.fundSubtype) ? row.cashAccountId : row.fundAccountId,
      toAccountName: null,
      fundCode: row.fundCode,
      fundName: row.fundName,
      fundProductType: row.fundProductType,
      fundSubtype: row.fundSubtype,
      source: row.source,
      fundUnits: row.units,
      fundNav: row.nav,
      fundFee: row.fee,
      fundConfirmDate: row.confirmDate,
      fundArrivalDate: row.arrivalDate,
      fundArrivalAmount: row.arrivalAmount,
      refundAmount: row.refundAmount,
      fundSourceEntryId: null,
      regularInvestPlanId: row.regularInvestPlanId,
      realizedProfit: row.realizedProfit,
      note: row.note,
      cashFlowId: mainFlow?.id ?? null,
      businessLinkCount: validBusinessLinks.length,
      businessLinkLabels,
    });

    for (const flow of row.cashFlows) {
      if (flow.kind !== FundCashFlowKind.refund_in) continue;
      entries.push({
        id: flow.txRecordId,
        fundTransactionId: row.id,
        date: row.applyDate,
        createdAt: flow.createdAt,
        amount: Math.abs(toNumber(flow.amount)),
        accountId: row.fundAccountId,
        accountName: null,
        toAccountId: flow.accountId ?? row.cashAccountId,
        toAccountName: null,
        fundCode: row.fundCode,
        fundName: row.fundName,
        fundProductType: row.fundProductType,
        fundSubtype: FundSubtype.buy_failed,
        source: "regular_invest_refund",
        fundUnits: null,
        fundNav: null,
        fundFee: null,
        fundConfirmDate: row.applyDate,
        fundArrivalDate: flow.flowDate,
        fundArrivalAmount: flow.amount,
        fundSourceEntryId: row.cashEntryId ?? row.id,
        regularInvestPlanId: row.regularInvestPlanId,
        realizedProfit: null,
        note: row.note,
        fundCashFlowOnly: true,
        businessLinkCount: validBusinessLinks.length,
        businessLinkLabels,
      });
    }
  }
  return entries;
}
