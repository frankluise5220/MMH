/**
 * Benchmark index registry for the fund portfolio trend chart.
 *
 * Client-safe on purpose: both the server-side trend loader
 * (src/lib/server/fund-portfolio-trend.ts) and the client chart
 * (FundPortfolioTrendChart.tsx) import this module, so it must never
 * pull in prisma or other server-only dependencies.
 *
 * `code` is the BenchmarkCache key; `mirrorCode` is the domestically
 * listed ETF whose NAV history mirrors the index on eastmoney's
 * f10/lsjz endpoint (the index itself has no fund NAV feed there).
 */
export type BenchmarkOption = {
  /** BenchmarkCache code */
  code: string;
  /** ETF whose NAV history mirrors the index (eastmoney fund code) */
  mirrorCode: string;
  /** i18n key for the display label (chip + selector) */
  labelKey: string;
};

export const BENCHMARK_OPTIONS: BenchmarkOption[] = [
  { code: "000300", mirrorCode: "510300", labelKey: "stats.csi300Benchmark" },
  { code: "513100", mirrorCode: "513100", labelKey: "stats.nasdaq100Benchmark" },
  { code: "513500", mirrorCode: "513500", labelKey: "stats.sp500Benchmark" },
];

export const DEFAULT_BENCHMARK_CODE = "000300";

export function resolveBenchmarkCode(code: string | null | undefined): string {
  return BENCHMARK_OPTIONS.some((option) => option.code === code)
    ? (code as string)
    : DEFAULT_BENCHMARK_CODE;
}
