"use client";

import { useEffect, useMemo, useState } from "react";

import { ReportDetailTable } from "@/components/ReportDetailTable";
import { ReportResizableSplit } from "@/components/ReportResizableSplit";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import type { DetailEntry } from "@/components/DetailViewClient";
import { formatMoney } from "@/lib/format";
import { pnlColor, type ColorScheme } from "@/lib/client/colors";
import type {
  IncomeExpenseGroupBy,
  IncomeExpenseReport,
  IncomeExpenseReportDetails,
  IncomeExpenseReportDetailType,
} from "@/lib/server/income-expense-report";

type AccountOption = {
  id: string;
  label: string;
  kind?: string | null;
  debtDirection?: string | null;
};

type ReportQuery = {
  start: string;
  end: string;
  accountId: string;
  groupBy: IncomeExpenseGroupBy;
};

type DetailSelection = {
  type: IncomeExpenseReportDetailType;
  categoryKey?: string;
  columnKey?: string;
};

type DetailResponse = {
  ok?: boolean;
  data?: {
    details: IncomeExpenseReportDetails | null;
    entries: DetailEntry[];
  };
  error?: string;
};

function buildDetailSearch(query: ReportQuery, detail: DetailSelection) {
  const params = new URLSearchParams();
  params.set("start", query.start);
  params.set("end", query.end);
  params.set("groupBy", query.groupBy);
  if (query.accountId) params.set("accountId", query.accountId);
  params.set("detailType", detail.type);
  if (detail.categoryKey) params.set("detailCategoryKey", detail.categoryKey);
  if (detail.columnKey) params.set("detailColumnKey", detail.columnKey);
  return params;
}

function buildClearUrl(query: ReportQuery) {
  const params = new URLSearchParams();
  params.set("groupBy", query.groupBy);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.groupBy === "month") {
    params.set("startMonth", query.start.slice(0, 7));
    params.set("endMonth", query.end.slice(0, 7));
  } else {
    params.set("startYear", query.start.slice(0, 4));
    params.set("endYear", query.end.slice(0, 4));
  }
  return `/reports?${params.toString()}`;
}

function detailKey(detail: DetailSelection) {
  return `${detail.type}:${detail.categoryKey ?? "all"}:${detail.columnKey ?? "all"}`;
}

function activeDetailKey(details: IncomeExpenseReportDetails | null) {
  if (!details) return "";
  return `${details.type}:${details.categoryKey ?? "all"}:${details.columnKey ?? "all"}`;
}

function AmountButton({
  value,
  count,
  detail,
  className = "",
  loadingKey,
  onSelect,
}: {
  value: number;
  count: number;
  detail: DetailSelection;
  className?: string;
  loadingKey: string | null;
  onSelect: (detail: DetailSelection) => void;
}) {
  if (count === 0) return <span className={className}>{formatMoney(value)}</span>;
  const key = detailKey(detail);
  const loading = loadingKey === key;
  return (
    <button
      type="button"
      onClick={() => onSelect(detail)}
      disabled={loading}
      className={`${className} inline appearance-none border-0 bg-transparent p-0 text-inherit font-[inherit] cursor-pointer decoration-dotted underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-60`}
      title={`查看 ${count} 条明细`}
    >
      {formatMoney(value)}
    </button>
  );
}

export function IncomeExpenseReportClient({
  report,
  initialDetailEntries,
  currentReportQuery,
  colorScheme,
  accountId,
  accountOptions,
  categoryOptions,
  investmentProductTypeByAccountId,
}: {
  report: IncomeExpenseReport;
  initialDetailEntries: DetailEntry[];
  currentReportQuery: ReportQuery;
  colorScheme: ColorScheme;
  accountId: string;
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | null | undefined>;
}) {
  const [activeDetails, setActiveDetails] = useState<IncomeExpenseReportDetails | null>(report.details);
  const [detailEntries, setDetailEntries] = useState<DetailEntry[]>(initialDetailEntries);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const initialKey = useMemo(
    () => `${report.start}:${report.end}:${report.groupBy}:${accountId}:${activeDetailKey(report.details)}`,
    [accountId, report.details, report.end, report.groupBy, report.start],
  );

  useEffect(() => {
    setActiveDetails(report.details);
    setDetailEntries(initialDetailEntries);
    setLoadingKey(null);
  }, [initialDetailEntries, initialKey, report.details]);

  async function selectDetail(detail: DetailSelection) {
    const key = detailKey(detail);
    setLoadingKey(key);
    try {
      const params = buildDetailSearch(currentReportQuery, detail);
      const res = await fetch(`/api/v1/reports/income-expense/detail?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as DetailResponse | null;
      if (!res.ok || !data?.ok || !data.data) {
        throw new Error(data?.error ?? "查询明细失败");
      }
      setActiveDetails(data.data.details);
      setDetailEntries(data.data.entries ?? []);
      window.requestAnimationFrame(() => {
        document.getElementById("report-details")?.scrollIntoView({ block: "nearest" });
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "查询明细失败");
    } finally {
      setLoadingKey(null);
    }
  }

  function clearDetails() {
    setActiveDetails(null);
    setDetailEntries([]);
    window.history.pushState(null, "", buildClearUrl(currentReportQuery));
  }

  const hasDetails = Boolean(activeDetails);

  return (
    <ReportResizableSplit hasDetails={hasDetails}>
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-[960px] w-full border-separate border-spacing-0">
            <thead className="bg-white">
              <tr>
                <th className="sticky left-0 top-0 z-30 border-b border-slate-200 bg-white px-4 py-2 text-left text-xs font-semibold text-slate-600">分类</th>
                {report.columns.map((column) => (
                  <th
                    key={column.key}
                    className="sticky top-0 z-20 border-b border-slate-200 bg-white px-3 py-2 text-right text-xs font-semibold text-slate-600"
                  >
                    {column.label}
                  </th>
                ))}
                <th className="sticky top-0 z-20 border-b border-slate-200 bg-white px-3 py-2 text-right text-xs font-semibold text-slate-700">合计</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-emerald-50/70">
                <td className="sticky left-0 z-10 border-b border-emerald-100 bg-emerald-50/70 px-4 py-2 text-sm font-semibold text-emerald-700">
                  收入合计
                </td>
                {report.income.periodTotals.map((value, index) => (
                  <td key={`income-total-${index}`} className="border-b border-emerald-100 px-3 py-2 text-right text-xs font-semibold tabular-nums text-emerald-700">
                    <AmountButton
                      value={value}
                      count={report.income.periodCounts[index]}
                      className={pnlColor(value, colorScheme)}
                      detail={{ type: "income", columnKey: report.columns[index].key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                ))}
                <td className="border-b border-emerald-100 px-3 py-2 text-right text-xs font-semibold tabular-nums text-emerald-700">
                  <AmountButton
                    value={report.income.total}
                    count={report.income.count}
                    className={pnlColor(report.income.total, colorScheme)}
                    detail={{ type: "income" }}
                    loadingKey={loadingKey}
                    onSelect={selectDetail}
                  />
                </td>
              </tr>
              {report.income.rows.map((row) => (
                <tr key={row.key} className="hover:bg-slate-50">
                  <td
                    className="sticky left-0 border-b border-slate-100 bg-white py-2 pr-3 text-xs text-slate-700"
                    style={{ paddingLeft: `${16 + row.depth * 20}px` }}
                  >
                    <span className={row.depth === 0 ? "font-semibold text-slate-800" : ""}>{row.name}</span>
                  </td>
                  {row.values.map((value, index) => (
                    <td key={`${row.key}-${index}`} className="border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-600">
                      <AmountButton
                        value={value}
                        count={row.counts[index]}
                        className={pnlColor(value, colorScheme)}
                        detail={{ type: "income", categoryKey: row.key, columnKey: report.columns[index].key }}
                        loadingKey={loadingKey}
                        onSelect={selectDetail}
                      />
                    </td>
                  ))}
                  <td className="border-b border-slate-100 px-3 py-2 text-right text-xs font-medium tabular-nums text-slate-700">
                    <AmountButton
                      value={row.total}
                      count={row.count}
                      className={pnlColor(row.total, colorScheme)}
                      detail={{ type: "income", categoryKey: row.key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                </tr>
              ))}

              <tr className="bg-rose-50/70">
                <td className="sticky left-0 z-10 border-b border-rose-100 bg-rose-50/70 px-4 py-2 text-sm font-semibold text-rose-700">
                  支出合计
                </td>
                {report.expense.periodTotals.map((value, index) => (
                  <td key={`expense-total-${index}`} className="border-b border-rose-100 px-3 py-2 text-right text-xs font-semibold tabular-nums text-rose-700">
                    <AmountButton
                      value={value}
                      count={report.expense.periodCounts[index]}
                      className={pnlColor(-value, colorScheme)}
                      detail={{ type: "expense", columnKey: report.columns[index].key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                ))}
                <td className="border-b border-rose-100 px-3 py-2 text-right text-xs font-semibold tabular-nums text-rose-700">
                  <AmountButton
                    value={report.expense.total}
                    count={report.expense.count}
                    className={pnlColor(-report.expense.total, colorScheme)}
                    detail={{ type: "expense" }}
                    loadingKey={loadingKey}
                    onSelect={selectDetail}
                  />
                </td>
              </tr>
              {report.expense.rows.map((row) => (
                <tr key={row.key} className="hover:bg-slate-50">
                  <td
                    className="sticky left-0 border-b border-slate-100 bg-white py-2 pr-3 text-xs text-slate-700"
                    style={{ paddingLeft: `${16 + row.depth * 20}px` }}
                  >
                    <span className={row.depth === 0 ? "font-semibold text-slate-800" : ""}>{row.name}</span>
                  </td>
                  {row.values.map((value, index) => (
                    <td key={`${row.key}-${index}`} className="border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-600">
                      <AmountButton
                        value={value}
                        count={row.counts[index]}
                        className={pnlColor(-value, colorScheme)}
                        detail={{ type: "expense", categoryKey: row.key, columnKey: report.columns[index].key }}
                        loadingKey={loadingKey}
                        onSelect={selectDetail}
                      />
                    </td>
                  ))}
                  <td className="border-b border-slate-100 px-3 py-2 text-right text-xs font-medium tabular-nums text-slate-700">
                    <AmountButton
                      value={row.total}
                      count={row.count}
                      className={pnlColor(-row.total, colorScheme)}
                      detail={{ type: "expense", categoryKey: row.key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-slate-50">
              <tr>
                <td className="sticky left-0 border-t border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
                  净收支
                </td>
                {report.netPeriodTotals.map((value, index) => (
                  <td
                    key={`net-${index}`}
                    className={`border-t border-slate-200 px-3 py-2 text-right text-xs font-semibold tabular-nums ${pnlColor(value, colorScheme)}`}
                  >
                    <AmountButton
                      value={value}
                      count={report.income.periodCounts[index] + report.expense.periodCounts[index]}
                      detail={{ type: "net", columnKey: report.columns[index].key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                      className={value > 0 ? "before:content-['+']" : ""}
                    />
                  </td>
                ))}
                <td className={`border-t border-slate-200 px-3 py-2 text-right text-xs font-semibold tabular-nums ${pnlColor(report.netTotal, colorScheme)}`}>
                  <AmountButton
                    value={report.netTotal}
                    count={report.income.count + report.expense.count}
                    detail={{ type: "net" }}
                    loadingKey={loadingKey}
                    onSelect={selectDetail}
                    className={report.netTotal > 0 ? "before:content-['+']" : ""}
                  />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {report.income.rows.length === 0 && report.expense.rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            当前筛选范围内暂无收支数据
          </div>
        ) : null}
      </div>

      {activeDetails ? (
        <div id="report-details" className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <ReportDetailTable
            accountId={accountId}
            entries={detailEntries}
            accountOptions={accountOptions}
            categoryOptions={categoryOptions}
            investmentProductTypeByAccountId={investmentProductTypeByAccountId}
            title={`${activeDetails.typeLabel}明细${activeDetails.categoryName ? ` · ${activeDetails.categoryName}` : ""} · ${activeDetails.columnLabel}`}
            total={activeDetails.total}
            colorValue={activeDetails.type === "expense" ? -activeDetails.total : activeDetails.total}
            onClear={clearDetails}
            resetKey={activeDetailKey(activeDetails)}
          />
        </div>
      ) : null}
    </ReportResizableSplit>
  );
}
