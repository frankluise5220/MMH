import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { formatMoney } from "@/lib/format";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

const ASSET_KINDS = [AccountKind.cash, AccountKind.bank_debit, AccountKind.ewallet];

export default async function AssetsPage() {
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) => n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";

  const accounts = await prisma.account.findMany({
    where: { isActive: true, kind: { in: ASSET_KINDS }, ...hidFilter },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ name: "asc" }],
  });

  const total = accounts.reduce((sum, account) => sum + Number(account.balance), 0);


  return (
    <div className="flex-1 min-h-0 flex flex-col p-6 max-w-2xl overflow-y-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="p-2 rounded-lg hover:bg-slate-100 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">💰 资产</h1>
          <p className="text-sm text-slate-500 mt-1">共 {accounts.length} 个账户</p>
        </div>
      </div>

      <div className="page-card overflow-hidden mb-6">
        <div className="page-card-header">
          <span className="page-title">资产合计</span>
          <span className={`text-xl font-bold tabular-nums ${pnlCls(total)}`}>{formatMoney(total)}</span>
        </div>
      </div>

      <div className="space-y-3">
        {accounts.map(a => {
          const bal = Number(a.balance);
          const instLabel = a.Institution?.name?.trim() || "";
          const prefix = instLabel ? `${instLabel}·` : "";
          return (
            <Link
              key={a.id}
              href={`/?accountId=${a.id}&view=detail`}
              className="block page-card px-6 py-4 transition-all"
            >
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold text-foreground">{prefix}{a.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {a.kind === AccountKind.cash ? "现金" : a.kind === AccountKind.bank_debit ? "借记卡" : "电子钱包"}
                  </div>
                </div>
                <div className={`text-lg font-bold tabular-nums ${pnlCls(bal)}`}>{formatMoney(bal)}</div>
              </div>
            </Link>
          );
        })}
        {accounts.length === 0 && (
          <div className="text-center py-8 text-slate-400">暂无资产账户</div>
        )}
      </div>
    </div>
  );
}
