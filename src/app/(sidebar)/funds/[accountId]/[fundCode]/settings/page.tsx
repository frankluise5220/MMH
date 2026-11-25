import { AccountKind } from "@prisma/client";
import { notFound } from "next/navigation";

import { FundProfileSettingsClient, type FundProfileSettingsData } from "@/components/FundProfileSettingsClient";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { accountRenderSettings, buildAccountDisplayOption, buildFlatAccountOptions, buildGroupedAccountOptions } from "@/lib/account-display";
import { getInvestmentAccountView, isFundLikeInvestmentAccount } from "@/lib/account-kind-utils";
import { institutionFullName } from "@/lib/institution-display";
import { prisma } from "@/lib/db/prisma";
import { fundTradingCalendarForProfile, getFundProfile } from "@/lib/fund/fundProfile";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getServerAccountDropdownGroupBy } from "@/lib/server/account-dropdown-group-by";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";

export const dynamic = "force-dynamic";

export default async function FundProfileSettingsPage({
  params,
}: {
  params: Promise<{ accountId: string; fundCode: string }>;
}) {
  const { accountId, fundCode: rawFundCode } = await params;
  const fundCode = rawFundCode.trim();
  if (!/^\d{6}$/.test(fundCode)) notFound();

  const ctx = await getHouseholdScope();
  const account = await prisma.account.findFirst({
    where: {
      id: accountId,
      kind: AccountKind.investment,
      isPlaceholder: { not: true },
      ...ctx.hidFilter,
    },
    select: {
      id: true,
      name: true,
      investProductType: true,
      Institution: { select: { name: true, shortName: true } },
    },
  });
  if (!account) notFound();

  const [
    profile,
    holding,
    latestFundTransaction,
    latestLegacyTransaction,
    fundCompanyInstitutions,
    accountRows,
    accountLabelFields,
    accountDropdownGroupBy,
    baseCurrency,
  ] = await Promise.all([
    getFundProfile(fundCode),
    prisma.fundHolding.findFirst({
      where: { accountId: account.id, fundCode },
      select: { id: true },
    }),
    prisma.fundTransaction.findFirst({
      where: { fundAccountId: account.id, fundCode, deletedAt: null },
      select: { fundName: true },
      orderBy: [{ confirmDate: "desc" }, { createdAt: "desc" }],
    }),
    prisma.txRecord.findFirst({
      where: { householdId: ctx.householdId, deletedAt: null, fundCode, toAccountId: account.id },
      select: { fundName: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    }),
    prisma.institution.findMany({
      where: { householdId: ctx.householdId, type: "fund_company" },
      select: { id: true, name: true, shortName: true, type: true },
      orderBy: { name: "asc" },
    }),
    // 资料页底部可以直接新增计划任务，弹窗里的「基金账户 / 扣款账户」下拉需要同款候选。
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, ...ctx.hidFilter },
      include: { Institution: true, AccountGroup: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    getServerAccountLabelFields(),
    getServerAccountDropdownGroupBy(),
    getHouseholdBaseCurrency(ctx.householdId),
  ]);

  if (!holding && !latestFundTransaction && !latestLegacyTransaction) notFound();

  const profileData: FundProfileSettingsData = {
    fundCode,
    fundName: profile?.fundName ?? latestFundTransaction?.fundName ?? latestLegacyTransaction?.fundName ?? null,
    fundCompany: profile?.fundCompany ?? null,
    custodian: profile?.custodian ?? null,
    manager: profile?.manager ?? null,
    navDateOffset: profile?.navDateOffset ?? 0,
    tradingCalendar: profile ? fundTradingCalendarForProfile(profile) : "cn_fund",
  };
  const institutionName = institutionFullName(account.Institution) || null;
  const backQuery = new URLSearchParams({ accountId: account.id, view: getInvestmentAccountView(account), fundCode });
  // 账户下拉候选：标签统一走 account-display 入口（含本位币），不要在这里手拼机构·名称。
  const accountOptions = accountRows
    .filter((row) => row.isAggregate !== true)
    .map((row) => buildAccountDisplayOption(row, undefined, accountRenderSettings(accountLabelFields, baseCurrency)));
  const wantedFundType = account.investProductType === "money" ? "money" : null;
  const planInvestmentAccounts = accountOptions.filter(
    (item) =>
      isFundLikeInvestmentAccount(item) &&
      (!wantedFundType || !item.investProductType || item.investProductType === wantedFundType),
  );
  const planCashAccounts = accountOptions.filter((item) => ["bank_debit", "ewallet", "cash"].includes(item.kind));

  return (
    <FundProfileSettingsClient
      account={{ id: account.id, name: account.name, institutionName, investProductType: account.investProductType }}
      profile={profileData}
      // 基金公司是机构主体 → 只显示全称，简称仅用于账户标签，不再作为副标签重复出现。
      fundCompanyOptions={fundCompanyInstitutions.map((institution): SmartSelectOption => ({
        id: institution.id,
        label: institutionFullName(institution),
        kind: institution.type,
      }))}
      backHref={`/?${backQuery.toString()}`}
      investmentAccounts={planInvestmentAccounts.map((item) => ({ id: item.id, name: item.name, label: item.label }))}
      cashAccounts={planCashAccounts}
      investmentAccountSSOptions={buildFlatAccountOptions(planInvestmentAccounts)}
      cashAccountSSOptions={buildGroupedAccountOptions(planCashAccounts, accountDropdownGroupBy)}
    />
  );
}
