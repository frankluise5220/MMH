import { AccountKind, TransactionType } from "@prisma/client";

import { buildAccountDisplayOption, DEFAULT_CREDIT_CARD_LABEL_TEMPLATE } from "@/lib/account-display";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { isLegacyDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { getIncomeExpenseStatisticAmount } from "@/lib/transaction-statistics";

export const KIND_LABEL: Record<string, string> = {
  cash: "现金",
  bank_debit: "借记卡",
  bank_credit: "信用卡",
  ewallet: "电子钱包",
  deposit: "存款",
  loan: "债务/债权",
  other: "其他",
};

export const DAILY_KIND_ORDER: string[] = [
  AccountKind.cash,
  AccountKind.bank_debit,
  AccountKind.ewallet,
  "deposit",
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
  creditBillMode: "separate" | "consolidated";
  currentBill: number;
  paid: number;
  remain: number;
  dueDate: string | null;
};

export type AccountTypeTotals = {
  cash: number;
  bankDebit: number;
  ewallet: number;
  deposit: number;
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  creditUsed: number;
  creditLimit: number;
  creditAvailable: number;
  creditCurrentBill: number;
  loan: number;
  loanReceivable: number;
  other: number;
  liquidAssets: number;
  liabilities: number;
  dailyNetWorth: number;
  totalNetWorth: number;
};

export type TopPositionRow = {
  accountId?: string;
  investProductType?: string | null;
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
  investmentAccountList: TopPositionRow[];
  dailyNetWorth: number;
  dailyAssetDistribution: AssetDistributionItem[];
  dailyAccountList: AccountListRow[];
  creditAccountList: CreditAccountRow[];
  debtAccountList: AccountListRow[];
  accountTypeTotals: AccountTypeTotals;
  creditUsedTotal: number;
  creditLimitTotal: number;
  creditAvailableTotal: number;
  creditCurrentBillTotal: number;
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  investmentFloatingPnLRate: number;
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

export async function computeOverviewSummary(
  ctx: HouseholdContext,
  creditCardLabelTemplate: string = DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
): Promise<OverviewSummary> {
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
      groupId: true,
      balance: true,
      creditLimit: true,
      billingDay: true,
      repaymentDay: true,
      creditBillMode: true,
      institutionId: true,
      numberMasked: true,
      investProductType: true,
      Institution: { select: { name: true, shortName: true } },
      AccountGroup: { select: { name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const legacyDepositAccounts = accounts.filter(isLegacyDepositAccount);
  const pureInvestmentAccounts = accounts.filter(isPureInvestmentAccount);
  const creditAccounts = accounts.filter((account) => account.kind === AccountKind.bank_credit);
  const debtAccounts = accounts.filter((account) => account.kind === AccountKind.loan);

  const dailyBaseAccounts = accounts.filter(
    (account) =>
      !isPureInvestmentAccount(account) &&
      !isLegacyDepositAccount(account) &&
      account.kind !== AccountKind.bank_credit &&
      account.kind !== AccountKind.loan &&
      account.kind !== AccountKind.insurance,
  );

  const dailyAccounts = [
    ...dailyBaseAccounts.map((account) => ({ ...account, summaryKind: account.kind as string })),
    ...legacyDepositAccounts.map((account) => ({ ...account, summaryKind: "deposit" })),
  ];
  const dailyAccountIds = dailyAccounts.map((account) => account.id);
  const dailyAndDebtDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    [...dailyAccounts, ...debtAccounts].map((account) => ({
      id: account.id,
      kind: account.kind,
      investProductType: account.investProductType,
      billingDay: account.billingDay,
    })),
    hidFilter,
  );

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
      const amount = toNumber(entry.amount);
      const isToDaily = dailyAccountIds.includes(entry.toAccountId ?? "");
      const isFromDaily = dailyAccountIds.includes(entry.accountId);

      if (entry.type === TransactionType.income && isToDaily) {
        monthIncome += getIncomeExpenseStatisticAmount(entry.type, amount);
      } else if (entry.type === TransactionType.expense && isFromDaily) {
        monthExpense += getIncomeExpenseStatisticAmount(entry.type, amount);
      } else if (entry.type === TransactionType.transfer) {
        if (isToDaily && !isFromDaily) monthIncome += Math.abs(amount);
        if (isFromDaily && !isToDaily) monthExpense += Math.abs(amount);
      }
    }
  }

  const dailyAccountList: AccountListRow[] = dailyAccounts.map((account) => {
    const display = buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        investProductType: account.investProductType,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
      },
      creditCardLabelTemplate,
    );

    return {
      id: account.id,
      name: display.label,
      kind: account.summaryKind,
      balance: dailyAndDebtDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
      groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
      institutionName: display.institutionName,
    };
  });

  const consolidatedInstitutionIds = Array.from(new Set(
    creditAccounts
      .filter((account) => account.creditBillMode === "consolidated" && !!account.institutionId)
      .map((account) => account.institutionId!),
  ));
  const consolidatedGroupAccounts = consolidatedInstitutionIds.length > 0
    ? await prisma.account.findMany({
        where: {
          ...hidFilter,
          kind: AccountKind.bank_credit,
          creditBillMode: "consolidated",
          institutionId: { in: consolidatedInstitutionIds },
        },
        select: { id: true, institutionId: true },
        orderBy: { id: "asc" },
      })
    : [];
  const consolidatedStorageIdByInstitutionId = new Map<string, string>();
  for (const account of consolidatedGroupAccounts) {
    if (account.institutionId && !consolidatedStorageIdByInstitutionId.has(account.institutionId)) {
      consolidatedStorageIdByInstitutionId.set(account.institutionId, account.id);
    }
  }
  const creditStorageIdByAccountId = new Map(
    creditAccounts.map((account) => {
      if (account.creditBillMode !== "consolidated" || !account.institutionId) {
        return [account.id, account.id] as const;
      }
      const storageId = consolidatedStorageIdByInstitutionId.get(account.institutionId) ?? account.id;
      return [account.id, storageId] as const;
    }),
  );
  const creditIds = Array.from(new Set(creditStorageIdByAccountId.values()));
  const currentCycles =
    creditIds.length > 0
      ? await prisma.creditCardCycle.findMany({
          where: { accountId: { in: creditIds }, isCurrentCycle: true },
          select: { accountId: true, effectiveBill: true, paid: true, cumulativeRemain: true, cumulativeOverpaid: true, dueDate: true },
        })
      : [];
  const cycleByAccountId = new Map(currentCycles.map((cycle) => [cycle.accountId, cycle]));

  const creditAccountList: CreditAccountRow[] = creditAccounts.map((account) => {
    const display = buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
      },
      creditCardLabelTemplate,
    );
    const creditLimit = toNumber(account.creditLimit);
    const cycle = cycleByAccountId.get(creditStorageIdByAccountId.get(account.id) ?? account.id);
    const balance = cycle
      ? toNumber(cycle.cumulativeRemain) - toNumber(cycle.cumulativeOverpaid)
      : toNumber(account.balance);

    return {
      id: account.id,
      name: display.label,
      kind: account.kind,
      balance,
      groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
      institutionName: display.institutionName,
      creditLimit,
      availableLimit: Math.max(0, creditLimit - Math.max(0, balance)),
      billingDay: account.billingDay,
      repaymentDay: account.repaymentDay,
      creditBillMode: account.creditBillMode,
      currentBill: toNumber(cycle?.effectiveBill),
      paid: toNumber(cycle?.paid),
      remain: toNumber(cycle?.cumulativeRemain),
      dueDate: dateToIso(cycle?.dueDate),
    };
  });

  const debtAccountList: AccountListRow[] = debtAccounts.map((account) => {
    const display = buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
      },
      creditCardLabelTemplate,
    );
    return {
      id: account.id,
      name: display.label,
      kind: account.kind,
      balance: dailyAndDebtDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
      groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
      institutionName: display.institutionName,
    };
  });

  const cash = dailyAccountList.filter((account) => account.kind === AccountKind.cash).reduce((sum, account) => sum + account.balance, 0);
  const bankDebit = dailyAccountList.filter((account) => account.kind === AccountKind.bank_debit).reduce((sum, account) => sum + account.balance, 0);
  const ewallet = dailyAccountList.filter((account) => account.kind === AccountKind.ewallet).reduce((sum, account) => sum + account.balance, 0);
  const deposit = dailyAccountList.filter((account) => account.kind === "deposit").reduce((sum, account) => sum + account.balance, 0);
  const other = dailyAccountList.filter((account) => account.kind === AccountKind.other).reduce((sum, account) => sum + account.balance, 0);

  const loan = debtAccountList
    .filter((account) => account.balance < 0)
    .reduce((sum, account) => sum + Math.abs(account.balance), 0);
  const loanReceivable = debtAccountList
    .filter((account) => account.balance > 0)
    .reduce((sum, account) => sum + Math.max(0, account.balance), 0);

  const creditUsedTotal = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.balance), 0);
  const creditLimitTotal = creditAccountList.reduce((sum, account) => sum + account.creditLimit, 0);
  const creditAvailableTotal = Math.max(0, creditLimitTotal - creditUsedTotal);
  const creditCurrentBillTotal = creditAccountList.reduce((sum, account) => sum + account.currentBill, 0);

  const liquidAssets = cash + bankDebit + ewallet + deposit + Math.max(0, other);
  const liabilities = loan + creditUsedTotal;
  const dailyNetWorth = liquidAssets + loanReceivable + Math.min(0, other) - liabilities;
  const dailyAssetDistribution = buildDistribution(dailyAccountList);

  const investBalByAccountId = await computeInvestBalances(ctx);
  const investmentAccountList: TopPositionRow[] = pureInvestmentAccounts
    .map((account) => {
      const detail = investBalByAccountId.get(account.id);
      const marketValue = detail?.marketValue ?? 0;
      const totalCost = detail?.totalCost ?? 0;
      const floatingPnL = detail?.floatingPnL ?? 0;
      const display = buildAccountDisplayOption(
        {
          id: account.id,
          name: account.name,
          kind: account.kind,
          numberMasked: account.numberMasked,
          groupId: account.groupId,
          investProductType: account.investProductType,
          Institution: account.Institution,
          AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
        },
        creditCardLabelTemplate,
      );
      return {
        accountId: account.id,
        investProductType: account.investProductType,
        fundCode: "",
        name: display.label,
        marketValue,
        floatingPnL,
        floatingPnLRate: totalCost > 0 ? floatingPnL / totalCost : 0,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const investmentMarketValue = investmentAccountList.reduce((sum, row) => sum + row.marketValue, 0);
  const investmentCost = pureInvestmentAccounts.reduce((sum, account) => sum + (investBalByAccountId.get(account.id)?.totalCost ?? 0), 0);
  const investmentFloatingPnL = investmentAccountList.reduce((sum, row) => sum + row.floatingPnL, 0);
  const investmentFloatingPnLRate = investmentCost > 0 ? investmentFloatingPnL / investmentCost : 0;
  const totalNetWorth = dailyNetWorth + investmentMarketValue;

  const accountTypeTotals: AccountTypeTotals = {
    cash,
    bankDebit,
    ewallet,
    deposit,
    investmentMarketValue,
    investmentCost,
    investmentFloatingPnL,
    creditUsed: creditUsedTotal,
    creditLimit: creditLimitTotal,
    creditAvailable: creditAvailableTotal,
    creditCurrentBill: creditCurrentBillTotal,
    loan,
    loanReceivable,
    other,
    liquidAssets,
    liabilities,
    dailyNetWorth,
    totalNetWorth,
  };

  return {
    netWorth: totalNetWorth,
    floatingPnL: investmentFloatingPnL,
    totalCost: investmentCost,
    monthIncome,
    monthExpense,
    assetDistribution: dailyAssetDistribution,
    accountList: dailyAccountList,
    topPositions: investmentAccountList.slice(0, 5),
    investmentAccountList,
    dailyNetWorth,
    dailyAssetDistribution,
    dailyAccountList,
    creditAccountList,
    debtAccountList,
    accountTypeTotals,
    creditUsedTotal,
    creditLimitTotal,
    creditAvailableTotal,
    creditCurrentBillTotal,
    investmentMarketValue,
    investmentCost,
    investmentFloatingPnL,
    investmentFloatingPnLRate,
  };
}
