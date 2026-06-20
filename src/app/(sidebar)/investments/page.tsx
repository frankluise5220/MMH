import { AccountKind } from "@prisma/client";
import { ArrowLeft } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { formatAccountDisplayName } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { formatMoney } from "@/lib/format";
import { computeInvestBalances } from "@/lib/invest-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

const INVEST_KINDS = [AccountKind.investment];

function investProductTypeLabel(type: string | null) {
  if (type === "fund") return "开放式基金";
  if (type === "money") return "货币基金";
  return "投资账户";
}

export default async function InvestmentsPage() {
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) =>
    n > 0
      ? isRedUp
        ? "text-red-600"
        : "text-emerald-700"
      : n < 0
        ? isRedUp
          ? "text-emerald-700"
          : "text-red-600"
        : "text-slate-600";

  const [accounts, investBalById] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, kind: { in: INVEST_KINDS }, ...hidFilter },
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ name: "asc" }],
    }),
    computeInvestBalances(ctx),
  ]);

  const total = accounts.reduce((sum, account) => {
    const detail = investBalById.get(account.id);
    return sum + (detail?.marketValue ?? 0);
  }, 0);

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="p-2 rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">投资分账户</h1>
          <p className="text-sm text-slate-500 mt-1">共 {accounts.length} 个投资账户，按分组和机构清晰显示</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <span className="font-semibold">投资合计</span>
          <span className="text-xl font-bold tabular-nums text-slate-900">{formatMoney(total)}</span>
        </div>
      </div>

      <div className="space-y-3">
        {accounts.map((account) => {
          const detail = investBalById.get(account.id);
          const marketValue = detail?.marketValue ?? 0;
          const floatingPnL = detail?.floatingPnL ?? 0;
          const accountLabel = formatAccountDisplayName(account.name, account.Institution?.name);
          const groupName = account.AccountGroup?.name?.trim() || "未分组";
          const productType = investProductTypeLabel(account.investProductType);

          return (
            <Link
              key={account.id}
              href={`/?accountId=${account.id}&view=${account.investProductType === "money" ? "investmoney" : "investfund"}`}
              className="block bg-white rounded-xl border border-slate-200 px-5 py-4 hover:border-blue-200 hover:shadow-sm transition-all"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                      {groupName}
                    </span>
                    <span className="text-xs text-slate-400">{productType}</span>
                  </div>
                  <div className="truncate text-base font-semibold text-foreground">{accountLabel}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    浮动盈亏
                    <span className={`ml-2 font-medium tabular-nums ${pnlCls(floatingPnL)}`}>
                      {formatMoney(floatingPnL)}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <div className="text-xs text-slate-400">当前市值</div>
                  <div className="mt-1 text-lg font-bold tabular-nums text-slate-900">
                    {formatMoney(marketValue)}
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
        {accounts.length === 0 && <div className="text-center py-8 text-slate-400">暂无投资账户</div>}
      </div>
    </div>
  );
}
