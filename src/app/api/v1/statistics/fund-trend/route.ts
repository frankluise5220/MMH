import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  loadFundPortfolioTrendData,
  ensureBenchmarkCache,
} from "@/lib/server/fund-portfolio-trend";
import { resolveBenchmarkCode } from "@/lib/benchmark-options";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/statistics/fund-trend
 *
 * Aggregates monthly fund portfolio data across all investment accounts in the
 * household: cost basis, market value, floating P/L, and net invested flow per month.
 * Optionally overlays a benchmark index (normalized NAV) on top.
 *
 * Query params:
 *   start: YYYY-MM (optional, default = earliest transaction)
 *   end:   YYYY-MM (optional, default = current month)
 *   accountIds: comma-separated account IDs (optional, default = all investment accounts)
 *   benchmark:  "1" = default index (CSI 300); or a benchmark code from
 *               BENCHMARK_OPTIONS (e.g. 513100 = Nasdaq 100, 513500 = S&P 500);
 *               "0"/absent = no benchmark. Cache is backfilled best-effort.
 */
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: "请先登录。" },
      { status: 401 },
    );
  }

  const ctx = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const startMonth = (searchParams.get("start") ?? "").trim() || undefined;
  const endMonth = (searchParams.get("end") ?? "").trim() || undefined;
  const accountIdsRaw = (searchParams.get("accountIds") ?? "").trim();
  const accountIds = accountIdsRaw ? accountIdsRaw.split(",").filter(Boolean) : undefined;
  const benchmarkParam = (searchParams.get("benchmark") ?? "").trim();
  const includeBenchmark = benchmarkParam !== "" && benchmarkParam !== "0";
  const benchmarkCode = includeBenchmark
    ? resolveBenchmarkCode(benchmarkParam === "1" ? undefined : benchmarkParam)
    : null;

  try {
    // If benchmark requested, make sure the cache covers the window (best-effort).
    if (benchmarkCode) {
      const now = new Date();
      const endMonthStr = endMonth
        ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const [ey, em] = endMonthStr.split("-").map(Number);
      const endDate = new Date(Date.UTC(ey, em, 0)).toISOString().slice(0, 10);
      let startMonthStr = startMonth;
      if (!startMonthStr) {
        // "All history": bound the backfill at ~5 years back (the walk itself
        // caps at ~2.4 years of pages; best-effort either way).
        const startObj = new Date(Date.UTC(ey, em - 1 - 60, 1));
        startMonthStr = startObj.toISOString().slice(0, 10);
      }
      const [sy, sm] = startMonthStr.split("-").map(Number);
      const startDate = new Date(Date.UTC(sy, sm - 1, 1)).toISOString().slice(0, 10);
      await ensureBenchmarkCache(startDate, endDate, benchmarkCode);
    }

    const data = await loadFundPortfolioTrendData(ctx, {
      startMonth,
      endMonth,
      accountIds,
      includeBenchmark,
      benchmarkCode: benchmarkCode ?? undefined,
    });

    return NextResponse.json({
      ok: true,
      points: data.points,
      emptyMonths: data.emptyMonths,
      benchmark: data.benchmark,
      benchmarkCode: data.benchmarkCode,
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "LOAD_FAILED",
        error: e instanceof Error ? e.message : "加载基金趋势数据失败。",
      },
      { status: 500 },
    );
  }
}
