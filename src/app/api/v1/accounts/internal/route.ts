import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import { isDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { buildAccountDisplayOption } from "@/lib/account-display";

function normalizeReturnedAccountKind<T extends { kind: AccountKind; investProductType?: string | null }>(account: T): T {
  if (account.kind === AccountKind.investment && account.investProductType === "deposit") {
    return { ...account, kind: AccountKind.deposit };
  }
  return account;
}

function withAccountDisplayFields<T extends {
  id: string;
  name: string;
  kind: AccountKind;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
}>(account: T) {
  const normalized = normalizeReturnedAccountKind(account);
  const display = buildAccountDisplayOption(normalized);
  return {
    ...normalized,
    label: display.selectorLabel || display.label,
    selectorLabel: display.selectorLabel,
    selectorCoreLabel: display.selectorCoreLabel,
    fullLabel: display.fullLabel,
    hoverTitle: display.hoverTitle,
    displaySubLabel: display.subLabel,
  };
}

/**
 * 获取账户设置页面所需全部数据（按当前账簿筛选）
 * GET /api/v1/accounts/internal
 *
 * Query:
 * - balances=false 时只返回账户/所有人/机构基础资料，不计算显示余额。
 */
export async function GET(request: Request) {
  try {
    const includeBalances = request.url ? new URL(request.url).searchParams.get("balances") !== "false" : true;
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;

    const [accounts, groups, institutions, counterparties, users] = await Promise.all([
      prisma.account.findMany({
        where: { isPlaceholder: { not: true }, ...hidFilter },
        include: { Institution: true, Counterparty: true, AccountGroup: true, AccountAlias: true },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.accountGroup.findMany({
        where: hidFilter,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      prisma.institution.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
      prisma.counterparty.findMany({ where: hidFilter, orderBy: [{ type: "asc" }, { name: "asc" }] }),
      prisma.user.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
    ]);

    if (!includeBalances) {
      return NextResponse.json({ ok: true, accounts: accounts.map(withAccountDisplayFields), groups, institutions, counterparties, users });
    }

    // For investment accounts, use market value instead of raw balance
    const investBalByAccountId = await computeInvestBalances({ hidFilter, householdId: hidFilter.householdId ?? "", user: null });
    const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
      accounts
        .filter((account) => !isPureInvestmentAccount(account))
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      hidFilter,
    );
    const creditIds = accounts
      .filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay)
      .map((account) => account.id);
    const currentCreditCycles =
      creditIds.length > 0
        ? await prisma.creditCardCycle.findMany({
            where: { accountId: { in: creditIds }, isCurrentCycle: true },
            select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
          })
        : [];
    const currentCreditBalanceByAccountId = new Map(
      currentCreditCycles.map((cycle) => [
        cycle.accountId,
        creditCardDisplayBalanceFromCurrentCycle(cycle),
      ]),
    );
    const insuranceAccountIds = accounts
      .filter((account) => account.kind === AccountKind.insurance)
      .map((account) => account.id);
    const insuranceDisplayBalanceByAccountId = await computeInsuranceAccountDisplayBalances(
      insuranceAccountIds,
      hidFilter,
    );
    const debtDisplaySummary = await computeDebtDisplaySummary(ctx);
    const enrichedAccounts = accounts.map((a) => {
      if (isPureInvestmentAccount(a)) {
        const detail = investBalByAccountId.get(a.id);
        if (detail) return { ...a, balance: detail.marketValue };
      }
      if (a.kind === AccountKind.insurance) {
        return { ...a, balance: insuranceDisplayBalanceByAccountId.get(a.id) ?? 0 };
      }
      if (isDepositAccount(a)) {
        const displayBalance = cashDisplayBalanceByAccountId.get(a.id);
        return displayBalance == null ? a : { ...a, balance: displayBalance };
      }
      if (a.kind === AccountKind.bank_credit && a.billingDay) {
        const creditDisplayBalance = currentCreditBalanceByAccountId.get(a.id);
        if (creditDisplayBalance != null) return { ...a, balance: creditDisplayBalance };
      }
      if (a.kind === AccountKind.loan) {
        const debtDisplayBalance = debtDisplaySummary.balanceByAccountId.get(a.id);
        if (debtDisplayBalance != null) return { ...a, balance: debtDisplayBalance };
      }
      const displayBalance = cashDisplayBalanceByAccountId.get(a.id);
      return displayBalance == null ? a : { ...a, balance: displayBalance };
    });

    return NextResponse.json({ ok: true, accounts: enrichedAccounts.map(withAccountDisplayFields), groups, institutions, counterparties, users });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}
