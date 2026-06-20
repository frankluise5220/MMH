import { AccountKind, TransactionType } from "@prisma/client";

import { formatAccountDisplayName } from "@/lib/account-display";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import type { HouseholdContext } from "@/lib/server/household-scope";

export const KIND_LABEL: Record<string, string> = {
  cash: "现金",
  bank_debit: "借记卡",
  bank_credit: "信用卡",
  ewallet: "第三方余额",
  loan: "负债",
  other: "其他",
};

export const DAILY_KIND_ORDER: AccountKind[] = [
  AccountKind.cash,
  AccountKind.bank_debit,
  AccountKind.ewallet,
  AccountKind.loan,
  AccountKind.other,
];

export type AssetDistributionItem = {
  kind: string;
  label: string;
  value: number;
  pct: number;
};

export type AccountListRow = {
  id: string;
  name: string;
  kind: string;
  balance: number;
  groupName: string;
  institutionName: string;
};

export type CreditAccountRow = AccountListRow & {
  creditLimit: number;
  availableLimit: number;
  billingDay: number | null;
  repaymentDay: number | null;
  currentBill: number;
  paid: number;
  remain: number;
  dueDate: string | null;
};

export type AccountTypeTotals = {
  cash: number;
  bankDebit: number;
  ewallet: number;
  creditUsed: number;
  creditLimit: number;
  creditAvailable: number;
  creditCurrentBill: number;
  loan: number;
  other: number;
  liquidAssets: number;
  liabilities: number;
  dailyNetWorth: number;
};

export type TopPositionRow = {
  accountId?: string;
  fundCode: string;
  name: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
};

export type OverviewSummary = {
  netWorth: number;
  floatingPnL: number;
  totalCost: number;
  monthIncome: number;
  monthExpense: number;
  assetDistribution: AssetDistributionItem[];
  accountList: AccountListRow[];
  topPositions: TopPositionRow[];
  dailyNetWorth: number;
  dailyAssetDistribution: AssetDistributionItem[];
  dailyAccountList: AccountListRow[];
  creditAccountList: CreditAccountRow[];
  accountTypeTotals: AccountTypeTotals;
  creditUsedTotal: number;
  creditLimitTotal: number;
  creditAvailableTotal: number;
  creditCurrentBillTotal: number;
};

function dateToIso(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function buildDistribution(rows: AccountListRow[]) {
  const totals = new Map<string, number>();
  for (const kind of DAILY_KIND_ORDER) totals.set(kind, 0);
  for (const row of rows) {
    totals.set(row.kind, (totals.get(row.kind) ?? 0) + row.balance);
  }

  const totalAbs = Array.from(totals.values()).reduce((sum, value) => sum + Math.abs(value), 0);

  return DAILY_KIND_ORDER
    .filter((kind) => totals.get(kind) !== 0)
    .map((kind) => {
      const value = totals.get(kind) ?? 0;
      return {
        kind,
        label: KIND_LABEL[kind] ?? kind,
        value,
        pct: totalAbs > 0 ? (Math.abs(value) / totalAbs) * 100 : 0,
      };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

export async function computeOverviewSummary(ctx: HouseholdContext): Promise<OverviewSummary> {
  const { hidFilter } = ctx;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const accounts = await prisma.account.findMany({
    where: { isActive: true, ...hidFilter },
    select: {
      id: true,
      name: true,
      kind: true,
      balance: true,
      creditLimit: true,
      billingDay: true,
      repaymentDay: true,
      Institution: { select: { name: true } },
      AccountGroup: { select: { name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const dailyAccounts = accounts.filter(
    (account) => account.kind !== AccountKind.investment && account.kind !== AccountKind.bank_credit,
  );
  const creditAccounts = accounts.filter((account) => account.kind === AccountKind.bank_credit);
  const dailyAccountIds = dailyAccounts.map((account) => account.id);

  let monthIncome = 0;
  let monthExpense = 0;

  if (dailyAccountIds.length > 0) {
    const monthEntries = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...hidFilter,
        date: { gte: monthStart, lt: monthEnd },
        OR: [{ accountId: { in: dailyAccountIds } }, { toAccountId: { in: dailyAccountIds } }],
      },
      select: { type: true, amount: true, accountId: true, toAccountId: true },
    });

    for (const entry of monthEntries) {
      const amount = Math.abs(toNumber(entry.amount));
      const isToDaily = dailyAccountIds.includes(entry.toAccountId ?? "");
      const isFromDaily = dailyAccountIds.includes(entry.accountId);

      if (entry.type === TransactionType.income && isToDaily) {
        monthIncome += amount;
      } else if (entry.type === TransactionType.expense && isFromDaily) {
        monthExpense += amount;
      } else if (entry.type === TransactionType.transfer) {
        if (isToDaily && !isFromDaily) monthIncome += amount;
        if (isFromDaily && !isToDaily) monthExpense += amount;
      }
    }
  }

  const dailyAccountList: AccountListRow[] = dailyAccounts.map((account) => {
    const institutionName = account.Institution?.name?.trim() ?? "";
    return {
      id: account.id,
      name: formatAccountDisplayName(account.name, institutionName),
      kind: account.kind,
      balance: toNumber(account.balance),
      groupName: account.AccountGroup?.name?.trim() || "未分组",
      institutionName,
    };
  });

  const creditIds = creditAccounts.map((account) => account.id);
  const currentCycles =
    creditIds.length > 0
      ? await prisma.creditCardCycle.findMany({
          where: { accountId: { in: creditIds }, isCurrentCycle: true },
          select: { accountId: true, effectiveBill: true, paid: true, cumulativeRemain: true, dueDate: true },
        })
      : [];
  const cycleByAccountId = new Map(currentCycles.map((cycle) => [cycle.accountId, cycle]));

  const creditAccountList: CreditAccountRow[] = creditAccounts.map((account) => {
    const institutionName = account.Institution?.name?.trim() ?? "";
    const balance = toNumber(account.balance);
    const creditLimit = toNumber(account.creditLimit);
    const cycle = cycleByAccountId.get(account.id);
    const currentBill = toNumber(cycle?.effectiveBill);
    const paid = toNumber(cycle?.paid);
    const remain = toNumber(cycle?.cumulativeRemain);

    return {
      id: account.id,
      name: formatAccountDisplayName(account.name, institutionName),
      kind: account.kind,
      balance,
      groupName: account.AccountGroup?.name?.trim() || "未分组",
      institutionName,
      creditLimit,
      availableLimit: Math.max(0, creditLimit - Math.max(0, balance)),
      billingDay: account.billingDay,
      repaymentDay: account.repaymentDay,
      currentBill,
      paid,
      remain,
      dueDate: dateToIso(cycle?.dueDate),
    };
  });

  const cash = dailyAccountList.filter((account) => account.kind === AccountKind.cash).reduce((sum, account) => sum + account.balance, 0);
  const bankDebit = dailyAccountList.filter((account) => account.kind === AccountKind.bank_debit).reduce((sum, account) => sum + account.balance, 0);
  const ewallet = dailyAccountList.filter((account) => account.kind === AccountKind.ewallet).reduce((sum, account) => sum + account.balance, 0);
  const loan = dailyAccountList.filter((account) => account.kind === AccountKind.loan).reduce((sum, account) => sum + Math.max(0, account.balance), 0);
  const other = dailyAccountList.filter((account) => account.kind === AccountKind.other).reduce((sum, account) => sum + account.balance, 0);
  const creditUsedTotal = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.balance), 0);
  const creditLimitTotal = creditAccountList.reduce((sum, account) => sum + account.creditLimit, 0);
  const creditAvailableTotal = Math.max(0, creditLimitTotal - creditUsedTotal);
  const creditCurrentBillTotal = creditAccountList.reduce((sum, account) => sum + account.currentBill, 0);
  const liquidAssets = cash + bankDebit + ewallet + Math.max(0, other);
  const liabilities = loan + creditUsedTotal;
  const dailyNetWorth = liquidAssets + Math.min(0, other) - liabilities;
  const dailyAssetDistribution = buildDistribution(dailyAccountList);
  const accountTypeTotals: AccountTypeTotals = {
    cash,
    bankDebit,
    ewallet,
    creditUsed: creditUsedTotal,
    creditLimit: creditLimitTotal,
    creditAvailable: creditAvailableTotal,
    creditCurrentBill: creditCurrentBillTotal,
    loan,
    other,
    liquidAssets,
    liabilities,
    dailyNetWorth,
  };

  return {
    netWorth: dailyNetWorth,
    floatingPnL: 0,
    totalCost: 0,
    monthIncome,
    monthExpense,
    assetDistribution: dailyAssetDistribution,
    accountList: dailyAccountList,
    topPositions: [],
    dailyNetWorth,
    dailyAssetDistribution,
    dailyAccountList,
    creditAccountList,
    accountTypeTotals,
    creditUsedTotal,
    creditLimitTotal,
    creditAvailableTotal,
    creditCurrentBillTotal,
  };
}
