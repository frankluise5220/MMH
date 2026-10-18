import { Suspense } from "react";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind } from "@prisma/client";

import { SidebarClient } from "@/components/layout/SidebarClient";
import { buildAccountDisplayOption, SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { getMaintainedAccountBalances } from "@/lib/server/account-balance";
import { computeLiabilityDisplaySummary } from "@/lib/server/liability-display-summary";
import { getCachedHouseholdScope } from "@/lib/server/household-scope";
import { isDepositAccount, isLoanOrSettlementAccountKind, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { dominantFixedAssetType } from "@/lib/fixed-asset";
import type { SidebarGroupMode } from "@/lib/client/appPreferences";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { convertCurrencyAmounts } from "@/lib/server/fx-rates";
import { normalizeCurrency } from "@/lib/currency";

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
      select: { id: true, name: true, baseCurrency: true },
    }),
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, name: { not: "未指定账户" }, ...hidFilter, isActive: true },
      include: {
        AccountGroup: true,
        Institution: true,
        Counterparty: true,
        // 固定资产的**真实类型在资产行上**：`Account.fixedAssetType` 是后加的列，
        // 迁移没有回填 → 存量账户全为 NULL。这里必须带出 assetType 供分组回退，
        // 否则车辆/设备会被兜底成「房产」，从侧边栏入口彻底看不到。
        PropertyAsset: {
          where: { deletedAt: null },
          select: { assetType: true },
          orderBy: [{ purchaseDate: "asc" }, { createdAt: "asc" }],
        },
      },
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
    .filter((account) => account.kind === AccountKind.bank_credit)
    .map((account) => account.id);
  const insuranceAccountIds = accounts
    .filter((account) => account.kind === AccountKind.insurance)
    .map((account) => account.id);
  const cashDisplayBalancePromise = getMaintainedAccountBalances(cashBalanceAccounts, hidFilter);
  const currentCreditCyclesPromise: Promise<CurrentCreditCycle[]> = creditIds.length > 0
    ? prisma.creditCardCycle.findMany({
        where: { accountId: { in: creditIds }, isCurrentCycle: true },
        select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
      })
    : Promise.resolve([]);
  const insuranceDisplayBalancePromise = computeInsuranceAccountDisplayBalances(insuranceAccountIds, hidFilter);
  const liabilityDisplaySummaryPromise = computeLiabilityDisplaySummary(ctx);
  const [cashDisplayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId, liabilityDisplaySummary] = await Promise.all([
    cashDisplayBalancePromise,
    currentCreditCyclesPromise,
    insuranceDisplayBalancePromise,
    liabilityDisplaySummaryPromise,
  ]);
  const currentCreditBalanceByAccountId = new Map<string, number>(
    currentCreditCycles.map((cycle) => [
      cycle.accountId,
      creditCardDisplayBalanceFromCurrentCycle(cycle),
    ]),
  );
  const baseCurrency = normalizeCurrency(household?.baseCurrency);
  const rawItems = accounts.map((account) => {
    const isInvest = isPureInvestmentAccount(account);
    const investDetail = isInvest ? investBalByAccountId.get(account.id) : null;
    const balance = account.isAggregate
      // 聚合账户（父账户）没有明细：余额只能用子户折本位币后维护进 `balance` 列的值。
      ? Number(account.balance)
      : isInvest
      ? (investDetail?.marketValue ?? 0)
      : account.kind === AccountKind.insurance
        ? (insuranceDisplayBalanceByAccountId.get(account.id) ?? 0)
      : isDepositAccount(account)
        ? (cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance))
      : account.kind === AccountKind.bank_credit
        ? (currentCreditBalanceByAccountId.get(account.id) ?? cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance))
      : isLoanOrSettlementAccountKind(account.kind)
        ? (liabilityDisplaySummary.balanceByAccountId.get(account.id) ?? cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance))
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
      Counterparty: account.Counterparty,
    }, creditCardSidebarLabelTemplate);

    return {
      id: account.id,
      name: account.name,
      label: display.label,
      shortLabel: display.selectorCoreLabel,
      hoverTitle: display.hoverTitle,
      balance,
      currency: normalizeCurrency(account.currency),
      kind: account.kind as string,
      groupName: display.groupName || (isLoanOrSettlementAccountKind(account.kind) ? "" : "未设置所有人"),
      institution: display.institutionName || undefined,
      institutionId: account.institutionId ?? null,
      institutionType: account.Institution?.type ?? null,
      counterpartyId: account.counterpartyId ?? null,
      counterpartyReimbursable: account.Counterparty?.isReimbursable === true,
      liabilityDirection: account.liabilityDirection ?? null,
      isConsumerLoan: account.isConsumerLoan === true,
      loanType: account.loanType ?? null,
      investProductType: account.investProductType || undefined,
      // 分组口径必须与「点进去后按什么过滤」一致：视图按**资产行的 `assetType`** 过滤
      // （`page.tsx` 的 `position.assetType === fixedAssetTypeParam`），所以这里也以资产行为准。
      // `Account.fixedAssetType` 只是「新建资产时的默认类型」，只有在账户还没有资产行时才拿来兜底。
      // 反过来（账户优先）会出现「分组里有它、点进去列表里没有」——正是这次「资产消失」的症状。
      // 用户发现分类不对时，改的是**资产类型**（固定资产页 → `PUT /api/v1/properties`），
      // 那条路径会同时回写账户列，所以改完这里立刻跟着变。
      fixedAssetType: dominantFixedAssetType(account.PropertyAsset.map((asset) => asset.assetType)) ?? account.fixedAssetType,
      // 多币种父子层级（2026-10-18）：父账户是统计单元、子账户是记账单元。
      // 侧边栏把子账户缩进挂在父账户下，两个字段必须原样带给客户端，
      // 否则客户端只能看到一排平铺账户（父账户与子账户还会被重复统计）。
      parentId: account.parentId ?? null,
      isAggregate: account.isAggregate === true,
    };
  });
  const conversion = await convertCurrencyAmounts({
    householdId,
    toCurrency: baseCurrency,
    refreshMissing: true,
    amounts: rawItems.map((item) => ({ amount: item.balance, currency: item.currency })),
  });
  const rateByCurrency = new Map(conversion.rates.map((rate) => [rate.fromCurrency, rate]));
  const items = rawItems.map((item) => {
    const rate = rateByCurrency.get(item.currency);
    return {
      ...item,
      baseCurrency,
      convertedBalance: rate?.rate == null ? null : item.balance * rate.rate,
      fxRateMissing: rate?.missing ?? false,
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
    sidebarShowFixedAssets: cookieStore.get("sidebar_show_fixed_assets")?.value !== "false",
    sidebarShowAllCashEntries: cookieStore.get("sidebar_show_all_cash_entries")?.value !== "false",
    sidebarShowReimbursements: cookieStore.get("sidebar_show_reimbursements")?.value !== "false",
    sidebarCollapsed: cookieStore.get("sidebar_collapsed")?.value === "true",
    sidebarGroupBy: (cookieStore.get("sidebar_group_by")?.value === "institution" ? "institution" : "kind") as SidebarGroupMode,
  };

  return (
    <Suspense fallback={<div className="h-screen w-72 flex-shrink-0 border-r border-foreground/5 bg-background" />}>
      <SidebarClient items={items} household={household} isRedUp={isRedUp} user={user} initialPreferences={initialPreferences} />
    </Suspense>
  );
}
