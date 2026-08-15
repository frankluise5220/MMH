import { formatMoney } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import type {
  InvestmentProfitPeriod,
  InvestmentProfitReportRow,
} from "@/lib/server/investment-profit-report";
import { useI18n } from "@/lib/i18n";

const WEEKDAY_LABEL_KEYS = [
  "investmentProfitReport.weekday.mon",
  "investmentProfitReport.weekday.tue",
  "investmentProfitReport.weekday.wed",
  "investmentProfitReport.weekday.thu",
  "investmentProfitReport.weekday.fri",
  "investmentProfitReport.weekday.sat",
  "investmentProfitReport.weekday.sun",
];

type Props = {
  period: InvestmentProfitPeriod;
  year: number;
  month: number;
  rows: InvestmentProfitReportRow[];
  totals: {
    fundProfit: number;
    wealthProfit: number;
    depositProfit: number;
    totalProfit: number;
    count: number;
  };
  isRedUp: boolean;
};

function valueClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "muted");
}

function signedMoney(value: number) {
  return `${value > 0 ? "+" : ""}${formatMoney(value)}`;
}

function periodTitle(t: (key: string) => string, period: InvestmentProfitPeriod, year: number, month: number) {
  if (period === "day") {
    return t("investmentProfitReport.title.day")
      .replace("{year}", String(year))
      .replace("{month}", String(month));
  }
  if (period === "month") return t("investmentProfitReport.title.month").replace("{year}", String(year));
  return t("investmentProfitReport.title.year");
}

function totalLabel(t: (key: string) => string, period: InvestmentProfitPeriod) {
  if (period === "day") return t("investmentProfitReport.total.day");
  if (period === "month") return t("investmentProfitReport.total.month");
  return t("investmentProfitReport.total.year");
}

function totalRowLabel(t: (key: string) => string, period: InvestmentProfitPeriod) {
  if (period === "day") return t("investmentProfitReport.totalRow.day");
  if (period === "month") return t("investmentProfitReport.totalRow.month");
  return t("investmentProfitReport.totalRow.year");
}

function activePeriodLabel(t: (key: string) => string, period: InvestmentProfitPeriod) {
  if (period === "day") return t("investmentProfitReport.activePeriod.day");
  if (period === "month") return t("investmentProfitReport.activePeriod.month");
  return t("investmentProfitReport.activePeriod.year");
}

function dailyCells(rows: InvestmentProfitReportRow[]) {
  const first = rows[0]?.key;
  if (!first) return rows.map((row) => ({ row, pad: false }));
  const [year, month] = first.split("-").map((item) => Number(item));
  const firstDow = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  return [
    ...Array.from({ length: firstDow }, (_, index) => ({ row: null, pad: true, key: `pad-${index}` })),
    ...rows.map((row) => ({ row, pad: false, key: row.key })),
  ];
}

function ProfitNumber({ value, isRedUp }: { value: number; isRedUp: boolean }) {
  return (
    <span className={`tabular-nums font-medium ${valueClass(value, isRedUp)}`}>
      {signedMoney(value)}
    </span>
  );
}

export function InvestmentProfitReport({ period, year, month, rows, totals, isRedUp }: Props) {
  const { t } = useI18n();
  const activeRows = rows.filter((row) => row.count > 0);
  const best = [...activeRows].sort((a, b) => b.totalProfit - a.totalProfit)[0] ?? null;
  const worst = [...activeRows].sort((a, b) => a.totalProfit - b.totalProfit)[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { key: "total", label: totalLabel(t, period), value: totals.totalProfit },
          { key: "fund", label: t("investmentProfitReport.summary.fundProfit"), value: totals.fundProfit },
          { key: "wealth", label: t("investmentProfitReport.summary.wealthProfit"), value: totals.wealthProfit },
          { key: "deposit", label: t("investmentProfitReport.summary.depositProfit"), value: totals.depositProfit },
          { key: "active", label: activePeriodLabel(t, period), value: activeRows.length, count: true },
        ].map((item) => (
          <div key={item.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-[11px] text-slate-500">{item.label}</div>
            <div className={`mt-1 text-base font-semibold tabular-nums ${item.count ? "text-slate-800" : valueClass(item.value, isRedUp)}`}>
              {item.count ? item.value : signedMoney(item.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-slate-800">{periodTitle(t, period, year, month)}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {best
                ? t("investmentProfitReport.bestPeriod")
                    .replace("{name}", best.label)
                    .replace("{amount}", signedMoney(best.totalProfit))
                : t("investmentProfitReport.noProfitRecords")}
              {worst && worst.key !== best?.key
                ? ` · ${t("investmentProfitReport.worstPeriod")
                    .replace("{name}", worst.label)
                    .replace("{amount}", signedMoney(worst.totalProfit))}`
                : ""}
            </div>
          </div>
          <div className={`text-sm font-semibold tabular-nums ${valueClass(totals.totalProfit, isRedUp)}`}>
            {signedMoney(totals.totalProfit)}
          </div>
        </div>

        {period === "day" ? (
          <div className="p-3">
            <div className="grid grid-cols-7 gap-1 border-b border-slate-100 pb-1">
              {WEEKDAY_LABEL_KEYS.map((key) => (
                <div key={key} className="text-center text-[11px] text-slate-400">{t(key)}</div>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {dailyCells(rows).map((cell) => {
                if (!cell.row) return <div key={cell.key} className="min-h-[76px] rounded-md bg-slate-50/30" />;
                const row = cell.row;
                const hasProfit = row.count > 0;
                return (
                  <div
                    key={row.key}
                    className={`min-h-[76px] rounded-md border px-2 py-1.5 ${
                      hasProfit ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/50"
                    }`}
                    title={`${row.subLabel} ${signedMoney(row.totalProfit)}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-600">{row.label}</span>
                      {row.count > 0 ? <span className="text-[10px] text-slate-400">{row.count}</span> : null}
                    </div>
                    <div className={`mt-1 text-xs font-semibold tabular-nums ${valueClass(row.totalProfit, isRedUp)}`}>
                      {hasProfit ? signedMoney(row.totalProfit) : "-"}
                    </div>
                    {hasProfit ? (
                      <div className="mt-1 space-y-0.5 text-[10px] tabular-nums text-slate-400">
                        {row.fundProfit !== 0 ? <div>{t("investmentProfitReport.daily.fund")} {signedMoney(row.fundProfit)}</div> : null}
                        {row.wealthProfit !== 0 ? <div>{t("investmentProfitReport.daily.wealth")} {signedMoney(row.wealthProfit)}</div> : null}
                        {row.depositProfit !== 0 ? <div>{t("investmentProfitReport.daily.deposit")} {signedMoney(row.depositProfit)}</div> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-separate border-spacing-0">
              <thead className="sticky top-0 bg-white">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-2 text-left text-xs font-semibold text-slate-600">{t("investmentProfitReport.colPeriod")}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("investmentProfitReport.summary.fundProfit")}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("investmentProfitReport.summary.wealthProfit")}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("investmentProfitReport.summary.depositProfit")}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("common.total")}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">{t("investmentProfitReport.colSourceCount")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="hover:bg-slate-50">
                    <td className="border-b border-slate-100 px-4 py-2 text-xs font-medium text-slate-700">{row.label}</td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right text-xs"><ProfitNumber value={row.fundProfit} isRedUp={isRedUp} /></td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right text-xs"><ProfitNumber value={row.wealthProfit} isRedUp={isRedUp} /></td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right text-xs"><ProfitNumber value={row.depositProfit} isRedUp={isRedUp} /></td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right text-xs"><ProfitNumber value={row.totalProfit} isRedUp={isRedUp} /></td>
                    <td className="border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-500">{row.count || "-"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-50">
                <tr>
                  <td className="border-t border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700">{totalRowLabel(t, period)}</td>
                  <td className="border-t border-slate-200 px-3 py-2 text-right text-xs"><ProfitNumber value={totals.fundProfit} isRedUp={isRedUp} /></td>
                  <td className="border-t border-slate-200 px-3 py-2 text-right text-xs"><ProfitNumber value={totals.wealthProfit} isRedUp={isRedUp} /></td>
                  <td className="border-t border-slate-200 px-3 py-2 text-right text-xs"><ProfitNumber value={totals.depositProfit} isRedUp={isRedUp} /></td>
                  <td className="border-t border-slate-200 px-3 py-2 text-right text-xs"><ProfitNumber value={totals.totalProfit} isRedUp={isRedUp} /></td>
                  <td className="border-t border-slate-200 px-3 py-2 text-right text-xs tabular-nums text-slate-700">{totals.count || "-"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
