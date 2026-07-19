import { Suspense } from "react";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind } from "@prisma/client";

import { SidebarClient } from "@/components/layout/SidebarClient";
import { buildAccountDisplayOption, SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { getCachedHouseholdScope } from "@/lib/server/household-scope";
import { isDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import type { SidebarGroupMode } from "@/lib/client/appPreferences";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";

type CurrentCreditCycle = {
  accountId: string;
  effectiveBill: unknown;
  cumulativeRemain: unknown;
  cumulativeOverpaid: unknown;
};

async function getSidebarData() {
  await connection();
  const ctx = await getCachedHouseholdScope();
  const { householdId, hidFilter, user } = ctx;

  const cookieStore = await cookies();
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as string;
  const isRedUp = colorScheme === "red_up_green_down";
  const creditCardSidebarLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_sidebar_label_template")?.value || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
    "short_last4",
  );

  const [household, accounts, investBalByAccountId] = await Promise.all([
    prisma.household.findUnique({
      where: { id: householdId },
      select: { id: true, name: true },
    }),
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, name: { not: "未指定账户" }, ...hidFilter, isActive: true },
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ name: "asc" }],
    }),
    computeInvestBalances(ctx),
  ]);

  const cashBalanceAccounts = accounts
    .filter((account) => !isPureInvestmentAccount(account))
    .map((account) => ({
      id: account.id,
      kind: account.kind,
      investProductType: account.investProductType,
      billingDay: account.billingDay,
    }));
  const creditIds = accounts
    .filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay)
    .map((account) => account.id);
  const insuranceAccountIds = accounts
    .filter((account) => account.kind === AccountKind.insurance)
    .map((account) => account.id);
  const cashDisplayBalancePromise = computeAccountDisplayBalances(cashBalanceAccounts, hidFilter);
  const currentCreditCyclesPromise: Promise<CurrentCreditCycle[]> = creditIds.length > 0
    ? prisma.creditCardCycle.findMany({
        where: { accountId: { in: creditIds }, isCurrentCycle: true },
        select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
      })
    : Promise.resolve([]);
  const insuranceDisplayBalancePromise = computeInsuranceAccountDisplayBalances(insuranceAccountIds, hidFilter);
  const [cashDisplayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId] = await Promise.all([
    cashDisplayBalancePromise,
    currentCreditCyclesPromise,
    insuranceDisplayBalancePromise,
  ]);
  const currentCreditBalanceByAccountId = new Map<string, number>(
    currentCreditCycles.map((cycle) => [
      cycle.accountId,
      creditCardDisplayBalanceFromCurrentCycle(cycle),
    ]),
  );
  const items = accounts.map((account) => {
    const isInvest = isPureInvestmentAccount(account);
    const investDetail = isInvest ? investBalByAccountId.get(account.id) : null;
    const balance = isInvest
      ? (investDetail?.marketValue ?? 0)
      : account.kind === AccountKind.insurance
        ? (insuranceDisplayBalanceByAccountId.get(account.id) ?? 0)
      : isDepositAccount(account)
        ? (cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance))
      : account.kind === AccountKind.bank_credit && account.billingDay
        ? (currentCreditBalanceByAccountId.get(account.id) ?? cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance))
        : (cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance));
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardSidebarLabelTemplate);

    return {
      id: account.id,
      name: account.name,
      label: display.label,
      shortLabel: display.selectorCoreLabel,
      hoverTitle: display.hoverTitle,
      balance,
      kind: account.kind as string,
      groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
      institution: display.institutionName || undefined,
      institutionId: account.institutionId ?? null,
      institutionType: account.Institution?.type ?? null,
      counterpartyId: account.counterpartyId ?? null,
      investProductType: account.investProductType || undefined,
    };
  });

  return { items, household, isRedUp, user };
}

export async function Sidebar() {
  const { items, household, isRedUp, user } = await getSidebarData();
  const cookieStore = await cookies();
  const initialPreferences = {
    sidebarOwnerFilter: cookieStore.get("sidebar_owner_filter")?.value ?? "",
    sidebarHideZero: cookieStore.get("sidebar_hide_zero")?.value === "true",
    sidebarHideInitialData: cookieStore.get("sidebar_hide_initial_data")?.value === "true",
    sidebarCollapsed: cookieStore.get("sidebar_collapsed")?.value === "true",
    sidebarGroupBy: (cookieStore.get("sidebar_group_by")?.value === "institution" ? "institution" : "kind") as SidebarGroupMode,
  };

  return (
    <Suspense fallback={<div className="h-screen w-72 flex-shrink-0 border-r border-foreground/5 bg-background" />}>
      <SidebarClient items={items} household={household} isRedUp={isRedUp} user={user} initialPreferences={initialPreferences} />
    </Suspense>
  );
}
