import { AccountKind, TransactionType } from "@prisma/client";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import { computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

export default async function FundsPage({
  searchParams,
}: {
  searchParams?: Promise<{ accountId?: string; symbol?: string }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) =>
    n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";

  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;

  const accountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const symbolParam = typeof params?.symbol === "string" ? params.symbol.trim() : "";

  const fundAccounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, isActive: true, ...hidFilter },
    include: { Institution: true },
    orderBy: [{ name: "asc" }],
  });

  const selectedAccount = accountId
    ? (fundAccounts.find((account) => account.id === accountId) ?? fundAccounts[0])
    : fundAccounts[0];

  if (!selectedAccount) {
    return <div className="p-6 text-sm text-slate-500">暂无基金账户</div>;
  }

  const fundUnitsDecimals = normalizeFundUnitsDecimals(selectedAccount.fundUnitsDecimals, 3);
  const formatFundUnits = (value: number) => value.toFixed(fundUnitsDecimals);

  const [investBalByAccountId, positionDisplay] = await Promise.all([
    computeInvestBalances(ctx),
    computePositionDisplay(ctx, selectedAccount.id),
  ]);

  const investBalance = investBalByAccountId.get(selectedAccount.id)?.marketValue ?? 0;
  const { positions, totalMarketValue, totalCost } = positionDisplay;
  const totalPnL = totalMarketValue - totalCost;

  const allEntries = await prisma.txRecord.findMany({
    where: {
      OR: [{ accountId: selectedAccount.id }, { toAccountId: selectedAccount.id }],
      deletedAt: null,
      type: TransactionType.investment,
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 2000,
  });

  const selectedSymbol = symbolParam || (positions.length > 0 ? positions[0]!.fundCode : "");
  const filteredEntries = selectedSymbol
    ? allEntries.filter((entry) => (entry.fundCode ?? "") === selectedSymbol)
    : allEntries;

  return (
    <div className="flex h-full w-full">
      <div className="flex w-48 shrink-0 flex-col overflow-y-auto border-r border-foreground/10 bg-surface-white/80">
        <div className="border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">基金账户</div>
        {fundAccounts.map((account) => {
          const active = account.id === selectedAccount.id;
          const bal = investBalByAccountId.get(account.id)?.marketValue ?? 0;
          const label = account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name;
          return (
            <a
              key={account.id}
              href={`/funds?accountId=${account.id}`}
              className={`flex items-center justify-between px-3 py-2 text-xs ${active ? "bg-blue-50 font-medium text-blue-700" : "text-slate-700 hover:bg-slate-50"}`}
            >
              <span className="truncate">{label}</span>
              <span
                className={`ml-1 shrink-0 text-[10px] font-medium tabular-nums ${
                  bal > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : bal < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-slate-700"
                }`}
              >
                {formatMoney(bal)}
              </span>
            </a>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <span className="text-sm font-semibold text-slate-800">{selectedAccount.name}</span>
            <span
              className={`text-sm font-semibold tabular-nums ${
                investBalance > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : investBalance < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-slate-800"
              }`}
            >
              {formatMoney(investBalance)}
            </span>
          </div>
          <div className="grid grid-cols-3 divide-x divide-slate-100">
            {[
              { label: "总市值", value: formatMoney(totalMarketValue), cls: pnlCls(totalMarketValue) },
              { label: "持仓成本", value: formatMoney(totalCost) },
              {
                label: "浮盈",
                value: formatMoney(totalPnL),
                cls: totalPnL > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : totalPnL < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-slate-800",
              },
            ].map((item) => (
              <div key={item.label} className="px-4 py-3 text-center">
                <div className="text-[10px] text-slate-500">{item.label}</div>
                <div className={`text-sm font-semibold tabular-nums ${item.cls ?? "text-slate-800"}`}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>

        {positions.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">持仓明细</div>
            <div className="overflow-auto">
              <table className="min-w-[600px] w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="border-b border-slate-200 px-4 py-2 text-left text-xs font-semibold text-slate-600">基金</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">份额</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">净值</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">持仓成本</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">市值（含未确认金额）</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position) => (
                    <tr key={position.fundCode} className="hover:bg-slate-50">
                      <td className="border-b border-slate-100 px-4 py-2 text-xs text-slate-800">{position.name}</td>
                      <td className="border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-600">
                        {formatFundUnits(position.units)}
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums">
                        {position.nav != null ? position.nav.toFixed(4) : "—"}
                        {position.navDate ? <span className="ml-0.5 text-slate-400">({position.navDate})</span> : null}
                      </td>
                      <td className="border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-600">{formatMoney(position.cost)}</td>
                      <td className={`border-b border-slate-100 px-3 py-2 text-right text-xs tabular-nums ${pnlCls(position.marketValue)}`}>
                        {formatMoney(position.marketValue)}
                        {position.pendingCost > 0 ? <span className="ml-1 text-amber-600">({formatMoney(position.pendingCost)})</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-white">
                  <tr>
                    <td className="border-t border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700">合计</td>
                    <td className="border-t border-slate-200 px-3 py-2 text-right text-xs tabular-nums text-slate-600">
                      {formatFundUnits(positions.reduce((sum, position) => sum + position.units, 0))}
                    </td>
                    <td className="border-t border-slate-200 px-3 py-2" />
                    <td className="border-t border-slate-200 px-3 py-2 text-right text-xs font-semibold tabular-nums text-slate-800">{formatMoney(totalCost)}</td>
                    <td className={`border-t border-slate-200 px-3 py-2 text-right text-xs font-semibold tabular-nums ${pnlCls(totalMarketValue)}`}>
                      {formatMoney(totalMarketValue)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : null}

        {filteredEntries.length === 0 ? null : <div className="hidden" data-entry-count={filteredEntries.length} />}
      </div>
    </div>
  );
}
