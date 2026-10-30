"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  AccountScopeFilter,
  type AccountScopeValue,
  type StatisticsAccountItem,
  type StatisticsInstitutionItem,
  type StatisticsUserItem,
} from "@/components/AccountScopeFilter";

export type {
  StatisticsAccountItem,
  StatisticsInstitutionItem,
  StatisticsUserItem,
} from "@/components/AccountScopeFilter";

type Props = {
  allAccounts: StatisticsAccountItem[];
  allInstitutions?: StatisticsInstitutionItem[];
  allUsers?: StatisticsUserItem[];
  year: number;
  month?: number;
  reportPath?: string;
  exportHref?: string;
  exportFilename?: string;
  start?: string;
  end?: string;
  availableYears?: number[];
  baseParams?: Record<string, string>;
  accountParam?: string;
  periodParam?: string;
  hideRange?: boolean;
};

export function StatisticsFilterPanel({ allAccounts, allInstitutions = [], allUsers = [], year, month, reportPath = "/statistics", exportHref, exportFilename, start, end, availableYears = [], baseParams = {}, accountParam, periodParam, hideRange = false }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const isReports = reportPath === "/reports";
  const [level, setLevel] = useState<"year" | "month">(
    isReports
      ? searchParams.get(periodParam ?? "groupBy") === "month" ? "month" : "year"
      : searchParams.get("level") === "month" ? "month" : "year",
  );
  const [accountId, setAccountId] = useState(searchParams.get(accountParam ?? "accounts") ?? "");
  const [institutionId, setInstitutionId] = useState(searchParams.get("institutionIds") ?? searchParams.get("institutionId") ?? "");
  const [userIds, setUserIds] = useState<string[]>(searchParams.get("userIds")?.split(",").filter(Boolean) ?? (searchParams.get("userId") ? [searchParams.get("userId")!] : []));
  const [startMonth, setStartMonth] = useState(searchParams.get("startMonth") ?? start?.slice(0, 7) ?? `${year}-01`);
  const [endMonth, setEndMonth] = useState(searchParams.get("endMonth") ?? end?.slice(0, 7) ?? `${year}-12`);
  const [startYear, setStartYear] = useState(searchParams.get("startYear") ?? start?.slice(0, 4) ?? String(year));
  const [endYear, setEndYear] = useState(searchParams.get("endYear") ?? end?.slice(0, 4) ?? String(year));
  // 统计图表页（/statistics）没有区间概念：服务端只认 year (+ month)。
  const [statYear, setStatYear] = useState(String(year));
  const [statMonth, setStatMonth] = useState(String(month ?? 1));

  const scopeValue: AccountScopeValue = {
    userIds,
    institutionIds: institutionId.split(",").filter(Boolean),
    accountIds: accountId.split(",").filter(Boolean),
  };

  function generate(overrides: { nextUserIds?: string[]; nextInstitutionId?: string; nextAccountId?: string } = {}) {
    const nextUserIds = overrides.nextUserIds ?? userIds;
    const nextInstitutionId = overrides.nextInstitutionId ?? institutionId;
    const nextAccountId = overrides.nextAccountId ?? accountId;
    const params = new URLSearchParams();
    Object.entries(baseParams).forEach(([key, value]) => params.set(key, value));
    if (isReports) {
      params.set("year", searchParams.get("year") ?? String(year));
      if (periodParam) params.set(periodParam, level === "month" ? "month" : "year");
      params.set("groupBy", level);
      if (level === "month") { params.set("startMonth", startMonth); params.set("endMonth", endMonth); }
      else { params.set("startYear", startYear); params.set("endYear", endYear); }
    } else {
      // /statistics：服务端只认 year (+ month)。此前这里写的是 startMonth/
      // endMonth（服务端从不读取），且 year 永远不变，导致年份切不回去。
      params.set("level", level);
      params.set("year", statYear);
      if (level === "month") params.set("month", statMonth);
    }
    if (nextAccountId) params.set(accountParam ?? (reportPath === "/reports" ? "accountId" : "accounts"), nextAccountId);
    if (nextInstitutionId) {
      params.set("institutionIds", nextInstitutionId);
    }
    if (nextUserIds.length > 0) params.set("userIds", nextUserIds.join(","));
    router.push(`${reportPath}?${params.toString()}`, { scroll: false });
  }

  function handleScopeChange(next: AccountScopeValue) {
    // Only update the local draft here. The cascading option lists inside
    // AccountScopeFilter follow these values; the report itself recomputes
    // only when the user clicks the refresh button (generate()).
    setUserIds(next.userIds);
    setInstitutionId(next.institutionIds.join(","));
    setAccountId(next.accountIds.join(","));
  }

  function clearFilters() {
    setUserIds([]);
    setInstitutionId("");
    setAccountId("");
  }

  return (
    // 移动端允许换行堆叠（min-w-max 只在 md+ 生效）：控件全在一行时窄屏必然溢出。
    <div className="flex flex-wrap items-center gap-2 md:min-w-max md:gap-3">
      {!hideRange && <span className="text-xs font-medium text-slate-500">{t("statistics.range")}</span>}
      {!hideRange && <select value={level} onChange={(event) => setLevel(event.target.value as "year" | "month")} className="h-9 w-20 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8">
        <option value="year">{t("reports.year")}</option>
        <option value="month">{t("reports.month")}</option>
      </select>}
      {!hideRange && isReports && level === "month" ? <><input type="month" value={startMonth} onChange={(event) => setStartMonth(event.target.value)} className="h-9 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8" /><input type="month" value={endMonth} onChange={(event) => setEndMonth(event.target.value)} className="h-9 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8" /></> : null}
      {!hideRange && isReports && level === "year" ? <><select value={startYear} onChange={(event) => setStartYear(event.target.value)} className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8">{(availableYears.length > 0 ? availableYears : [year]).map((value) => <option key={`start-${value}`}>{value}</option>)}</select><select value={endYear} onChange={(event) => setEndYear(event.target.value)} className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8">{(availableYears.length > 0 ? availableYears : [year]).map((value) => <option key={`end-${value}`}>{value}</option>)}</select></> : null}
      {/* 统计图表页：单年（年视图）或 年+月（月视图），提交到 year/month 参数 */}
      {!hideRange && !isReports ? <>
        <select value={statYear} onChange={(event) => setStatYear(event.target.value)} className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8">{(availableYears.length > 0 ? availableYears : [year]).map((value) => <option key={`stat-year-${value}`}>{value}</option>)}</select>
        {level === "month" && <select value={statMonth} onChange={(event) => setStatMonth(event.target.value)} className="h-9 w-20 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 md:h-8">{Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((value) => <option key={`stat-month-${value}`}>{value}</option>)}</select>}
      </> : null}
      <AccountScopeFilter
        allAccounts={allAccounts}
        allInstitutions={allInstitutions}
        allUsers={allUsers}
        value={scopeValue}
        onChange={handleScopeChange}
      />
      <button type="button" onClick={() => generate()} className="h-9 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-700 md:h-8">{t("reports.refresh")}</button>
      <button type="button" onClick={clearFilters} className="h-9 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 md:h-8">{t("statistics.clearFilters")}</button>
      {exportHref && <a href={exportHref} download={exportFilename ?? "export.csv"} className="inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 md:h-8">{t("reports.export")}</a>}
    </div>
  );
}
