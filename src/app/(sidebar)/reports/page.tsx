import Link from "next/link";
import { cookies } from "next/headers";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { TransactionType } from "@prisma/client";

import { InvestmentProfitReport } from "@/components/InvestmentProfitReport";
import {
  InvestmentProfitScopeSelect,
  type InvestmentProfitScopeOption,
} from "@/components/InvestmentProfitScopeSelect";
import { MissingFundNavPrompt } from "@/components/MissingFundNavPrompt";
import { IncomeExpenseReportClient } from "@/components/IncomeExpenseReportClient";
import { buildCategorySmartSelectOptions } from "@/components/categorySmartSelect";
import { ReportTransactionEditHost } from "@/components/ReportTransactionEditHost";
import { ReportSelector } from "@/components/ReportSelector";
import type { ReportItem } from "@/components/ReportSelector";
import { ReportRefreshButton } from "@/components/ReportRefreshButton";
import { StockHoldingReport } from "@/components/StockHoldingReport";
import { buildAccountDisplayOption, buildGroupedAccountOptions, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { kindLabel } from "@/lib/account-kinds";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc } from "@/lib/date-utils";
import type { ColorScheme } from "@/lib/client/colors";
import {
  getIncomeExpenseReport,
  type IncomeExpenseGroupBy,
  type IncomeExpenseReportDetailType,
  type IncomeExpenseReportRow,
} from "@/lib/server/income-expense-report";
import { loadInvestmentProfitReport, type InvestmentProfitPeriod } from "@/lib/server/investment-profit-report";
import { loadCommonData, loadCachedStockHoldingReport } from "@/lib/server/cached-data";
import { stockMarketLabel } from "@/lib/stock/market";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadReportDetailEntries } from "@/lib/server/report-detail-entries";
import { getServerDisplayLanguage, getServerT } from "@/lib/server/i18n";

export const dynamic = "force-dynamic";

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsvDataUri(rows: string[][]) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;
}

function parseMonthUtc(value: string | undefined, fallback: Date) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return fallback;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return fallback;
  return new Date(Date.UTC(year, month - 1, 1));
}

function endOfMonthUtc(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

function parseYear(value: string | undefined) {
  const year = Number(String(value ?? "").trim());
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

const PROFIT_SCOPE_ALL = "all";
const NO_INSTITUTION_SCOPE_ID = "__none__";

function normalizeProfitScope(value: string | undefined) {
  const raw = String(value ?? "").trim();
  return raw || PROFIT_SCOPE_ALL;
}

function investmentAccountScope(accountId: string) {
  return `account:${accountId}`;
}

function investmentInstitutionScope(institutionId: string | null | undefined) {
  return `institution:${institutionId || NO_INSTITUTION_SCOPE_ID}`;
}

function rowCsv(section: "income" | "expense", row: IncomeExpenseReportRow, t: (key: string) => string) {
  return [
    section === "income" ? t("reports.income") : t("reports.expense"),
    `${"  ".repeat(row.depth)}${systemCategoryLabel(row.name, t)}`,
    ...row.values.map((value) => value.toFixed(2)),
    row.total.toFixed(2),
  ];
}

type ReportType = "income-expense" | "investment-profit" | "stock-holdings";

function reportMenuItems(
  currentType: ReportType,
  investmentHref: string,
  stockHref: string,
  t: (key: string) => string,
): ReportItem[] {
  return [
    { value: "income-expense", label: t("reports.menu.incomeExpense"), href: "/reports" },
    { value: "investment-profit", label: t("reports.menu.investmentProfit"), href: investmentHref },
    { value: "stock-holdings", label: t("reports.menu.stockHoldings"), href: stockHref },
  ];
}

function buildReportHref(
  reportType: ReportType,
  profitPeriod?: InvestmentProfitPeriod,
  profitYear?: number,
  profitMonth?: number,
  profitScope?: string,
) {
  const query = new URLSearchParams();
  if (reportType === "investment-profit") {
    query.set("report", reportType);
    query.set("profitPeriod", profitPeriod ?? "day");
    if (profitYear) query.set("profitYear", String(profitYear));
    if (profitMonth) query.set("profitMonth", String(profitMonth));
    const normalizedScope = normalizeProfitScope(profitScope);
    if (normalizedScope !== PROFIT_SCOPE_ALL) query.set("profitScope", normalizedScope);
  }
  if (reportType === "stock-holdings") {
    query.set("report", reportType);
    const normalizedScope = normalizeProfitScope(profitScope);
    if (normalizedScope !== PROFIT_SCOPE_ALL) query.set("profitScope", normalizedScope);
  }
  return `/reports${query.toString() ? `?${query.toString()}` : ""}`;
}

function parseMonthNumber(value: string | undefined, fallback: number) {
  const month = Number(String(value ?? "").trim());
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : fallback;
}

function shiftProfitWindow(period: InvestmentProfitPeriod, year: number, month: number, delta: number) {
  if (period === "day") {
    const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
  }
  if (period === "month") return { year: year + delta, month };
  return { year, month };
}

function presetQuery(params: {
  start: string;
  end: string;
  accountId: string;
  groupBy: IncomeExpenseGroupBy;
}) {
  const query = new URLSearchParams();
  if (params.accountId) query.set("accountId", params.accountId);
  query.set("groupBy", params.groupBy);
  if (params.groupBy === "month") {
    query.set("startMonth", params.start.slice(0, 7));
    query.set("endMonth", params.end.slice(0, 7));
  } else {
    query.set("startYear", params.start.slice(0, 4));
    query.set("endYear", params.end.slice(0, 4));
  }
  return `/reports?${query.toString()}`;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getServerT();
  const language = await getServerDisplayLanguage();
  const now = new Date();
  const reportType: ReportType =
    params.report === "investment-profit" || params.report === "stock-holdings"
      ? params.report
      : "income-expense";
  const profitPeriod: InvestmentProfitPeriod =
    params.profitPeriod === "month" || params.profitPeriod === "year" ? params.profitPeriod : "day";
  const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const groupBy = params.groupBy === "year" ? "year" : "month";
  const rawStartMonth = typeof params.startMonth === "string"
    ? params.startMonth
    : typeof params.start === "string"
      ? params.start.slice(0, 7)
      : undefined;
  const rawEndMonth = typeof params.endMonth === "string"
    ? params.endMonth
    : typeof params.end === "string"
      ? params.end.slice(0, 7)
      : undefined;
  const requestedStartMonth = parseMonthUtc(rawStartMonth, defaultStart);
  const requestedEndMonth = parseMonthUtc(rawEndMonth, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  let requestedStart = requestedStartMonth;
  let requestedEnd = endOfMonthUtc(requestedEndMonth);
  const rawStartYear = typeof params.startYear === "string"
    ? params.startYear
    : typeof params.start === "string"
      ? params.start.slice(0, 4)
      : undefined;
  const rawEndYear = typeof params.endYear === "string"
    ? params.endYear
    : typeof params.end === "string"
      ? params.end.slice(0, 4)
      : undefined;
  const selectedAccountId = typeof params.accountId === "string" ? params.accountId.trim() : "";
  const rawDetailType = typeof params.detailType === "string" ? params.detailType : "";
  const detailType: IncomeExpenseReportDetailType | null =
    rawDetailType === "income" || rawDetailType === "expense" || rawDetailType === "net"
      ? rawDetailType
      : null;
  const detailCategoryKey =
    typeof params.detailCategoryKey === "string" ? params.detailCategoryKey.trim() : "";
  const detailColumnKey =
    typeof params.detailColumnKey === "string" ? params.detailColumnKey.trim() : "";
  const cookieStore = await cookies();
  const colorScheme = (cookieStore.get("colorScheme")?.value === "green_up_red_down"
    ? "green_up_red_down"
    : "red_up_green_down") satisfies ColorScheme;
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const ctx = await getHouseholdScope();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const profitYear = parseYear(typeof params.profitYear === "string" ? params.profitYear : undefined) ?? currentYear;
  const profitMonth = parseMonthNumber(
    typeof params.profitMonth === "string" ? params.profitMonth : undefined,
    currentMonth,
  );
  const rawProfitScope = normalizeProfitScope(typeof params.profitScope === "string" ? params.profitScope : undefined);

  const commonData = await loadCommonData(ctx.hidFilter);
  const allAccountRecords = commonData.accounts.filter((account) =>
    account.isActive && account.isPlaceholder !== true && account.name !== "未指定账户",
  );
  const accountRecords = allAccountRecords.filter((account) => !isPureInvestmentAccount(account));
  const allAccountDisplayOptions = allAccountRecords.map((account) =>
    buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelTemplate),
  );
  const allAccountDisplayById = new Map(allAccountDisplayOptions.map((account) => [account.id, account]));
  const accountDisplayOptions = accountRecords.map((account) => allAccountDisplayById.get(account.id)!).filter(Boolean);
  const accountDisplayById = new Map(accountDisplayOptions.map((account) => [account.id, account]));
  const accounts = accountRecords.map((account) => ({
    id: account.id,
    label: accountDisplayById.get(account.id)?.label ?? account.name,
    title: accountDisplayById.get(account.id)?.hoverTitle,
    subLabel: kindLabel(account.kind),
    kind: account.kind,
    investProductType: account.investProductType,
    debtDirection: account.debtDirection,
    institutionId: account.institutionId,
    currency: account.currency,
  }));
  const accountSSOptions = buildGroupedAccountOptions(accountDisplayOptions);
  const cashAccounts = accounts.filter((account) => ["cash", "bank_debit", "ewallet"].includes(account.kind));
  const cashAccountIds = new Set(cashAccounts.map((account) => account.id));
  const investmentAccountRecords = allAccountRecords.filter(isPureInvestmentAccount);
  const stockAccountRecords = investmentAccountRecords.filter((account) => account.investProductType === "stock");
  const investmentAccounts = investmentAccountRecords.map((account) => ({
    id: account.id,
    label: allAccountDisplayById.get(account.id)?.label ?? account.name,
    title: allAccountDisplayById.get(account.id)?.hoverTitle,
    subLabel: kindLabel(account.kind),
    kind: account.kind,
    investProductType: account.investProductType,
    debtDirection: account.debtDirection,
    institutionId: account.institutionId,
    currency: account.currency,
  }));
  const investmentAccountIds = new Set(investmentAccounts.map((account) => account.id));
  const cashAccountSSOptions = buildGroupedAccountOptions(
    allAccountDisplayOptions.filter((account) => cashAccountIds.has(account.id)),
  );
  const investmentAccountSSOptions = buildGroupedAccountOptions(
    allAccountDisplayOptions.filter((account) => investmentAccountIds.has(account.id)),
  );
  const institutionScopeByValue = new Map<string, {
    value: string;
    label: string;
    ids: string[];
    sortLabel: string;
    title: string;
  }>();

  for (const account of investmentAccountRecords) {
    const value = investmentInstitutionScope(account.institutionId);
    const institutionName =
      account.Institution?.shortName?.trim()
      || account.Institution?.name?.trim()
      || t("reports.noInstitution");
    const existing = institutionScopeByValue.get(value) ?? {
      value,
      label: t("reports.scopeByInstitution", { name: institutionName }),
      ids: [],
      sortLabel: institutionName,
      title: "",
    };
    existing.ids.push(account.id);
    institutionScopeByValue.set(value, existing);
  }

  const institutionScopeRows = Array.from(institutionScopeByValue.values())
    .map((option) => ({
      ...option,
      title: t("reports.institutionScopeTitle", { label: option.label, count: option.ids.length }),
    }))
    .sort((a, b) => a.sortLabel.localeCompare(b.sortLabel, "zh-Hans-CN"));
  const validProfitScopes = new Set<string>([
    PROFIT_SCOPE_ALL,
    ...institutionScopeRows.map((option) => option.value),
    ...investmentAccountRecords.map((account) => investmentAccountScope(account.id)),
  ]);
  const selectedProfitScope = validProfitScopes.has(rawProfitScope) ? rawProfitScope : PROFIT_SCOPE_ALL;
  const investmentAccountIdsForReport = (() => {
    if (selectedProfitScope.startsWith("account:")) {
      const accountId = selectedProfitScope.slice("account:".length);
      return investmentAccountIds.has(accountId) ? [accountId] : undefined;
    }
    if (selectedProfitScope.startsWith("institution:")) {
      return institutionScopeByValue.get(selectedProfitScope)?.ids;
    }
    return undefined;
  })();
  const currentInvestmentHref = buildReportHref(
    "investment-profit",
    profitPeriod,
    profitYear,
    profitMonth,
    selectedProfitScope,
  );
  const currentStockHref = buildReportHref(
    "stock-holdings",
    undefined,
    undefined,
    undefined,
    selectedProfitScope,
  );
  const allInvestmentScopeOption: InvestmentProfitScopeOption = {
    value: PROFIT_SCOPE_ALL,
    label: t("reports.allInvestmentAccounts"),
    href: buildReportHref("investment-profit", profitPeriod, profitYear, profitMonth, PROFIT_SCOPE_ALL),
  };
  const investmentInstitutionScopeOptions: InvestmentProfitScopeOption[] = institutionScopeRows.map((option) => ({
    value: option.value,
    label: option.label,
    href: buildReportHref("investment-profit", profitPeriod, profitYear, profitMonth, option.value),
    title: option.title,
  }));
  const investmentAccountScopeOptions: InvestmentProfitScopeOption[] = investmentAccountRecords
    .map((account) => {
      const display = allAccountDisplayById.get(account.id);
      const label = [display?.groupName, display?.label ?? account.name].filter(Boolean).join(" / ");
      return {
        value: investmentAccountScope(account.id),
        label: t("reports.scopeByAccount", { name: label }),
        href: buildReportHref("investment-profit", profitPeriod, profitYear, profitMonth, investmentAccountScope(account.id)),
        title: display?.hoverTitle,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));

  if (reportType === "investment-profit") {
    const investmentReport = await loadInvestmentProfitReport(ctx, {
      period: profitPeriod,
      year: profitYear,
      month: profitMonth,
      accountIds: investmentAccountIdsForReport,
    }, language);
    const periodHref = (period: InvestmentProfitPeriod) =>
      buildReportHref("investment-profit", period, profitYear, profitMonth, selectedProfitScope);
    const previousWindow = shiftProfitWindow(profitPeriod, profitYear, profitMonth, -1);
    const nextWindow = shiftProfitWindow(profitPeriod, profitYear, profitMonth, 1);
    const previousHref = buildReportHref(
      "investment-profit",
      profitPeriod,
      previousWindow.year,
      previousWindow.month,
      selectedProfitScope,
    );
    const nextHref = buildReportHref(
      "investment-profit",
      profitPeriod,
      nextWindow.year,
      nextWindow.month,
      selectedProfitScope,
    );
    const rangeLabel = profitPeriod === "day"
      ? t("reports.rangeLabelDay", { year: profitYear, month: profitMonth })
      : profitPeriod === "month"
        ? t("reports.rangeLabelMonth", { year: profitYear })
        : t("reports.rangeLabelYear", { year: currentYear });
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex h-12 items-center justify-between px-4">
            <div className="text-sm page-title">{t("reports.page.title")}</div>
            <div className="flex items-center gap-2">
              <ReportSelector
                currentType="investment-profit"
                items={reportMenuItems("investment-profit", currentInvestmentHref, currentStockHref, t)}
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-1 pb-2">
              <div className="flex shrink-0 items-center gap-1">
                <div className="flex items-center gap-1">
                  {(["day", "month", "year"] as InvestmentProfitPeriod[]).map((period) => (
                    <Link
                      key={period}
                      href={periodHref(period)}
                      scroll={false}
                      className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition ${
                        profitPeriod === period
                          ? "bg-slate-900 text-white shadow-sm"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {period === "day" ? t("reports.period.day") : period === "month" ? t("reports.period.month") : t("reports.period.year")}
                    </Link>
                  ))}
                </div>
                {profitPeriod !== "year" ? (
                  <Link
                    href={previousHref}
                    scroll={false}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    title={profitPeriod === "day" ? t("reports.prevMonth") : t("reports.prevYear")}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Link>
                ) : null}
                <span className="min-w-24 text-center text-xs font-medium text-slate-500">{rangeLabel}</span>
                {profitPeriod !== "year" ? (
                  <Link
                    href={nextHref}
                    scroll={false}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    title={profitPeriod === "day" ? t("reports.nextMonth") : t("reports.nextYear")}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                ) : null}
              </div>
              <InvestmentProfitScopeSelect
                selectedScope={selectedProfitScope}
                allOption={allInvestmentScopeOption}
                institutionOptions={investmentInstitutionScopeOptions}
                accountOptions={investmentAccountScopeOptions}
              />
              <ReportRefreshButton />
              <MissingFundNavPrompt items={investmentReport.missingNavs} className="ml-auto" />
            </div>
            <InvestmentProfitReport
              period={profitPeriod}
              year={profitYear}
              month={profitMonth}
              rows={investmentReport.rows}
              totals={investmentReport.totals}
              isRedUp={colorScheme === "red_up_green_down"}
            />
          </div>
        </div>
      </div>
    );
  }

  if (reportType === "stock-holdings") {
    const stockAccountIds = new Set(stockAccountRecords.map((account) => account.id));
    const institutionScopeByStockValue = new Map<string, {
      value: string;
      label: string;
      ids: string[];
      sortLabel: string;
      title: string;
    }>();
    for (const account of stockAccountRecords) {
      const value = investmentInstitutionScope(account.institutionId);
      const institutionName =
        account.Institution?.shortName?.trim()
        || account.Institution?.name?.trim()
        || t("reports.noInstitution");
      const existing = institutionScopeByStockValue.get(value) ?? {
        value,
        label: t("reports.scopeByInstitution", { name: institutionName }),
        ids: [],
        sortLabel: institutionName,
        title: "",
      };
      existing.ids.push(account.id);
      institutionScopeByStockValue.set(value, existing);
    }
    const stockInstitutionScopeRows = Array.from(institutionScopeByStockValue.values())
      .map((option) => ({
        ...option,
        title: t("reports.institutionScopeTitle", { label: option.label, count: option.ids.length }),
      }))
      .sort((a, b) => a.sortLabel.localeCompare(b.sortLabel, "zh-Hans-CN"));
    const validStockScopes = new Set<string>([
      PROFIT_SCOPE_ALL,
      ...stockInstitutionScopeRows.map((option) => option.value),
      ...stockAccountRecords.map((account) => investmentAccountScope(account.id)),
    ]);
    const selectedStockScope = validStockScopes.has(rawProfitScope) ? rawProfitScope : PROFIT_SCOPE_ALL;
    const stockAccountIdsForReport = (() => {
      if (selectedStockScope.startsWith("account:")) {
        const accountId = selectedStockScope.slice("account:".length);
        return stockAccountIds.has(accountId) ? [accountId] : undefined;
      }
      if (selectedStockScope.startsWith("institution:")) {
        return institutionScopeByStockValue.get(selectedStockScope)?.ids;
      }
      return undefined;
    })();
    const stockReport = await loadCachedStockHoldingReport(
      JSON.stringify(ctx.hidFilter),
      JSON.stringify(stockAccountIdsForReport ?? []),
    );
    const allStockScopeOption: InvestmentProfitScopeOption = {
      value: PROFIT_SCOPE_ALL,
      label: t("reports.allStockAccounts"),
      href: buildReportHref("stock-holdings", undefined, undefined, undefined, PROFIT_SCOPE_ALL),
    };
    const stockInstitutionScopeOptions: InvestmentProfitScopeOption[] = stockInstitutionScopeRows.map((option) => ({
      value: option.value,
      label: option.label,
      href: buildReportHref("stock-holdings", undefined, undefined, undefined, option.value),
      title: option.title,
    }));
    const stockAccountScopeOptions: InvestmentProfitScopeOption[] = stockAccountRecords
      .map((account) => {
        const display = allAccountDisplayById.get(account.id);
        const label = [display?.groupName, display?.label ?? account.name].filter(Boolean).join(" / ");
        return {
          value: investmentAccountScope(account.id),
          label: t("reports.scopeByAccount", { name: label }),
          href: buildReportHref("stock-holdings", undefined, undefined, undefined, investmentAccountScope(account.id)),
          title: display?.hoverTitle,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    const stockExportHref = buildCsvDataUri([
      [
        t("reports.stock.market"),
        t("reports.stock.code"),
        t("reports.stock.name"),
        t("reports.account"),
        t("reports.stock.quantity"),
        t("reports.stock.avgCost"),
        t("reports.stock.cost"),
        t("reports.stock.closePrice"),
        t("reports.stock.marketValue"),
        t("reports.stock.floatingPnL"),
        t("reports.stock.floatingPnLRate"),
        t("reports.stock.realizedProfit"),
        t("reports.stock.totalProfit"),
      ],
      ...stockReport.rows.map((row) => [
        stockMarketLabel(row.market),
        row.stockCode,
        row.stockName,
        row.accountName,
        String(row.quantity),
        row.avgCost.toFixed(4),
        row.cost.toFixed(2),
        row.latestPrice == null ? "" : row.latestPrice.toFixed(4),
        row.marketValue.toFixed(2),
        row.floatingPnL.toFixed(2),
        (row.floatingPnLRate * 100).toFixed(2),
        row.historicalProfit.toFixed(2),
        row.totalProfit.toFixed(2),
      ]),
      [
        t("reports.total"),
        "",
        "",
        "",
        String(stockReport.totals.quantity),
        "",
        stockReport.totals.cost.toFixed(2),
        "",
        stockReport.totals.marketValue.toFixed(2),
        stockReport.totals.floatingPnL.toFixed(2),
        (stockReport.totals.floatingPnLRate * 100).toFixed(2),
        stockReport.totals.historicalProfit.toFixed(2),
        stockReport.totals.totalProfit.toFixed(2),
      ],
    ]);

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex h-12 items-center justify-between px-4">
            <div className="text-sm page-title">{t("reports.menu.stockHoldings")}</div>
            <div className="flex items-center gap-2">
              <ReportSelector
                currentType="stock-holdings"
                items={reportMenuItems("stock-holdings", currentInvestmentHref, currentStockHref, t)}
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-1 pb-2">
              <InvestmentProfitScopeSelect
                selectedScope={selectedStockScope}
                allOption={allStockScopeOption}
                institutionOptions={stockInstitutionScopeOptions}
                accountOptions={stockAccountScopeOptions}
              />
              <ReportRefreshButton />
              <a
                href={stockExportHref}
                download={`${t("reports.filename.stockHoldings")}.csv`}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                title={t("reports.exportStockTitle")}
              >
                <Download className="h-3.5 w-3.5" />
                {t("reports.export")}
              </a>
            </div>
            <StockHoldingReport
              rows={stockReport.rows}
              totals={stockReport.totals}
              isRedUp={colorScheme === "red_up_green_down"}
            />
          </div>
        </div>
      </div>
    );
  }

  const editCategories = commonData.categories.filter((category) =>
    category.type === "income" || category.type === "expense",
  );
  const editTags = commonData.tags;
  const editGroups = commonData.groups;
  const editInstitutions = commonData.institutions;
  const editCounterparties = commonData.counterparties;
  const expenseCategories = editCategories
    .filter((category) => category.type === "expense")
    .map((category) => ({
      id: category.id,
      label: category.name,
      parentId: category.parentId,
      type: category.type,
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
    }));
  const incomeCategories = editCategories
    .filter((category) => category.type === "income")
    .map((category) => ({
      id: category.id,
      label: category.name,
      parentId: category.parentId,
      type: category.type,
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
    }));
  const nestedFieldData = {
    groupId: editGroups.map((group) => ({ id: group.id, name: group.name })),
    institutionId: editInstitutions.map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? "" })),
    counterpartyId: editCounterparties.map((counterparty) => ({
      id: counterparty.id,
      name: counterparty.shortName?.trim() || counterparty.name,
      type: counterparty.type,
    })),
  };

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
  let availableYears: number[] = [];
  if (groupBy === "year") {
    const bounds = await prisma.txRecord.aggregate({
      where: {
        ...ctx.hidFilter,
        deletedAt: null,
        type: { in: [TransactionType.income, TransactionType.expense, TransactionType.investment] },
        ...(selectedAccount
          ? { OR: [{ accountId: selectedAccount.id }, { toAccountId: selectedAccount.id }] }
          : {}),
      },
      _min: { date: true },
      _max: { date: true },
    });
    const firstYear = bounds._min.date?.getUTCFullYear() ?? now.getUTCFullYear();
    const lastYear = bounds._max.date?.getUTCFullYear() ?? firstYear;
    availableYears = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
    const selectedStartYear = Math.min(lastYear, Math.max(firstYear, parseYear(rawStartYear) ?? firstYear));
    const selectedEndYear = Math.min(lastYear, Math.max(firstYear, parseYear(rawEndYear) ?? lastYear));
    const rangeStartYear = Math.min(selectedStartYear, selectedEndYear);
    const rangeEndYear = Math.max(selectedStartYear, selectedEndYear);
    requestedStart = new Date(Date.UTC(rangeStartYear, 0, 1));
    requestedEnd = new Date(Date.UTC(rangeEndYear, 11, 31));
  }
  const report = await getIncomeExpenseReport(ctx, {
    start: formatDateUtc(requestedStart),
    end: formatDateUtc(requestedEnd),
    groupBy,
    accountIds: selectedAccount ? [selectedAccount.id] : undefined,
    detail: detailType
      ? {
          type: detailType,
          categoryKey: detailCategoryKey || undefined,
          columnKey: detailColumnKey || undefined,
        }
      : undefined,
  });

  const detailEntryIds = report.details
    ? [...new Set(report.details.rows.map((row) => row.entryId))]
    : [];
  const detailEntries = await loadReportDetailEntries(ctx, detailEntryIds);
  const investmentProductTypeByAccountId = Object.fromEntries(
    allAccountRecords.map((account) => [account.id, account.investProductType]),
  );

  const exportRows = [
    [t("reports.scope"), `${report.start} ~ ${report.end}`],
    [t("reports.account"), selectedAccount?.label ?? t("reports.allAccounts")],
    [t("reports.granularity"), report.groupBy === "year" ? t("reports.period.year") : t("reports.period.month")],
    [],
    [t("reports.type"), t("reports.category"), ...report.columns.map((column) => column.label), t("reports.total")],
    [t("reports.income"), t("reports.incomeTotal"), ...report.income.periodTotals.map((value) => value.toFixed(2)), report.income.total.toFixed(2)],
    ...report.income.rows.map((row) => rowCsv("income", row, t)),
    [t("reports.expense"), t("reports.expenseTotal"), ...report.expense.periodTotals.map((value) => value.toFixed(2)), report.expense.total.toFixed(2)],
    ...report.expense.rows.map((row) => rowCsv("expense", row, t)),
    [t("reports.net"), t("reports.net"), ...report.netPeriodTotals.map((value) => value.toFixed(2)), report.netTotal.toFixed(2)],
  ];
  const exportHref = buildCsvDataUri(exportRows);
  const exportFilename = `${t("reports.filename.incomeExpense")}-${report.start}-${report.end}${selectedAccount ? `-${selectedAccount.label}` : ""}.csv`;
  const currentReportQuery = {
    start: report.start,
    end: report.end,
    accountId: selectedAccount?.id ?? "",
    groupBy: report.groupBy,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="page-header">
        <div className="flex h-12 items-center justify-between px-4">
          <div className="text-sm page-title">{t("reports.page.title")}</div>
          <div className="flex items-center gap-2">
            <ReportSelector
              currentType="income-expense"
              items={reportMenuItems(
                "income-expense",
                buildReportHref("investment-profit", "day", currentYear, currentMonth),
                buildReportHref("stock-holdings"),
                t,
              )}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <form className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-slate-200 bg-white px-1" method="get">
              <input type="hidden" name="groupBy" value={report.groupBy} />
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-xs font-medium text-slate-500">{t("reports.groupBy")}</span>
                <div className="inline-flex h-8 overflow-hidden rounded-md border border-slate-200 bg-white text-xs">
                  <Link
                    href={presetQuery({ ...currentReportQuery, groupBy: "year" })}
                    className={`flex items-center px-2.5 ${report.groupBy === "year" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    {t("reports.year")}
                  </Link>
                  <Link
                    href={presetQuery({ ...currentReportQuery, groupBy: "month" })}
                    className={`flex items-center border-l border-slate-200 px-2.5 ${report.groupBy === "month" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    {t("reports.month")}
                  </Link>
                </div>
              </div>
              {report.groupBy === "month" ? (
                <>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">{t("reports.startMonth")}</span>
                    <input
                      type="month"
                      name="startMonth"
                      defaultValue={report.start.slice(0, 7)}
                      className="h-8 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">{t("reports.endMonth")}</span>
                    <input
                      type="month"
                      name="endMonth"
                      defaultValue={report.end.slice(0, 7)}
                      className="h-8 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">{t("reports.startYear")}</span>
                    <select
                      name="startYear"
                      defaultValue={report.start.slice(0, 4)}
                      className="h-8 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    >
                      {availableYears.map((year) => <option key={`start-${year}`} value={year}>{year}</option>)}
                    </select>
                  </label>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">{t("reports.endYear")}</span>
                    <select
                      name="endYear"
                      defaultValue={report.end.slice(0, 4)}
                      className="h-8 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    >
                      {availableYears.map((year) => <option key={`end-${year}`} value={year}>{year}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="flex shrink-0 items-center gap-1.5">
                <span className="text-xs font-medium text-slate-500">{t("reports.account")}</span>
                <select
                  name="accountId"
                  defaultValue={selectedAccount?.id ?? ""}
                  className="h-8 w-48 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                >
                  <option value="">{t("reports.allAccounts")}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="inline-flex h-8 shrink-0 items-center rounded-md bg-slate-900 px-3 text-xs font-medium text-white transition hover:bg-slate-700"
              >
                {t("reports.refresh")}
              </button>
              <a
                href={exportHref}
                download={exportFilename}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                title={t("reports.exportIncomeExpenseTitle")}
              >
                <Download className="h-3.5 w-3.5" />
                {t("reports.export")}
              </a>
          </form>

          <IncomeExpenseReportClient
            report={report}
            initialDetailEntries={detailEntries}
            currentReportQuery={currentReportQuery}
            colorScheme={colorScheme}
            accountId={selectedAccount?.id ?? ""}
            accountOptions={accounts}
            categoryOptions={buildCategorySmartSelectOptions({
              categories: editCategories,
              types: ["expense", "income"],
              typeLabels: {
                expense: t("stats.expenseCategories"),
                income: t("categoryType.income"),
              },
              typeHeaderPrefix: "category-type",
              includeTypeHeaders: true,
              t,
            }).map((option) => ({ ...option, value: option.id }))}
            investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          />
          <ReportTransactionEditHost
            accounts={accounts}
            accountSSOptions={accountSSOptions}
            cashAccounts={cashAccounts}
            investmentAccounts={investmentAccounts}
            cashAccountSSOptions={cashAccountSSOptions}
            investmentAccountSSOptions={investmentAccountSSOptions}
            expenseCategories={expenseCategories}
            incomeCategories={incomeCategories}
            tags={editTags}
            nestedFieldData={nestedFieldData}
          />
        </div>
      </div>
    </div>
  );
}
