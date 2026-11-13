"use client";

import Link from "next/link";
import {
  BarChart3,
  Building2,
  CreditCard,
  HandCoins,
  PiggyBank,
  Wallet,
} from "lucide-react";

import { MonthlyCashFlowChart } from "@/components/MonthlyCashFlowChart";
import type { MonthlyCashFlowItem } from "@/components/MonthlyCashFlowChart";
import { formatCurrencyMoney, formatMoney, formatMoneyYuan, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { InsuranceOverviewCard, type InsuranceOverview } from "@/components/InsuranceOverviewCard";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { MobileOverviewDashboard } from "@/components/mobile/MobileOverviewDashboard";
import { useI18n } from "@/lib/i18n";

type AssetDistItem = {
  kind: string;
  label: string;
  value: number;
  pct: number;
};

export type AccountItem = {
  id: string;
  name: string;
  kind: string;
  /** Balance in the account's own currency. */
  balance: number;
  currency?: string;
  /** 行内看不到的信息（所有人/类型/非本位币），仅在非空时作为 title。 */
  hoverTitle?: string;
  /** Same balance restated in the household base currency; null when no rate is available. */
  convertedBalance?: number | null;
  fxRateMissing?: boolean;
};

/** Prefer the base-currency amount; fall back to the raw amount only when no rate exists. */
function baseAmount(item: { balance: number; convertedBalance?: number | null }) {
  return item.convertedBalance ?? item.balance;
}

type CreditAccountItem = AccountItem & {
  creditLimit: number;
  availableLimit: number;
  currentBill: number;
  paid: number;
  dueDate?: string | null;
  /** Base-currency mirrors; null when the card's currency has no rate. */
  convertedCreditLimit?: number | null;
  convertedCurrentBill?: number | null;
  convertedPaid?: number | null;
  convertedCurrentAmount?: number | null;
};

type FixedAssetItem = {
  accountId: string;
  name: string;
  assetType?: string | null;
  marketValue: number;
  cost: number;
  floatingPnL: number;
  floatingPnLRate: number;
  currency?: string;
  /** 行内看不到的信息（所有人/类型/非本位币），仅在非空时作为 title。 */
  hoverTitle?: string;
  convertedMarketValue?: number | null;
  fxRateMissing?: boolean;
};

export type AccountTypeTotals = {
  cash: number;
  bankDebit: number;
  ewallet: number;
  deposit: number;
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  fixedAssetMarketValue: number;
  fixedAssetCost: number;
  insuranceAsset: number;
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

type InvestmentOverviewItem = {
  accountId?: string;
  investProductType?: string | null;
  fundCode: string;
  name: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  currency?: string;
  /** 行内看不到的信息（所有人/类型/非本位币），仅在非空时作为 title。 */
  hoverTitle?: string;
  convertedMarketValue?: number | null;
  convertedFloatingPnL?: number | null;
  fxRateMissing?: boolean;
};

export type OverviewDashboardProps = {
  netWorth: number;
  accountTypeTotals?: Partial<AccountTypeTotals> | null;
  assetDistribution: AssetDistItem[];
  monthIncome: number;
  monthExpense: number;
  /** 近 12 个月（含本月）收支，服务端按业务日截止统计；缺失时不渲染柱形图。 */
  monthlyCashFlow?: MonthlyCashFlowItem[];
  accountList: AccountItem[];
  creditAccountList: CreditAccountItem[];
  liabilityAccountList?: AccountItem[];
  topPositions?: InvestmentOverviewItem[];
  investmentAccountCount?: number;
  insuranceAccountCount?: number;
  investmentMarketValue?: number;
  investmentCost?: number;
  investmentFloatingPnL?: number;
  investmentFloatingPnLRate?: number;
  investmentTotalReturn?: number;
  investmentThisYearProfit?: number;
  fixedAssetAccountList?: FixedAssetItem[];
  fixedAssetCount?: number;
  fixedAssetMarketValue?: number;
  fixedAssetCost?: number;
  fixedAssetFloatingPnL?: number;
  fixedAssetFloatingPnLRate?: number;
  insuranceOverview?: InsuranceOverview | null;
  baseCurrency?: string;
  missingFxCurrencies?: string[];
  isRedUp: boolean;
};

const ZERO_TOTALS: AccountTypeTotals = {
  cash: 0,
  bankDebit: 0,
  ewallet: 0,
  deposit: 0,
  investmentMarketValue: 0,
  investmentCost: 0,
  investmentFloatingPnL: 0,
  fixedAssetMarketValue: 0,
  fixedAssetCost: 0,
  insuranceAsset: 0,
  creditUsed: 0,
  creditLimit: 0,
  creditAvailable: 0,
  creditCurrentBill: 0,
  loan: 0,
  loanReceivable: 0,
  other: 0,
  liquidAssets: 0,
  liabilities: 0,
  dailyNetWorth: 0,
  totalNetWorth: 0,
};

/** True when the row is denominated in a currency other than the household base currency. */
function isForeign(item: { currency?: string; fxMissing?: boolean }, baseCurrency: string) {
  const currency = String(item.currency ?? baseCurrency).trim().toUpperCase() || baseCurrency;
  return currency !== baseCurrency;
}

/**
 * 概览里所有行内金额的唯一格式化入口：**一律系统默认货币（账簿本位币）口径**。
 *
 * 外币账户的余额/市值必须先折算，`converted*` 为 null 意味着汇率缺失——这时显示 "-"，
 * 绝不退回原币数字：`$10,000` 直接印成 `10,000.00` 会被当成 ¥10,000（JPY 还和 CNY 共用 ¥ 符号，
 * 更容易看错）。2026-11-12 用户：「外币这块应该显示系统默认货币金额」。
 */
function baseMoneyText(
  raw: number,
  converted: number | null | undefined,
  item: { currency?: string; fxRateMissing?: boolean },
  baseCurrency: string,
) {
  const foreign = isForeign(item, baseCurrency);
  if (foreign && (converted == null || item.fxRateMissing === true)) return "-";
  return formatMoney(converted ?? raw);
}

/**
 * 悬停提示里的原币金额：必须带 ISO 代码。JPY 和 CNY 共用 `¥`、USD 用 `$`，
 * 只写符号会和行内的默认货币金额混看（2026-11-12 用户反馈外币显示问题）。
 */
function originalMoneyText(raw: number, currency: string | undefined) {
  const code = String(currency ?? "").trim().toUpperCase();
  const text = formatCurrencyMoney(raw, currency);
  return code ? `${text} ${code}` : text;
}

function directionalClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "softMuted");
}

function liabilityClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "softMuted", true);
}

function distributionBarClass(index: number) {
  const palette = ["bg-blue-500", "bg-cyan-500", "bg-emerald-500", "bg-amber-500", "bg-slate-400"];
  return palette[index % palette.length];
}

function formatRate(value: number) {
  return formatPercent(value);
}



export function OverviewDashboard({
  netWorth,
  accountTypeTotals,
  assetDistribution,
  monthIncome,
  monthExpense,
  monthlyCashFlow = [],
  accountList,
  creditAccountList,
  liabilityAccountList = [],
  topPositions = [],
  investmentAccountCount,
  insuranceAccountCount,
  investmentMarketValue,
  investmentCost,
  investmentFloatingPnL,
  investmentFloatingPnLRate,
  investmentTotalReturn,
  investmentThisYearProfit,
  fixedAssetAccountList = [],
  fixedAssetCount,
  fixedAssetMarketValue,
  fixedAssetCost,
  fixedAssetFloatingPnL,
  fixedAssetFloatingPnLRate,
  insuranceOverview,
  baseCurrency = "CNY",
  missingFxCurrencies = [],
  isRedUp,
}: OverviewDashboardProps) {
  const totals: AccountTypeTotals = { ...ZERO_TOTALS, ...(accountTypeTotals ?? {}) };
  const { t } = useI18n();
  const investMarketValue = investmentMarketValue ?? totals.investmentMarketValue;
  const investCost = investmentCost ?? totals.investmentCost;
  const investFloatingPnL = investmentFloatingPnL ?? totals.investmentFloatingPnL;
  const investFloatingRate = investmentFloatingPnLRate ?? (investCost > 0 ? investFloatingPnL / investCost : 0);
  const fixedValue = fixedAssetMarketValue ?? totals.fixedAssetMarketValue;
  const fixedCostValue = fixedAssetCost ?? totals.fixedAssetCost;
  const fixedPnL = fixedAssetFloatingPnL ?? fixedValue - fixedCostValue;
  const fixedRate = fixedAssetFloatingPnLRate ?? (fixedCostValue > 0 ? fixedPnL / fixedCostValue : 0);
  const netLiabilities = totals.liabilities - totals.loanReceivable;
  const netLiabilityLabel = netLiabilities >= 0 ? t("overview.netLiability") : t("overview.netCredit");
  const netLiabilityAmount = Math.abs(netLiabilities);
  const netLiabilityClass = netLiabilities >= 0
    ? liabilityClass(netLiabilityAmount, isRedUp)
    : directionalClass(netLiabilityAmount, isRedUp);
  const hasForeignCurrency =
    accountList.some((account) => isForeign(account, baseCurrency)) ||
    liabilityAccountList.some((account) => isForeign(account, baseCurrency)) ||
    fixedAssetAccountList.some((item) => isForeign(item, baseCurrency));
  // 资金账户卡最多列 8 个：去掉行内种类副标题后每行更矮，一屏能多放几个账户
  // （2026-11-13 用户：「显示的账户再多一点，不要显示下面的账户类型」）。
  const topAccounts = accountList
    .slice()
    .sort((a, b) => Math.abs(baseAmount(b)) - Math.abs(baseAmount(a)))
    .slice(0, 8);
  const creditBillOf = (account: CreditAccountItem) => account.convertedCurrentBill ?? account.currentBill;
  const paidOf = (account: CreditAccountItem) => account.convertedPaid ?? account.paid;
  const creditCards = creditAccountList
    .filter((account) => creditBillOf(account) > 0)
    .sort((a, b) => creditBillOf(b) - creditBillOf(a))
    .slice(0, 10);
  const creditBillTotal = creditCards.reduce((sum, account) => sum + Math.max(0, creditBillOf(account)), 0);
  const creditPaidTotal = creditCards.reduce(
    (sum, account) => sum + Math.max(0, Math.min(paidOf(account), Math.max(0, creditBillOf(account)))),
    0,
  );
  const liabilityAccounts = liabilityAccountList.filter((account) => account.balance !== 0);
  // 残值（资产现值）为 0 的固定资产不再占一行：这类空壳账户挂上去只会显示
  // 「0.00 / 0.00 / +0.00%」。上方的现值/成本/增值仍按全部账户统计，
  // 这里只影响明细列表（2026-11-13 用户：「固定资产里残值为 0 的不用显示」）。
  const fixedAssets = fixedAssetAccountList.filter(
    (item) => Math.abs(item.convertedMarketValue ?? item.marketValue) > 0,
  );
  const showInvestmentOverview = investmentAccountCount == null
    ? topPositions.length > 0 || investMarketValue !== 0 || investCost !== 0
    : investmentAccountCount > 0;
  const showInsuranceOverview = insuranceAccountCount == null
    ? (insuranceOverview?.productCount ?? 0) > 0 || totals.insuranceAsset !== 0
    : insuranceAccountCount > 0;
  const showFixedAssetOverview = fixedAssetCount == null
    ? fixedAssetAccountList.length > 0 || fixedValue !== 0 || fixedCostValue !== 0
    : fixedAssetCount > 0;
  const overviewModuleCount =
    1 +
    (showInvestmentOverview ? 1 : 0) +
    (showFixedAssetOverview ? 1 : 0) +
    (showInsuranceOverview ? 1 : 0) +
    (creditCards.length > 0 ? 1 : 0) +
    (liabilityAccounts.length > 0 ? 1 : 0);
  const investmentModuleIndex = showInvestmentOverview ? 0 : -1;
  const dailyModuleIndex = showInvestmentOverview ? 1 : 0;
  const fixedAssetModuleIndex = dailyModuleIndex + 1;
  const insuranceModuleIndex = fixedAssetModuleIndex + (showFixedAssetOverview ? 1 : 0);
  const creditModuleIndex = insuranceModuleIndex + (showInsuranceOverview ? 1 : 0);
  const liabilityModuleIndex = creditModuleIndex + (creditCards.length > 0 ? 1 : 0);
  const moduleClass = (index: number) =>
    `panel-surface ${overviewModuleCount === 3 && index === 0 ? "xl:col-span-2" : ""}`;

  return (
    <>
    <div className="h-full desktop:hidden">
      <MobileOverviewDashboard
        netWorth={netWorth}
        accountTypeTotals={accountTypeTotals}
        assetDistribution={assetDistribution}
        monthIncome={monthIncome}
        monthExpense={monthExpense}
        monthlyCashFlow={monthlyCashFlow}
        accountList={accountList}
        creditAccountList={creditAccountList}
        liabilityAccountList={liabilityAccountList}
        topPositions={topPositions}
        investmentAccountCount={investmentAccountCount}
        insuranceAccountCount={insuranceAccountCount}
        investmentMarketValue={investmentMarketValue}
        investmentCost={investmentCost}
        investmentFloatingPnL={investmentFloatingPnL}
        investmentFloatingPnLRate={investmentFloatingPnLRate}
        fixedAssetAccountList={fixedAssetAccountList}
        fixedAssetCount={fixedAssetCount}
        fixedAssetMarketValue={fixedAssetMarketValue}
        fixedAssetCost={fixedAssetCost}
        fixedAssetFloatingPnL={fixedAssetFloatingPnL}
        fixedAssetFloatingPnLRate={fixedAssetFloatingPnLRate}
        insuranceOverview={insuranceOverview}
        baseCurrency={baseCurrency}
        missingFxCurrencies={missingFxCurrencies}
        isRedUp={isRedUp}
      />
    </div>
    <div className="hidden h-full desktop:flex desktop:flex-col">
    <div className="page-body bg-transparent">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="px-5 py-4 md:px-6">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div>
                <div className="text-xs font-medium tracking-[0.18em] text-slate-400 uppercase">Overview</div>
                <div className="mt-1 text-sm text-slate-500">{t("overview.netWorth")}</div>
                <div className={`mt-1 break-all text-3xl font-semibold md:text-4xl ${directionalClass(netWorth, isRedUp)}`}>
                  {formatMoneyYuan(netWorth)}
                </div>
              </div>
              {missingFxCurrencies.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                  {t("overview.missingFxRateDetail", { currencies: missingFxCurrencies.join("、") })}
                </div>
              ) : hasForeignCurrency ? (
                <div className="text-[11px] text-slate-400">
                  {t("overview.convertedToBase", { currency: baseCurrency })}
                </div>
              ) : null}
            </div>
            {/* 五个指标卡独占整宽一行：挤在净值右侧时每张只有 ~110px，金额一律省略号。 */}
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              <MetricCard label={t("overview.liquidAssets")} value={formatMoneyYuan(totals.liquidAssets)} valueClass={directionalClass(totals.liquidAssets, isRedUp)} />
              <MetricCard label={netLiabilityLabel} value={formatMoneyYuan(netLiabilityAmount)} valueClass={netLiabilityClass} />
              {showInvestmentOverview ? (
                <MetricCard label={t("overview.investMarketValue")} value={formatMoneyYuan(investMarketValue)} valueClass={directionalClass(investMarketValue, isRedUp)} />
              ) : null}
              {showFixedAssetOverview ? (
                <MetricCard label={t("overview.fixedAssetValue")} value={formatMoneyYuan(fixedValue)} valueClass={directionalClass(fixedValue, isRedUp)} />
              ) : null}
              {showInsuranceOverview ? (
                <MetricCard label={t("overview.insuranceCashValue")} value={formatMoneyYuan(totals.insuranceAsset)} valueClass={directionalClass(totals.insuranceAsset, isRedUp)} />
              ) : null}
            </div>
          </div>
        </section>

        {/* 近 12 个月收支：放在页头「Overview」概览卡下方、各资产卡片上方。 */}
        {monthlyCashFlow.length > 0 ? (
          <section className="panel-surface overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <BarChart3 className="h-4 w-4 text-sky-500" />
                {t("overview.last12MonthsCashFlow")}
              </div>
            </div>
            <div className="px-2 py-3 md:px-3">
              <MonthlyCashFlowChart rows={monthlyCashFlow} isRedUp={isRedUp} />
            </div>
          </section>
        ) : null}

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {showInvestmentOverview ? (
            <div className={moduleClass(investmentModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <PiggyBank className="h-4 w-4 text-emerald-500" />
                  {t("overview.investmentOverview")}
                </div>
              </div>
              <div className="space-y-4 px-4 py-4">
                <InvestmentCostProfitBar
                  cost={investCost}
                  floatingPnL={investFloatingPnL}
                />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricCard label={t("overview.investMarketValue")} value={formatMoneyYuan(investMarketValue)} valueClass={directionalClass(investMarketValue, isRedUp)} />
                  <MetricCard label={t("overview.holdingCost")} value={formatMoneyYuan(investCost)} />
                  <MetricCard label={t("overview.floatingPnL")} value={formatMoneyYuan(investFloatingPnL)} valueClass={directionalClass(investFloatingPnL, isRedUp)} />
                  <MetricCard label={t("overview.floatingRate")} value={formatRate(investFloatingRate)} valueClass={directionalClass(investFloatingRate, isRedUp)} />
                  <MetricCard label={t("overview.investTotalReturn")} value={formatMoneyYuan(investmentTotalReturn ?? 0)} valueClass={directionalClass(investmentTotalReturn ?? 0, isRedUp)} />
                  <MetricCard label={t("overview.investThisYearProfit")} value={formatMoneyYuan(investmentThisYearProfit ?? 0)} valueClass={directionalClass(investmentThisYearProfit ?? 0, isRedUp)} />
                </div>
              </div>
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {topPositions.length > 0 ? (
                  topPositions.slice(0, 5).map((item) => (
                    <Link
                      key={item.accountId ?? item.fundCode}
                      href={item.accountId ? `/?accountId=${item.accountId}&view=${getInvestmentAccountView(item)}` : "/investments"}
                      scroll={false}
                      className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-4 py-3 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_96px_96px_72px]"
                    >
                      <div title={item.hoverTitle || undefined} className="truncate text-sm font-semibold text-slate-800">{item.name}</div>
                      <div title={baseMoneyText(item.marketValue, item.convertedMarketValue, item, baseCurrency)} className={`truncate text-right text-xs font-semibold tabular-nums ${directionalClass(item.convertedMarketValue ?? item.marketValue, isRedUp)}`}>{baseMoneyText(item.marketValue, item.convertedMarketValue, item, baseCurrency)}</div>
                      <div title={baseMoneyText(item.floatingPnL, item.convertedFloatingPnL, item, baseCurrency)} className={`hidden truncate text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.convertedFloatingPnL ?? item.floatingPnL, isRedUp)}`}>{baseMoneyText(item.floatingPnL, item.convertedFloatingPnL, item, baseCurrency)}</div>
                      <div className={`hidden text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.floatingPnLRate, isRedUp)}`}>{formatRate(item.floatingPnLRate)}</div>
                    </Link>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-slate-400">{t("overview.noInvestmentPositions")}</div>
                )}
              </div>
            </div>
          ) : null}

          <div className={moduleClass(dailyModuleIndex)}>
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Wallet className="h-4 w-4 text-blue-500" />
                {t("overview.dailyAccounts")}
              </div>
            </div>
            <div className="space-y-4 px-4 py-4">
              <DailyAccountDistributionBar items={assetDistribution} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label={t("overview.cash")} value={formatMoneyYuan(totals.cash)} valueClass={directionalClass(totals.cash, isRedUp)} />
                <MetricCard label={t("overview.debitCard")} value={formatMoneyYuan(totals.bankDebit)} valueClass={directionalClass(totals.bankDebit, isRedUp)} />
                <MetricCard label={t("overview.ewallet")} value={formatMoneyYuan(totals.ewallet)} valueClass={directionalClass(totals.ewallet, isRedUp)} />
                <MetricCard label={t("overview.deposit")} value={formatMoneyYuan(totals.deposit)} valueClass={directionalClass(totals.deposit, isRedUp)} />
              </div>
            </div>
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {topAccounts.length > 0 ? (
                topAccounts.map((account) => (
                  <Link key={account.id} href={`/?accountId=${account.id}&view=detail`} scroll={false} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div
                        title={[
                          account.hoverTitle,
                          isForeign(account, baseCurrency)
                            ? t("overview.originalAmount", { amount: originalMoneyText(account.balance, account.currency) })
                            : null,
                        ].filter(Boolean).join(" · ") || undefined}
                        className="truncate text-sm font-semibold text-slate-800"
                      >
                        {account.name}
                      </div>
                      {/* 行内不再印「现金 / 借记卡 / 钱包 / 存款」这行种类副标题：种类、卡号、
                          币种都还在上面的 title（hoverTitle）里，行压缩后能多列几个账户。 */}
                    </div>
                    <div title={baseMoneyText(account.balance, account.convertedBalance, account, baseCurrency)} className={`max-w-[55%] shrink-0 truncate text-sm font-semibold tabular-nums ${directionalClass(baseAmount(account), isRedUp)}`}>{baseMoneyText(account.balance, account.convertedBalance, account, baseCurrency)}</div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">{t("overview.noDailyAccounts")}</div>
              )}
            </div>
          </div>

          {showFixedAssetOverview ? (
            <div className={moduleClass(fixedAssetModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Building2 className="h-4 w-4 text-slate-500" />
                  {t("overview.fixedAssets")}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-4">
                <MetricCard label={t("overview.fixedAssetValue")} value={formatMoneyYuan(fixedValue)} valueClass={directionalClass(fixedValue, isRedUp)} />
                <MetricCard label={t("overview.fixedAssetCost")} value={formatMoneyYuan(fixedCostValue)} />
                <MetricCard label={t("overview.fixedAssetPnL")} value={formatMoneyYuan(fixedPnL)} valueClass={directionalClass(fixedPnL, isRedUp)} />
                <MetricCard label={t("overview.fixedAssetRate")} value={formatRate(fixedRate)} valueClass={directionalClass(fixedRate, isRedUp)} />
              </div>
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {fixedAssets.length > 0 ? (
                  fixedAssets.slice(0, 5).map((item) => (
                    <Link
                      key={item.accountId}
                      href={`/?accountId=${item.accountId}&view=investproperty`}
                      scroll={false}
                      className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-4 py-3 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_96px_96px_72px]"
                    >
                      <div className="min-w-0">
                        <div
                          title={[
                            item.hoverTitle,
                            isForeign(item, baseCurrency)
                              ? t("overview.originalAmount", { amount: originalMoneyText(item.marketValue, item.currency) })
                              : null,
                          ].filter(Boolean).join(" · ") || undefined}
                          className="truncate text-sm font-semibold text-slate-800"
                        >
                          {item.name}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-slate-400">
                          {item.assetType ? t(`fixedAsset.type.${item.assetType}`) : t("account.kind.fixed_asset")}
                        </div>
                      </div>
                      <div title={baseMoneyText(item.marketValue, item.convertedMarketValue, item, baseCurrency)} className={`truncate text-right text-xs font-semibold tabular-nums ${directionalClass(item.convertedMarketValue ?? item.marketValue, isRedUp)}`}>{baseMoneyText(item.marketValue, item.convertedMarketValue, item, baseCurrency)}</div>
                      <div title={formatMoney(item.floatingPnL)} className={`hidden truncate text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.floatingPnL, isRedUp)}`}>{formatMoney(item.floatingPnL)}</div>
                      <div className={`hidden text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.floatingPnLRate, isRedUp)}`}>{formatRate(item.floatingPnLRate)}</div>
                    </Link>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-slate-400">{t("overview.noFixedAssets")}</div>
                )}
              </div>
            </div>
          ) : null}

          {showInsuranceOverview ? (
            <InsuranceOverviewCard className={moduleClass(insuranceModuleIndex)} insuranceOverview={insuranceOverview} isRedUp={isRedUp} />
          ) : null}

          {creditCards.length > 0 && (
            <div className={moduleClass(creditModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CreditCard className="h-4 w-4 text-amber-500" />
                  {t("overview.creditCards")}
                </div>
              </div>
              <div className="space-y-4 px-4 py-4">
                <CreditBillProgressBar bill={creditBillTotal} paid={creditPaidTotal} />
              </div>
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {creditCards.map((account) => (
                  <Link
                    key={account.id}
                    href={`/?accountId=${account.id}&view=bill`}
                    scroll={false}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div title={account.hoverTitle || undefined} className="truncate text-sm font-semibold text-slate-800">{account.name}</div>
                    </div>
                    <div title={formatMoney(creditBillOf(account))} className={`max-w-[55%] shrink-0 truncate text-sm font-semibold tabular-nums ${liabilityClass(creditBillOf(account), isRedUp)}`}>{formatMoney(creditBillOf(account))}</div>
                  </Link>
                ))}
                {creditCards.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">{t("overview.noCreditBills")}</div>
                )}
              </div>
            </div>
          )}

          {liabilityAccounts.length > 0 && (
            <div className={moduleClass(liabilityModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <HandCoins className="h-4 w-4 text-rose-500" />
                  {t("overview.settlementNet")}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-3">
                <MetricCard label={t("overview.iOwe")} value={formatMoneyYuan(-totals.loan)} valueClass={directionalClass(-totals.loan, isRedUp)} />
                <MetricCard label={t("overview.owedToMe")} value={formatMoneyYuan(totals.loanReceivable)} valueClass={directionalClass(totals.loanReceivable, isRedUp)} />
                <MetricCard label={t("overview.accountCount")} value={t("overview.accountCountValue", { count: liabilityAccounts.length })} />
              </div>
              <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2">
                {liabilityAccounts.slice(0, 4).map((account) => (
                  <Link
                    key={account.id}
                    href={`/?accountId=${account.id}&view=detail`}
                    scroll={false}
                    className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-3 transition-colors hover:border-rose-200 hover:bg-rose-50/30"
                  >
                    <div
                      title={[
                        account.hoverTitle,
                        isForeign(account, baseCurrency)
                          ? t("overview.originalAmount", { amount: originalMoneyText(account.balance, account.currency) })
                          : null,
                      ].filter(Boolean).join(" · ") || undefined}
                      className="line-clamp-2 min-h-[40px] text-sm font-semibold leading-5 text-slate-800"
                    >
                      {account.name}
                    </div>
                    {/* 往来款行只显示金额：负数=我欠别人，正数=别人欠我（2026-11-12 用户：
                        不要显示「我欠别人 / 别人欠我」这种文字，方向看金额正负号就够）。 */}
                    <div title={baseMoneyText(account.balance, account.convertedBalance, account, baseCurrency)} className={`mt-3 truncate text-base font-semibold tabular-nums ${directionalClass(baseAmount(account), isRedUp)}`}>{baseMoneyText(account.balance, account.convertedBalance, account, baseCurrency)}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

      </div>
    </div>
    </div>
    </>
  );
}

function MetricCard({ label, value, valueClass = "text-slate-900" }: { label: string; value: string; valueClass?: string }) {
  return (
    // 指标卡在 `grid-cols-2 / md:grid-cols-4` 里最窄只有 ~90px，七位数的金额（`¥1,234,567.89`）
    // 放不下一行——一律单行截断成 `¥1,234…`，`title` 带完整金额，悬停即可看全
    // （2026-11-12 用户：「概览窗口里的数字经常超出卡片看不到」）。
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="truncate text-xs text-slate-500" title={label}>{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold tabular-nums ${valueClass}`} title={value}>{value}</div>
    </div>
  );
}

function InvestmentCostProfitBar({
  cost,
  floatingPnL,
}: {
  cost: number;
  floatingPnL: number;
}) {
  const pnlAbs = Math.abs(floatingPnL);
  const total = cost + pnlAbs;
  const costPct = total > 0 ? Math.max(0, Math.min(100, (cost / total) * 100)) : 0;
  const pnlPct = total > 0 ? 100 - costPct : 0;
  const { t } = useI18n();
  const isLoss = floatingPnL < 0;
  const pnlLabel = isLoss ? t("overview.loss") : t("overview.profit");
  const pnlClass = isLoss ? "bg-emerald-500" : "bg-red-500";

  if (total <= 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-400">
        {t("overview.noInvestmentDistribution")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        <div
          className="bg-slate-900 transition-all"
          style={{ width: `${Math.max(costPct, cost > 0 ? 2 : 0)}%` }}
          title={t("overview.costTitle", { amount: formatMoneyYuan(cost) })}
        />
        <div
          className={`${pnlClass} transition-all`}
          style={{ width: `${Math.max(pnlPct, pnlAbs > 0 ? 2 : 0)}%` }}
          title={t("overview.pnlTitle", { label: pnlLabel, amount: formatMoneyYuan(floatingPnL) })}
        />
      </div>
      <div className="flex items-center gap-4 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-slate-900" />
          {t("overview.holdingCost")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className={`h-2 w-2 rounded-full ${pnlClass}`} />
          {pnlLabel}
        </span>
      </div>
    </div>
  );
}

function DailyAccountDistributionBar({ items }: { items: AssetDistItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-400">
        {t("overview.noDailyDistribution")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {items.map((item, index) => (
          <div
            key={item.kind}
            className={`${distributionBarClass(index)} transition-all`}
            style={{ width: `${Math.max(item.pct, 2)}%` }}
            title={`${item.label}: ${formatMoneyYuan(item.value)} (${item.pct.toFixed(1)}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {items.map((item, index) => (
          <span key={item.kind} className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${distributionBarClass(index)}`} />
            <span>{item.label}</span>
            <span className="tabular-nums text-slate-400">{item.pct.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CreditBillProgressBar({
  bill,
  paid,
  compact = false,
}: {
  bill: number;
  paid: number;
  compact?: boolean;
}) {
  const safeBill = Math.max(0, bill);
  const safePaid = Math.max(0, Math.min(paid, safeBill));
  const remain = Math.max(0, safeBill - safePaid);
  const paidPct = safeBill > 0 ? (safePaid / safeBill) * 100 : 0;
  const remainPct = safeBill > 0 ? (remain / safeBill) * 100 : 0;
  const { t } = useI18n();

  if (safeBill <= 0) {
    return (
      <div className={`rounded-lg border border-dashed border-slate-200 bg-slate-50/80 text-slate-400 ${compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"}`}>
        {t("overview.noBillProgress")}
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        <div
          className="bg-emerald-500 transition-all"
          style={{ width: `${Math.max(paidPct, safePaid > 0 ? 2 : 0)}%` }}
          title={t("overview.paidTitle", { amount: formatMoneyYuan(safePaid) })}
        />
        <div
          className="bg-amber-500 transition-all"
          style={{ width: `${Math.max(remainPct, remain > 0 ? 2 : 0)}%` }}
          title={t("overview.remainTitle", { amount: formatMoneyYuan(remain) })}
        />
      </div>
      {!compact && (
        <div className="flex items-center gap-4 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            {t("overview.currentBill")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {t("overview.paidAmount")}
          </span>
        </div>
      )}
    </div>
  );
}
