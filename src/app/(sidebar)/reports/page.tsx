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
import { ReportTransactionEditHost } from "@/components/ReportTransactionEditHost";
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
import { getHouseholdScope } from "@/lib/server/household-scope";
import { readableTagWhere } from "@/lib/server/tag-scope";
import { loadReportDetailEntries } from "@/lib/server/report-detail-entries";

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

function rowCsv(section: "收入" | "支出", row: IncomeExpenseReportRow) {
  return [
    section,
    `${"  ".repeat(row.depth)}${row.name}`,
    ...row.values.map((value) => value.toFixed(2)),
    row.total.toFixed(2),
  ];
}

function reportTabs(currentType: "income-expense" | "investment-profit", investmentHref: string) {
  const itemClass = (active: boolean) =>
    `inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition ${
      active ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"
    }`;

  return (
    <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5">
      <Link href="/reports" scroll={false} className={itemClass(currentType === "income-expense")}>
        收支统计表
      </Link>
      <Link href={investmentHref} scroll={false} className={itemClass(currentType === "investment-profit")}>
        投资收益表
      </Link>
    </div>
  );
}

function buildReportHref(
  reportType: "income-expense" | "investment-profit",
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
  const now = new Date();
  const reportType = params.report === "investment-profit" ? "investment-profit" : "income-expense";
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

  const allAccountRecords = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      isActive: true,
      isPlaceholder: { not: true },
      name: { not: "未指定账户" },
    },
    include: {
      AccountGroup: true,
      Institution: true,
    },
    orderBy: [{ name: "asc" }],
  });
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
      || "未设机构";
    const existing = institutionScopeByValue.get(value) ?? {
      value,
      label: `按机构：${institutionName}`,
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
      title: `${option.label} · ${option.ids.length}个账户`,
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
  const allInvestmentScopeOption: InvestmentProfitScopeOption = {
    value: PROFIT_SCOPE_ALL,
    label: "全部投资账户",
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
        label: `按账户：${label}`,
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
    });
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
      ? `${profitYear}年${profitMonth}月`
      : profitPeriod === "month"
        ? `${profitYear}年`
        : `截至 ${currentYear} 年`;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex h-12 items-center justify-between px-4">
            <div className="text-sm page-title">报表</div>
            <div className="flex items-center gap-2">
              {reportTabs("investment-profit", currentInvestmentHref)}
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
                      {period === "day" ? "按日" : period === "month" ? "按月" : "按年"}
                    </Link>
                  ))}
                </div>
                {profitPeriod !== "year" ? (
                  <Link
                    href={previousHref}
                    scroll={false}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    title={profitPeriod === "day" ? "上月" : "上一年"}
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
                    title={profitPeriod === "day" ? "下月" : "下一年"}
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

  const [editCategories, editTags, editGroups, editInstitutions, editCounterparties] = await Promise.all([
    prisma.category.findMany({
      where: { ...ctx.hidFilter, type: { in: ["income", "expense"] } },
      select: { id: true, name: true, type: true, parentId: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    prisma.tag.findMany({
      where: readableTagWhere(ctx.householdId),
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
    }),
    prisma.accountGroup.findMany({
      where: ctx.hidFilter,
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: ctx.hidFilter,
      select: { id: true, name: true, type: true },
      orderBy: { name: "asc" },
    }),
    prisma.counterparty.findMany({
      where: ctx.hidFilter,
      select: { id: true, name: true, shortName: true, type: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
  ]);
  const expenseCategories = editCategories
    .filter((category) => category.type === "expense")
    .map((category) => ({ id: category.id, label: category.name, parentId: category.parentId, type: category.type }));
  const incomeCategories = editCategories
    .filter((category) => category.type === "income")
    .map((category) => ({ id: category.id, label: category.name, parentId: category.parentId, type: category.type }));
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
    ["统计范围", `${report.start} ~ ${report.end}`],
    ["账户", selectedAccount?.label ?? "全部账户"],
    ["统计粒度", report.groupBy === "year" ? "按年" : "按月"],
    [],
    ["类型", "分类", ...report.columns.map((column) => column.label), "合计"],
    ["收入", "收入合计", ...report.income.periodTotals.map((value) => value.toFixed(2)), report.income.total.toFixed(2)],
    ...report.income.rows.map((row) => rowCsv("收入", row)),
    ["支出", "支出合计", ...report.expense.periodTotals.map((value) => value.toFixed(2)), report.expense.total.toFixed(2)],
    ...report.expense.rows.map((row) => rowCsv("支出", row)),
    ["净收支", "净收支", ...report.netPeriodTotals.map((value) => value.toFixed(2)), report.netTotal.toFixed(2)],
  ];
  const exportHref = buildCsvDataUri(exportRows);
  const exportFilename = `收支统计-${report.start}-${report.end}${selectedAccount ? `-${selectedAccount.label}` : ""}.csv`;
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
          <div className="text-sm page-title">报表</div>
          <div className="flex items-center gap-2">
            {reportTabs("income-expense", buildReportHref("investment-profit", "day", currentYear, currentMonth))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <form className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-slate-200 bg-white px-1" method="get">
              <input type="hidden" name="groupBy" value={report.groupBy} />
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-xs font-medium text-slate-500">级次</span>
                <div className="inline-flex h-8 overflow-hidden rounded-md border border-slate-200 bg-white text-xs">
                  <Link
                    href={presetQuery({ ...currentReportQuery, groupBy: "year" })}
                    className={`flex items-center px-2.5 ${report.groupBy === "year" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    年
                  </Link>
                  <Link
                    href={presetQuery({ ...currentReportQuery, groupBy: "month" })}
                    className={`flex items-center border-l border-slate-200 px-2.5 ${report.groupBy === "month" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    月
                  </Link>
                </div>
              </div>
              {report.groupBy === "month" ? (
                <>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">开始月份</span>
                    <input
                      type="month"
                      name="startMonth"
                      defaultValue={report.start.slice(0, 7)}
                      className="h-8 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">结束月份</span>
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
                    <span className="text-xs font-medium text-slate-500">开始年</span>
                    <select
                      name="startYear"
                      defaultValue={report.start.slice(0, 4)}
                      className="h-8 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    >
                      {availableYears.map((year) => <option key={`start-${year}`} value={year}>{year}</option>)}
                    </select>
                  </label>
                  <label className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-500">结束年</span>
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
                <span className="text-xs font-medium text-slate-500">账户</span>
                <select
                  name="accountId"
                  defaultValue={selectedAccount?.id ?? ""}
                  className="h-8 w-48 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                >
                  <option value="">全部账户</option>
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
                刷新统计
              </button>
              <a
                href={exportHref}
                download={exportFilename}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                title="导出当前收支统计 CSV"
              >
                <Download className="h-3.5 w-3.5" />
                导出
              </a>
          </form>

          <IncomeExpenseReportClient
            report={report}
            initialDetailEntries={detailEntries}
            currentReportQuery={currentReportQuery}
            colorScheme={colorScheme}
            accountId={selectedAccount?.id ?? ""}
            accountOptions={accounts}
            categoryOptions={[...expenseCategories, ...incomeCategories].map((category) => ({
              value: category.id,
              label: category.label,
              parentId: category.parentId ?? undefined,
            }))}
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
