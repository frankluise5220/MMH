"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

type AccountItem = {
  id: string;
  name: string;
  kind: string;
  Institution?: { name: string } | null;
};

type TagItem = {
  id: string;
  name: string;
  color: string | null;
};

const accountLabel = (a: AccountItem) => {
  const inst = a.Institution?.name?.trim();
  return inst ? `${inst}·${a.name}` : a.name;
};

export function StatisticsFilterPanel({
  allAccounts,
  allTags,
  year,
}: {
  allAccounts: AccountItem[];
  allTags: TagItem[];
  year: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedAccountIds = searchParams.get("accounts")
    ? searchParams.get("accounts")!.split(",").filter(Boolean)
    : [];
  const selectedTagIds = searchParams.get("tags")
    ? searchParams.get("tags")!.split(",").filter(Boolean)
    : [];
  const reportType = searchParams.get("report") === "investment-profit" ? "investment-profit" : "income-expense";
  const profitPeriod = ["day", "month", "year"].includes(searchParams.get("profitPeriod") ?? "")
    ? searchParams.get("profitPeriod")!
    : "day";
  const parsedMonth = Number(searchParams.get("month"));
  const profitMonth = Number.isFinite(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12
    ? Math.floor(parsedMonth)
    : new Date().getMonth() + 1;

  function buildHref(
    accountIds: string[],
    tagIds: string[],
    overrides: {
      year?: number;
      report?: string;
      profitPeriod?: string;
      profitMonth?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    const nextReport = overrides.report ?? reportType;
    const nextPeriod = overrides.profitPeriod ?? profitPeriod;
    const nextMonth = overrides.profitMonth ?? profitMonth;
    params.set("year", String(overrides.year ?? year));
    if (nextReport === "investment-profit") {
      params.set("report", nextReport);
      params.set("profitPeriod", nextPeriod);
      if (nextPeriod === "day") params.set("month", String(nextMonth));
    }
    if (accountIds.length > 0) params.set("accounts", accountIds.join(","));
    if (tagIds.length > 0) params.set("tags", tagIds.join(","));
    return `/statistics?${params.toString()}`;
  }

  function toggleAccount(id: string) {
    const next = selectedAccountIds.includes(id)
      ? selectedAccountIds.filter(x => x !== id)
      : [...selectedAccountIds, id];
    router.push(buildHref(next, selectedTagIds));
  }

  function toggleTag(id: string) {
    const next = selectedTagIds.includes(id)
      ? selectedTagIds.filter(x => x !== id)
      : [...selectedTagIds, id];
    router.push(buildHref(selectedAccountIds, next));
  }

  const hrefYear = (y: number) => buildHref(selectedAccountIds, selectedTagIds, { year: y });
  const showYearSwitcher = reportType !== "investment-profit" || profitPeriod !== "year";

  return (
    <div className="flex items-center gap-3">
      <select
        value={reportType}
        onChange={(event) => router.push(buildHref(selectedAccountIds, selectedTagIds, { report: event.target.value }))}
        className="h-7 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none hover:bg-slate-50"
        aria-label="报表类型"
      >
        <option value="income-expense">收支统计表</option>
        <option value="investment-profit">投资基金、理财收益表</option>
      </select>

      {reportType === "investment-profit" ? (
        <>
          <select
            value={profitPeriod}
            onChange={(event) => router.push(buildHref(selectedAccountIds, selectedTagIds, { profitPeriod: event.target.value }))}
            className="h-7 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none hover:bg-slate-50"
            aria-label="收益周期"
          >
            <option value="day">按日</option>
            <option value="month">按月</option>
            <option value="year">按年</option>
          </select>
          {profitPeriod === "day" ? (
            <select
              value={profitMonth}
              onChange={(event) => router.push(buildHref(selectedAccountIds, selectedTagIds, { profitMonth: Number(event.target.value) }))}
              className="h-7 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none hover:bg-slate-50"
              aria-label="收益月份"
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                <option key={month} value={month}>{month}月</option>
              ))}
            </select>
          ) : null}
        </>
      ) : null}

      {showYearSwitcher ? (
        <div className="flex items-center gap-1">
          <Link href={hrefYear(year - 1)} className="h-7 w-7 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-50 flex items-center justify-center">◀</Link>
          <span className="text-sm font-semibold text-slate-700 w-16 text-center">{year}年</span>
          <Link href={hrefYear(year + 1)} className="h-7 w-7 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-50 flex items-center justify-center">▶</Link>
        </div>
      ) : (
        <span className="text-xs font-medium text-slate-500">截至本年</span>
      )}

      {/* 账户筛选 */}
      <div className="relative group">
        <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded cursor-pointer hover:bg-slate-200">
          {selectedAccountIds.length > 0 ? `已选 ${selectedAccountIds.length} 个账户` : "全部账户"}
        </span>
        <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block bg-white border border-slate-200 rounded-lg shadow-lg p-2 min-w-[240px] max-h-64 overflow-y-auto">
          {allAccounts.map(a => (
            <label key={a.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-slate-50 rounded cursor-pointer">
              <input
                type="checkbox"
                checked={selectedAccountIds.includes(a.id)}
                onChange={() => toggleAccount(a.id)}
                className="rounded"
              />
              {accountLabel(a)}
            </label>
          ))}
        </div>
      </div>

      {/* 标签筛选 */}
      {allTags.length > 0 && (
        <div className="relative group">
          <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded cursor-pointer hover:bg-slate-200">
            {selectedTagIds.length > 0 ? `已选 ${selectedTagIds.length} 个标签` : "全部标签"}
          </span>
          <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block bg-white border border-slate-200 rounded-lg shadow-lg p-2 min-w-[200px] max-h-64 overflow-y-auto">
            {allTags.map(t => {
              const c = t.color || "#3B82F6";
              const checked = selectedTagIds.includes(t.id);
              return (
                <label key={t.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-slate-50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTag(t.id)}
                    className="rounded"
                  />
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c }} />
                    {t.name}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
