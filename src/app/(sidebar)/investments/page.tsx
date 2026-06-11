import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { computeInvestBalances } from "@/lib/invest-balance";
import { formatMoney } from "@/lib/format";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

const INVEST_KINDS = [AccountKind.investment];

export default async function InvestmentsPage() {
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) => n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";

  const [accounts, investBalById] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, kind: { in: INVEST_KINDS }, ...hidFilter },
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ name: "asc" }],
    }),
    computeInvestBalances(ctx),
  ]);

  const total = accounts.reduce((s, a) => {
    const d = investBalById.get(a.id);
    return s + (d?.marketValue ?? 0);
  }, 0);

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="p-2 rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">📈 投资</h1>
          <p className="text-sm text-slate-500 mt-1">共 {accounts.length} 个账户</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <span className="font-semibold">投资合计</span>
          <span className={`text-xl font-bold tabular-nums ${pnlCls(total)}`}>{formatMoney(total)}</span>
        </div>
      </div>

      <div className="space-y-3">
        {accounts.map(a => {
          const d = investBalById.get(a.id);
          const bal = d?.marketValue ?? 0;
          const pnl = d?.floatingPnL ?? 0;
          const instLabel = a.Institution?.name?.trim() || "";
          const prefix = instLabel ? `${instLabel}·` : "";
          return (
            <Link
              key={a.id}
              href={`/?accountId=${a.id}&view=${a.investProductType === "money" ? "investmoney" : "investfund"}`}
              className="block bg-white rounded-xl border border-slate-200 px-6 py-4 hover:border-blue-200 hover:shadow-sm transition-all"
            >
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold text-foreground">{prefix}{a.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {a.investProductType === "fund" ? "开放式基金" : a.investProductType === "money" ? "货币基金" : a.investProductType || "投资"}
                    {pnl !== 0 && <span className={`ml-2 ${pnlCls(pnl)}`}>浮盈 {formatMoney(pnl)}</span>}
                  </div>
                </div>
                <div className={`text-lg font-bold tabular-nums ${pnlCls(bal)}`}>{formatMoney(bal)}</div>
              </div>
            </Link>
          );
        })}
        {accounts.length === 0 && (
          <div className="text-center py-8 text-slate-400">暂无投资账户</div>
        )}
      </div>
    </div>
  );
}