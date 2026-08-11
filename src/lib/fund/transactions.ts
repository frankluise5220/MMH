import { FundCashFlowKind, FundProductType, FundSubtype, Prisma, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { entryBusinessTypeLabel, upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";

type Tx = Prisma.TransactionClient;

export type FundCashFlowInput = {
  kind: FundCashFlowKind;
  date: Date;
  accountId: string;
  accountName?: string | null;
  amount: number;
  currency?: string | null;
  source?: string | null;
  note?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  regularInvestPlanId?: string | null;
};

export type CreateFundTransactionWithCashFlowsParams = {
  householdId: string;
  fundAccountId: string;
  cashAccountId?: string | null;
  fundCode: string;
  fundName?: string | null;
  fundProductType?: FundProductType | string | null;
  fundSubtype: FundSubtype | string;
  source?: string | null;
  applyDate: Date;
  confirmDate?: Date | null;
  arrivalDate?: Date | null;
  grossAmount: number;
  refundAmount?: number | null;
  arrivalAmount?: number | null;
  fee?: number | Prisma.Decimal | null;
  nav?: number | Prisma.Decimal | null;
  units?: number | Prisma.Decimal | null;
  realizedProfit?: number | Prisma.Decimal | null;
  regularInvestPlanId?: string | null;
  note?: string | null;
  cashFlows?: FundCashFlowInput[];
};

function normalizeFundProductType(value: FundProductType | string | null | undefined): FundProductType {
  return value === FundProductType.money || value === "money" || value === "money_fund" ? FundProductType.money : FundProductType.fund;
}

function normalizeFundSubtype(value: FundSubtype | string): FundSubtype {
  return Object.values(FundSubtype).includes(value as FundSubtype) ? (value as FundSubtype) : FundSubtype.buy;
}

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

export async function createFundTransactionWithCashFlows(
  client: Tx | typeof prisma,
  params: CreateFundTransactionWithCashFlowsParams,
) {
  const fundCode = params.fundCode.trim();
  if (!params.householdId || !params.fundAccountId || !fundCode) {
    throw new Error("缺少基金交易必要字段");
  }

  const cashFlows = (params.cashFlows ?? []).filter((flow) => (
    flow.accountId && Number.isFinite(flow.amount) && flow.amount !== 0
  ));
  const createdCashEntries: Array<{ entry: Awaited<ReturnType<Tx["txRecord"]["create"]>>; flow: FundCashFlowInput }> = [];

  for (const flow of cashFlows) {
    const entry = await client.txRecord.create({
      data: {
        householdId: params.householdId,
        type: TransactionType.investment,
        date: flow.date,
        accountId: flow.accountId,
        accountName: flow.accountName ?? "",
        toAccountId: null,
        toAccountName: null,
        amount: flow.amount,
        currency: flow.currency ?? "CNY",
        source: flow.source ?? params.source ?? "manual",
        categoryId: flow.categoryId ?? null,
        categoryName: flow.categoryName ?? null,
        regularInvestPlanId: flow.regularInvestPlanId ?? params.regularInvestPlanId ?? null,
        note: flow.note ?? params.note ?? undefined,
      },
    });
    createdCashEntries.push({ entry, flow });
  }

  const primaryCashEntry = createdCashEntries[0]?.entry ?? null;
  const refundAmount = params.refundAmount ?? cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
  const fundTransaction = await client.fundTransaction.create({
    data: {
      householdId: params.householdId,
      fundAccountId: params.fundAccountId,
      cashAccountId: params.cashAccountId ?? primaryCashEntry?.accountId ?? null,
      cashEntryId: primaryCashEntry?.id ?? null,
      fundCode,
      fundName: params.fundName ?? null,
      fundProductType: normalizeFundProductType(params.fundProductType),
      fundSubtype: normalizeFundSubtype(params.fundSubtype),
      source: params.source ?? "manual",
      applyDate: params.applyDate,
      confirmDate: params.confirmDate ?? null,
      arrivalDate: params.arrivalDate ?? null,
      grossAmount: Math.abs(toNumber(params.grossAmount)),
      refundAmount: Math.max(0, Math.abs(toNumber(refundAmount ?? 0))),
      arrivalAmount: params.arrivalAmount == null ? null : Math.abs(toNumber(params.arrivalAmount)),
      fee: params.fee ?? null,
      nav: params.nav ?? null,
      units: params.units ?? null,
      realizedProfit: params.realizedProfit ?? null,
      regularInvestPlanId: params.regularInvestPlanId ?? null,
      note: params.note ?? null,
    },
  });

  for (const { entry, flow } of createdCashEntries) {
    await client.fundTransactionCashFlow.create({
      data: {
        id: `${flow.kind === FundCashFlowKind.refund_in ? "cfr" : "cff"}_${entry.id}`,
        fundTransactionId: fundTransaction.id,
        txRecordId: entry.id,
        kind: flow.kind,
        amount: Math.abs(toNumber(flow.amount)),
        flowDate: flow.date,
        accountId: flow.accountId,
      },
    });
    await upsertEntryBusinessCashFlowLink(client, {
      householdId: params.householdId,
      cashEntryId: entry.id,
      fundTransactionId: fundTransaction.id,
      businessType: "fund",
      cashFlowDirection: flow.amount < 0 ? "outflow" : flow.amount > 0 ? "inflow" : "none",
      source: flow.source ?? params.source,
      note: "Linked cash flow to fund transaction",
      metadata: {
        splitRecord: true,
        independentBusinessTransaction: true,
      },
    });
  }

  if (createdCashEntries.length === 0) {
    await upsertEntryBusinessCashFlowLink(client, {
      householdId: params.householdId,
      cashEntryId: null,
      fundTransactionId: fundTransaction.id,
      businessType: "fund",
      cashFlowDirection: "none",
      source: params.source,
      note: "Linked fund transaction without cash flow",
      metadata: {
        splitRecord: true,
        independentBusinessTransaction: true,
      },
    });
  }

  return {
    fundTransaction,
    cashEntries: createdCashEntries.map(({ entry }) => entry),
    cashEntry: primaryCashEntry,
  };
}

export async function findFundTransactionForEntryId(
  client: Tx | typeof prisma,
  params: { id: string; householdId?: string | null; syncLegacy?: boolean },
) {
  const id = params.id?.trim();
  if (!id) return null;
  const householdWhere = params.householdId ? { householdId: params.householdId } : {};

  const findCurrent = async () => {
    const direct = await client.fundTransaction.findFirst({
      where: { id, ...householdWhere },
    });
    if (direct) return direct;

    const byCashEntry = await client.fundTransaction.findFirst({
      where: { cashEntryId: id, ...householdWhere },
    });
    if (byCashEntry) return byCashEntry;

    const link = await client.entryBusinessLink.findFirst({
      where: {
        deletedAt: null,
        ...householdWhere,
        OR: [
          { cashEntryId: id },
          { businessEntryId: id },
          { fundTransactionId: id },
        ],
      },
      select: { fundTransactionId: true },
    });
    if (!link?.fundTransactionId) return null;
    return client.fundTransaction.findFirst({
      where: { id: link.fundTransactionId, ...householdWhere },
    });
  };

  const current = await findCurrent();
  if (current || params.syncLegacy === false) return current;

  const legacy = await client.txRecord.findFirst({
    where: {
      id,
      fundCode: { not: null },
      ...householdWhere,
    },
    select: { id: true },
  });
  if (!legacy) return null;

  await syncFundTransactionsFromTxRecords([id], client);
  return findCurrent();
}

export async function upsertFundTransactionRefundCashFlow(
  client: Tx | typeof prisma,
  params: {
    householdId: string;
    fundTransactionId: string;
    linkedRefundEntryId?: string | null;
    refundDate: Date;
    refundAmount: number;
    cashAccountId: string;
    cashAccountName?: string | null;
    currency?: string | null;
    source?: string | null;
    note?: string | null;
  },
) {
  const refundAmount = Math.max(0, Math.abs(toNumber(params.refundAmount)));
  if (!params.householdId || !params.fundTransactionId || !params.cashAccountId || refundAmount <= 0) return null;

  const directCashEntry = params.linkedRefundEntryId
    ? await client.txRecord.findFirst({
        where: { id: params.linkedRefundEntryId, householdId: params.householdId },
      })
    : null;
  const existingFlow = directCashEntry
    ? null
    : await client.fundTransactionCashFlow.findFirst({
        where: { fundTransactionId: params.fundTransactionId, kind: FundCashFlowKind.refund_in },
        orderBy: [{ createdAt: "asc" }],
      });
  const existingCashEntry = directCashEntry ?? (existingFlow?.txRecordId
    ? await client.txRecord.findFirst({
        where: { id: existingFlow.txRecordId, householdId: params.householdId },
      })
    : null);

  const cashEntryData = {
    date: params.refundDate,
    type: TransactionType.investment,
    accountId: params.cashAccountId,
    accountName: params.cashAccountName ?? "",
    toAccountId: null,
    toAccountName: null,
    amount: refundAmount,
    currency: params.currency ?? "CNY",
    source: params.source ?? "regular_invest_refund",
    note: params.note ?? undefined,
    fundCode: null,
    fundName: null,
    fundProductType: null,
    fundSubtype: null,
    fundUnits: null,
    fundNav: null,
    fundFee: null,
    fundConfirmDate: null,
    fundArrivalDate: null,
    fundArrivalAmount: null,
    fundSourceEntryId: null,
    deletedAt: null,
  };

  const cashEntry = existingCashEntry
    ? await client.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
    : await client.txRecord.create({
        data: {
          ...cashEntryData,
          householdId: params.householdId,
        },
      });

  await client.fundTransactionCashFlow.deleteMany({
    where: {
      fundTransactionId: params.fundTransactionId,
      kind: FundCashFlowKind.refund_in,
      txRecordId: { not: cashEntry.id },
    },
  });
  await client.fundTransactionCashFlow.upsert({
    where: { id: `cfr_${cashEntry.id}` },
    create: {
      id: `cfr_${cashEntry.id}`,
      fundTransactionId: params.fundTransactionId,
      txRecordId: cashEntry.id,
      kind: FundCashFlowKind.refund_in,
      amount: refundAmount,
      flowDate: params.refundDate,
      accountId: params.cashAccountId,
    },
    update: {
      fundTransactionId: params.fundTransactionId,
      amount: refundAmount,
      flowDate: params.refundDate,
      accountId: params.cashAccountId,
    },
  });
  await client.fundTransaction.update({
    where: { id: params.fundTransactionId },
    data: { refundAmount, arrivalDate: params.refundDate },
  });
  await upsertEntryBusinessCashFlowLink(client, {
    householdId: params.householdId,
    cashEntryId: cashEntry.id,
    fundTransactionId: params.fundTransactionId,
    businessType: "fund",
    cashFlowDirection: "inflow",
    source: params.source ?? "regular_invest_refund",
    note: "Linked refund cash flow to fund transaction",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
    },
  });

  return cashEntry;
}

export function fundCashFlowDirectionForKind(kind: FundCashFlowKind): "outflow" | "inflow" | "internal" | "none" {
  if (kind === FundCashFlowKind.buy_out || kind === FundCashFlowKind.switch_in) return "outflow";
  if (kind === FundCashFlowKind.refund_in || kind === FundCashFlowKind.redeem_in || kind === FundCashFlowKind.dividend_in || kind === FundCashFlowKind.switch_out) return "inflow";
  if (kind === FundCashFlowKind.dividend_reinvest_internal) return "internal";
  return "none";
}

export async function ensureFundTransactionCashFlowLinks(
  client: Tx | typeof prisma,
  fundTransactionIds: string[],
) {
  const ids = Array.from(new Set(fundTransactionIds.filter(Boolean)));
  if (!ids.length) return 0;

  const rows = await client.fundTransaction.findMany({
    where: { id: { in: ids }, deletedAt: null },
    include: { cashFlows: true },
  });

  let count = 0;
  for (const row of rows) {
    if (row.cashFlows.length === 0) {
      await upsertEntryBusinessCashFlowLink(client, {
        householdId: row.householdId,
        cashEntryId: null,
        fundTransactionId: row.id,
        businessType: "fund",
        cashFlowDirection: "none",
        source: row.source,
        note: "Linked fund transaction without cash flow",
        metadata: {
          splitRecord: true,
          independentBusinessTransaction: true,
        },
      });
      count += 1;
      continue;
    }

    for (const flow of row.cashFlows) {
      await upsertEntryBusinessCashFlowLink(client, {
        householdId: row.householdId,
        cashEntryId: flow.txRecordId,
        fundTransactionId: row.id,
        businessType: "fund",
        cashFlowDirection: fundCashFlowDirectionForKind(flow.kind),
        source: row.source,
        note: "Linked cash flow to fund transaction",
        metadata: {
          splitRecord: true,
          independentBusinessTransaction: true,
        },
      });
      count += 1;
    }
  }
  return count;
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
    const projectedCashAccountId = cashAccountIdOf(main);
    const legacyCombinedCashRow = primaryCashRow?.id === main.id;
    const primaryCashFlowAccountId = legacyCombinedCashRow
      ? projectedCashAccountId
      : primaryCashRow?.accountId ?? projectedCashAccountId;
    const cashAccountId = primaryCashFlowAccountId;

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
      await createManySkipDuplicatesCompat(
        client.fundTransactionCashFlow,
        cashRows.map((row) => ({
          id: `${isRefundRow(row) ? "cfr" : "cff"}_${row.id}`,
          fundTransactionId: ft.id,
          txRecordId: row.id,
          kind: row.id === primaryCashRow?.id ? cashFlowKindOf(main) : cashFlowKindOf(row),
          amount: Math.abs(toNumber(row.fundArrivalAmount ?? row.amount)),
          flowDate: isCashReceiptSubtype(row.fundSubtype ?? main.fundSubtype) || isRefundRow(row)
            ? row.fundArrivalDate ?? row.date
            : row.date,
          accountId: row.id === primaryCashRow?.id
            ? primaryCashFlowAccountId
            : isCashReceiptSubtype(row.fundSubtype) || isRefundRow(row)
            ? row.toAccountId
            : row.accountId,
        })),
      );
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
