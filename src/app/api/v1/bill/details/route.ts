/**
 * API: /api/v1/bill/details
 *
 * GET ?accountId=&billMonth=YYYY-MM|all
 *
 * Returns credit-card bill detail rows for lightweight client-side month
 * switching. This endpoint only loads detail rows and cycle metadata; it does
 * not rebuild the bill summary list.
 */
import { NextResponse } from "next/server";
import { AccountKind, TransactionType } from "@prisma/client";
import type { DetailEntry } from "@/components/DetailViewClient";
import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, toNumber, formatDateUtc } from "@/lib/date-utils";
import { cycleForStatementMonthWithBillingDayRules } from "@/lib/credit/billing";
import { loadConsistentCreditCycles } from "@/lib/server/credit-cycles";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { reconcileCreditCardBillingDayRulesFromAccounts } from "@/lib/server/credit-card-billing-day-rules";
import { buildEntryBusinessLinkSummary } from "@/lib/server/entry-business-link";
import {
  CREDIT_BILL_DETAIL_TAKE,
  CREDIT_BILL_DETAIL_TYPES,
  creditBillScopeKey,
  filterCreditBillCycleRows,
  loadCreditBillEntryChannel,
  type CreditBillDetailRow,
} from "@/lib/server/credit-bill-entry-channel";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toDateOnlyLocalOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? formatDateUtc(date) : null;
}

function toYmdOrNull(value: unknown) {
  return toDateOnlyLocalOrNull(value) ?? "";
}

function mdUtcDots(date: Date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}.${day}`;
}

function isSettlementLiabilityAccount(account?: { kind?: AccountKind | null; counterpartyId?: string | null } | null) {
  return account?.kind === AccountKind.settlement || (account?.kind === AccountKind.loan && !!account.counterpartyId);
}

function mapDetailEntry(
  // 行的形状由唯一读取通道决定（`credit-bill-entry-channel`），这里只做映射。
  entry: CreditBillDetailRow,
  billAccountIdSet: Set<string>,
): DetailEntry {
  return {
    id: entry.id,
    date: toYmdOrNull(entry.date),
    postedAt: toDateOnlyLocalOrNull(entry.postedAt),
    createdAt: toIsoOrNull(entry.createdAt),
    entryOrigin: entry.entryOrigin ?? null,
    dayOrder: entry.dayOrder ?? 0,
    amount: toNumber(
      entry.type === TransactionType.transfer && billAccountIdSet.has(entry.toAccountId ?? "")
        ? Math.abs(toNumber(entry.amount))
        : entry.amount,
    ),
    currency: entry.currency ?? "CNY",
    runningBalance: null,
    type: entry.type,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    accountId: entry.accountId,
    accountName: entry.accountName,
    accountKind: entry.account?.kind ?? null,
    accountLiabilityDirection: entry.account?.liabilityDirection ?? null,
    accountIsSettlementAccount: isSettlementLiabilityAccount(entry.account),
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? null,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? null,
    toAccountId: entry.toAccountId,
    toAccountName: entry.toAccountName,
    toAccountKind: entry.toAccount?.kind ?? null,
    toAccountLiabilityDirection: entry.toAccount?.liabilityDirection ?? null,
    toAccountIsSettlementAccount: isSettlementLiabilityAccount(entry.toAccount),
    toNote: entry.toNote,
    note: entry.note,
    fundSubtype: entry.fundSubtype,
    fundCode: entry.fundCode,
    fundName: entry.fundName,
    wealthProductId: entry.wealthProductId ?? null,
    source: entry.source,
    insuranceProductId: entry.insuranceProductId ?? null,
    principalAmount: entry.principalAmount != null ? toNumber(entry.principalAmount) : null,
    interestAmount: entry.interestAmount != null ? toNumber(entry.interestAmount) : null,
    feeAmount: entry.feeAmount != null ? toNumber(entry.feeAmount) : null,
    depositAnnualRate: entry.depositAnnualRate != null ? toNumber(entry.depositAnnualRate) : null,
    depositInterest: entry.depositInterest != null ? toNumber(entry.depositInterest) : null,
    fundProductType: entry.fundProductType,
    metalTypeId: entry.metalTypeId ?? null,
    metalTypeName: entry.metalTypeName ?? null,
    metalUnitId: entry.metalUnitId ?? null,
    metalUnitName: entry.metalUnitName ?? null,
    metalQuantity: entry.metalQuantity != null ? toNumber(entry.metalQuantity) : null,
    metalUnitPrice: entry.metalUnitPrice != null ? toNumber(entry.metalUnitPrice) : null,
    metalFee: entry.metalFee != null ? toNumber(entry.metalFee) : null,
    fundUnits: entry.fundUnits != null ? toNumber(entry.fundUnits) : null,
    fundNav: entry.fundNav != null ? toNumber(entry.fundNav) : null,
    fundFee: entry.fundFee != null ? toNumber(entry.fundFee) : null,
    fundConfirmDate: toIsoOrNull(entry.fundConfirmDate),
    fundArrivalDate: toIsoOrNull(entry.fundArrivalDate),
    fundArrivalAmount: entry.fundArrivalAmount != null ? toNumber(entry.fundArrivalAmount) : null,
    ...buildEntryBusinessLinkSummary(entry),
    attachments: (entry.Attachment || []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "",
      mimeType: attachment.mimeType ?? null,
      url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
    })),
    entryTags: (entry.EntryTag || []).map((entryTag) => ({
      tagId: entryTag.tagId,
      Tag: entryTag.Tag ? { name: entryTag.Tag.name, color: entryTag.Tag.color ?? "" } : null,
    })),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = (url.searchParams.get("accountId") ?? "").trim();
  const billMonth = (url.searchParams.get("billMonth") ?? "all").trim() || "all";
  const showAllDetails = billMonth === "all";

  if (!accountId) {
    return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "Missing accountId." }, { status: 400 });
  }
  if (!showAllDetails && !/^\d{4}-\d{2}$/.test(billMonth)) {
    return NextResponse.json({ ok: false, code: "INVALID_BILL_MONTH", error: "billMonth must be YYYY-MM or all." }, { status: 400 });
  }

  try {
    const { householdId } = await getHouseholdScope();
    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit },
      select: {
        id: true,
        householdId: true,
        institutionId: true,
        kind: true,
        billingDay: true,
        repaymentDay: true,
        repaymentOffsetDays: true,
        creditBillMode: true,
        cardRole: true,
        primaryCardId: true,
        billingDayTxPeriod: true,
      },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "Credit account not found." }, { status: 404 });
    }

    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const billAccountIdSet = new Set(billAccountIds);
    const storageAccountId = billAccountIds[0] ?? account.id;
    await prisma.$transaction((tx) =>
      reconcileCreditCardBillingDayRulesFromAccounts(tx, {
        householdId,
        accountIds: billAccountIds,
      }),
    );
    const billingDayRules = await prisma.creditCardBillingDay.findMany({
      where: { accountId: { in: billAccountIds } },
      select: { effectiveDate: true, billingDay: true, repaymentDay: true, repaymentOffsetDays: true },
      orderBy: [{ effectiveDate: "asc" }],
    });
    const cycle = showAllDetails
      ? null
      : await (async () => {
          // 账单期只从唯一入口读：库里的坏周期（结束日落在邻月）会被丢掉并在下面
          // 按账单日规则重算，否则按它取明细会把邻月的流水当成这一期的。
          const { cycles } = await loadConsistentCreditCycles<{
            statementMonth: string;
            periodStart: Date;
            periodEnd: Date;
            dueDate: Date | null;
            isCurrentCycle: boolean;
          }>(prisma, {
            where: { accountId: storageAccountId, statementMonth: billMonth },
            select: {
              statementMonth: true,
              periodStart: true,
              periodEnd: true,
              dueDate: true,
              isCurrentCycle: true,
            },
            billingDayTxPeriod: account.billingDayTxPeriod,
          });
          const persisted = cycles[0] ?? null;
          if (persisted) {
            return {
              statementMonth: billMonth,
              start: persisted.periodStart,
              end: persisted.periodEnd,
              due: persisted.dueDate,
              isCurrentCycle: persisted.isCurrentCycle,
            };
          }
          const computed = cycleForStatementMonthWithBillingDayRules({
            statementMonth: billMonth,
            billingDayRules,
            repaymentDay: account.repaymentDay ?? null,
            repaymentOffsetDays: account.repaymentOffsetDays ?? null,
            now: new Date(),
            billingDayTxPeriod: account.billingDayTxPeriod,
          });
          return computed
            ? {
                statementMonth: billMonth,
                start: computed.start,
                end: computed.end,
                due: computed.due,
                isCurrentCycle: computed.isCurrentCycle,
              }
            : null;
        })();

    if (!showAllDetails && !cycle) {
      return NextResponse.json({ ok: false, code: "BILL_CYCLE_NOT_FOUND", error: "Bill cycle not found." }, { status: 404 });
    }

    // 与 RSC 账单页共用同一个读取通道（`credit-bill-entry-channel`）：整卡轻量行
    // 只读一次，按账期在内存里筛；只有最终返回的 ≤500 行才补精装关联。
    // 排序口径不变：按生效日（支出/收入取记账日，缺失回退交易日期）倒序，500 行封顶。
    const channel = await loadCreditBillEntryChannel(householdId, creditBillScopeKey(billAccountIds));
    const cycleQuery = {
      start: cycle?.start ?? null,
      end: cycle ? addDaysUtc(cycle.end, 1) : null,
      sortAccountId: accountId,
      types: CREDIT_BILL_DETAIL_TYPES,
    };
    // 计数用筛选结果的长度，不必为此把整期行都精装出来。
    const totalCount = filterCreditBillCycleRows(channel.activeRows, cycleQuery).length;
    const rows = await channel.loadCycleDetailRows({
      ...cycleQuery,
      take: CREDIT_BILL_DETAIL_TAKE,
    });

    const details = rows.map((row) => mapDetailEntry(row, billAccountIdSet));

    return NextResponse.json({
      ok: true,
      data: {
        accountId,
        billMonth,
        showAllDetails,
        totalCount,
        entries: details,
        cycle: cycle
          ? {
              statementMonth: cycle.statementMonth,
              periodStart: formatDateUtc(cycle.start),
              periodEnd: formatDateUtc(cycle.end),
              dueDate: cycle.due ? formatDateUtc(cycle.due) : null,
              periodLabel: `${mdUtcDots(cycle.start)} ~ ${mdUtcDots(cycle.end)}`,
              isCurrentCycle: cycle.isCurrentCycle,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("GET /api/v1/bill/details error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Internal server error." }, { status: 500 });
  }
}
