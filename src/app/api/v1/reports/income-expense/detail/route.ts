import { NextResponse } from "next/server";

import {
  getIncomeExpenseReport,
  type IncomeExpenseGroupBy,
  type IncomeExpenseReportDetailType,
} from "@/lib/server/income-expense-report";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadReportDetailEntries } from "@/lib/server/report-detail-entries";

export const runtime = "nodejs";

/**
 * GET /api/v1/reports/income-expense/detail
 *
 * Query params:
 * - start: YYYY-MM-DD
 * - end: YYYY-MM-DD
 * - groupBy?: "month" | "year"
 * - accountId?: Account.id
 * - detailType: "income" | "expense" | "net"
 * - detailCategoryKey?: Category.id or report uncategorized key
 * - detailColumnKey?: report column key, such as YYYY-MM
 *
 * Returns:
 * - { ok: true, data: { details, entries } }
 * - { ok: false, error }
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "";
    const groupByRaw = url.searchParams.get("groupBy") ?? "";
    const groupBy: IncomeExpenseGroupBy = groupByRaw === "year" ? "year" : "month";
    const accountId = url.searchParams.get("accountId")?.trim() || "";
    const detailTypeRaw = url.searchParams.get("detailType") ?? "";
    const detailType: IncomeExpenseReportDetailType | null =
      detailTypeRaw === "income" || detailTypeRaw === "expense" || detailTypeRaw === "net"
        ? detailTypeRaw
        : null;

    if (!detailType) {
      return NextResponse.json({ ok: false, error: "明细类型不正确" }, { status: 400 });
    }

    const ctx = await getHouseholdScope();
    const report = await getIncomeExpenseReport(ctx, {
      start,
      end,
      groupBy,
      accountIds: accountId ? [accountId] : undefined,
      detail: {
        type: detailType,
        categoryKey: url.searchParams.get("detailCategoryKey")?.trim() || undefined,
        columnKey: url.searchParams.get("detailColumnKey")?.trim() || undefined,
      },
    });

    const detailEntryIds = report.details
      ? [...new Set(report.details.rows.map((row) => row.entryId))]
      : [];
    const entries = await loadReportDetailEntries(ctx, detailEntryIds);

    return NextResponse.json({
      ok: true,
      data: {
        details: report.details,
        entries,
      },
    });
  } catch (error) {
    console.error("GET /api/v1/reports/income-expense/detail error:", error);
    return NextResponse.json({ ok: false, error: "查询报表明细失败" }, { status: 500 });
  }
}
