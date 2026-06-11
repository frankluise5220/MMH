import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { computeInvestBalances } from "@/lib/invest-balance";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

const kindOrder: AccountKind[] = [
  AccountKind.cash,
  AccountKind.bank_debit,
  AccountKind.bank_credit,
  AccountKind.investment,
  AccountKind.ewallet,
  AccountKind.loan,
  AccountKind.other,
];

function kindLabel(kind: AccountKind) {
  if (kind === AccountKind.cash) return "现金";
  if (kind === AccountKind.bank_debit) return "借记卡";
  if (kind === AccountKind.bank_credit) return "信用卡";
  if (kind === AccountKind.investment) return "投资";
  if (kind === AccountKind.ewallet) return "电子钱包";
  if (kind === AccountKind.loan) return "贷款";
  return "其他";
}

export default async function OverviewPage() {
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) => n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";

  const accountIds = (await prisma.account.findMany({
    where: { isActive: true, ...hidFilter },
    select: { id: true },
  })).map(a => a.id);

  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, ...hidFilter },
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { accountId: { in: accountIds } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const sumByAccountId = new Map<string, { balance: number; count: number }>();
  for (const row of sums) {
    if (!row.accountId) continue;
    sumByAccountId.set(row.accountId, {
      balance: toNumber(row._sum.amount),
      count: row._count._all,
    });
  }

  const investBalByAccountId = await computeInvestBalances(ctx);

  const accountsByKind = new Map<AccountKind, Array<{ id: string; name: string; label: string; balance: number; count: number }>>();
  for (const kind of kindOrder) accountsByKind.set(kind, []);

  for (const a of accounts) {
    const stats = sumByAccountId.get(a.id) ?? { balance: 0, count: 0 };
    const inst = a.Institution?.name?.trim() || "";
    const investDetail = investBalByAccountId.get(a.id);
      const entry = {
        id: a.id,
        name: a.name,
        label: inst ? `${inst}·${a.name}` : a.name,
        balance: a.kind === AccountKind.investment
          ? (investDetail?.marketValue ?? 0)
          : Number(a.balance),
      count: stats.count,
    };
    const bucket = accountsByKind.get(a.kind) ?? accountsByKind.get(AccountKind.other);
    bucket?.push(entry);
  }

  const summary = kindOrder.map((kind) => {
    const list = accountsByKind.get(kind) ?? [];
    const total = list.reduce((acc, x) => acc + x.balance, 0);
    const count = list.reduce((acc, x) => acc + x.count, 0);
    return { kind, label: kindLabel(kind), total, count };
  });

  const grandTotal = summary.reduce((acc, s) => acc + s.total, 0);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
      <div className="shrink-0 h-12 flex items-center px-4 border-b border-slate-200 bg-white">
        <span className="text-sm font-semibold text-slate-800">WiseMe</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">资产概览</div>
          <div className="px-4 py-3 text-sm text-slate-600">
            <span className="font-medium">净资产：</span>
            <span className={`font-semibold tabular-nums ${pnlCls(grandTotal)}`}>{formatMoney(grandTotal)}</span>
          </div>
          {summary.filter(s => s.total !== 0 || s.count > 0).map((s) => (
            <div key={s.kind} className="px-4 py-2 border-t border-slate-100 flex items-center justify-between">
              <div>
                <span className="text-xs text-slate-500">{s.label}</span>
                <span className="ml-2 text-xs text-slate-400">{s.count}笔</span>
              </div>
              <span className={`text-sm tabular-nums font-medium ${pnlCls(s.total)}`}>{formatMoney(s.total)}</span>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">账户详情</div>
          {summary.map((s) => (
            <div key={s.kind} className="border-t border-slate-100">
              <div className="px-4 py-2 bg-slate-50 text-xs text-slate-500 font-medium">{s.label}</div>
              {(accountsByKind.get(s.kind) ?? []).map((a) => (
                <div key={a.id} className="px-4 py-2.5 flex items-center justify-between border-t border-slate-50">
                  <span className="text-sm text-slate-700">{a.label}</span>
                  <span className={`text-sm tabular-nums ${pnlCls(a.balance)}`}>{formatMoney(a.balance)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}