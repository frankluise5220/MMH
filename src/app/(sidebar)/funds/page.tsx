import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import { formatMoney, formatMoney4 } from "@/lib/format";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export default async function FundsPage({
  searchParams,
}: {
  searchParams?: Promise<{ accountId?: string; symbol?: string }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) => n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;

  const accountId =
    typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const symbolParam =
    typeof params?.symbol === "string" ? params.symbol.trim() : "";

  const fundAccounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, isActive: true, ...hidFilter },
    include: { Institution: true },
    orderBy: [{ name: "asc" }],
  });

  const selectedAccount = accountId
    ? (fundAccounts.find((a) => a.id === accountId) ?? fundAccounts[0])
    : fundAccounts[0];

  if (!selectedAccount) {
    return <div className="p-6 text-sm text-slate-500">暂无基金账户</div>;
  }

  // ── 显示层：持仓数据统一从 fundHolding 表读取 ──
  const [investBalByAccountId, positionDisplay] = await Promise.all([
    computeInvestBalances(ctx),
    computePositionDisplay(ctx, selectedAccount.id),
  ]);

  const investBalance = investBalByAccountId.get(selectedAccount.id)?.marketValue ?? 0;
  const { positions, totalMarketValue, totalCost } = positionDisplay;
  const totalPnL = totalMarketValue - totalCost;

  // ── 显示层：交易流水从 txRecord 读取（仅用于列表展示） ──
  const allEntries = await prisma.txRecord.findMany({
    where: {
      OR: [
        { accountId: selectedAccount.id },
        { toAccountId: selectedAccount.id },
      ],
      deletedAt: null,
      type: TransactionType.investment,
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 2000,
  });

  const selectedSymbol =
    symbolParam || (positions.length > 0 ? positions[0]!.fundCode : "");

  const filteredEntries = selectedSymbol
    ? allEntries.filter((e) => {
        const code = e.fundCode ?? "";
        return code === selectedSymbol;
      })
    : allEntries;

  return (
    <div className="flex h-full w-full bg-slate-50">
      <div className="w-48 shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-y-auto">
        <div className="px-4 py-3 text-xs font-semibold text-slate-500 border-b border-slate-100">基金账户</div>
        {fundAccounts.map((a) => {
          const active = a.id === selectedAccount.id;
          const bal = investBalByAccountId.get(a.id)?.marketValue ?? 0;
          const label = a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name;
          return (
            <a key={a.id} href={`/funds?accountId=${a.id}`} className={`px-3 py-2 text-xs truncate flex items-center justify-between ${active ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-700 hover:bg-slate-50"}`}>
              <span className="truncate">{label}</span>
              <span className={`text-[10px] ml-1 shrink-0 tabular-nums font-medium ${bal > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : bal < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-slate-700"}`}>{formatMoney(bal)}</span>
            </a>
          );
        })}
      </div>

      <div className="flex-1 flex flex-col min-w-0 p-4 gap-4 overflow-y-auto">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800">{selectedAccount.name}</span>
            <span className={`text-sm tabular-nums font-semibold ${investBalance > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : investBalance < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-slate-800"}`}>{formatMoney(investBalance)}</span>
          </div>
          <div className="grid grid-cols-3 divide-x divide-slate-100">
            {[
              { label: "总市值", value: formatMoney(totalMarketValue) },
              { label: "持仓成本", value: formatMoney(totalCost) },
              { label: "浮盈", value: formatMoney(totalPnL), cls: totalPnL > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : totalPnL < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-slate-800" },
            ].map((d) => (
              <div key={d.label} className="px-4 py-3 text-center">
                <div className="text-[10px] text-slate-500">{d.label}</div>
                <div className={`text-sm tabular-nums font-semibold ${d.cls ?? "text-slate-800"}`}>{d.value}</div>
              </div>
            ))}
          </div>
        </div>

        {positions.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">持仓明细</div>
            <div className="overflow-auto">
              <table className="min-w-[600px] w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">基金</th>
                    <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">份额</th>
                    <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">净值</th>
                    <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">持仓成本</th>
                    <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">市值（含未确认金额）</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.fundCode} className="hover:bg-slate-50">
                      <td className="px-4 py-2 border-b border-slate-100 text-xs text-slate-800">{p.name}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{p.units.toFixed(2)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.nav != null ? p.nav.toFixed(4) : "—"}{p.navDate ? <span className="ml-0.5 text-slate-400">({p.navDate})</span> : null}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{formatMoney(p.cost)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">
                        {formatMoney(p.marketValue)}
                        {p.pendingCost > 0 && <span className="ml-1 text-amber-600">({formatMoney(p.pendingCost)})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-white">
                  <tr>
                    <td className="px-4 py-2 border-t border-slate-200 text-xs font-semibold text-slate-700">合计</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-600">{positions.reduce((s, p) => s + p.units, 0).toFixed(2)}</td>
                    <td className="px-3 py-2 border-t border-slate-200"></td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold text-slate-800">{formatMoney(totalCost)}</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold text-slate-800">{formatMoney(totalMarketValue)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}