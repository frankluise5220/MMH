import { AccountKind } from "@prisma/client";
import { ArrowLeft } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { formatAccountDisplayName } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { formatMoney } from "@/lib/format";
import type { InvestBalanceDetail } from "@/lib/invest-balance";
import { loadInvestBalances } from "@/lib/server/cached-data";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

const INVEST_KINDS = [AccountKind.investment];
const GROUP_MODES = [
  { key: "group", label: "所有人" },
  { key: "institution", label: "机构" },
  { key: "owner", label: "所有人" },
  { key: "none", label: "不按所有人" },
] as const;

type GroupMode = typeof GROUP_MODES[number]["key"];

function investProductTypeLabel(type: string | null) {
  if (type === "fund") return "开放式基金";
  if (type === "money") return "货币基金";
  return "投资账户";
}

export default async function InvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const groupByParam = typeof params.groupBy === "string" ? params.groupBy : "group";
  const groupBy = GROUP_MODES.some((mode) => mode.key === groupByParam) ? (groupByParam as GroupMode) : "group";
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
      select: {
        id: true,
        name: true,
        investProductType: true,
        AccountGroup: { select: { id: true, name: true, sortOrder: true } },
        Institution: { select: { id: true, name: true } },
        User: { select: { id: true, name: true } },
      },
      orderBy: [{ AccountGroup: { sortOrder: "asc" } }, { name: "asc" }],
    }),
    loadInvestBalances(JSON.stringify(hidFilter)),
  ]);

  const balanceMap = new Map(Object.entries(investBalById) as [string, InvestBalanceDetail][]);
  const rows = accounts.map((account) => {
    const detail = balanceMap.get(account.id);
    const marketValue = detail?.marketValue ?? 0;
    const totalCost = detail?.totalCost ?? 0;
    const floatingPnL = detail?.floatingPnL ?? 0;
    const accountLabel = formatAccountDisplayName(account.name, account.Institution?.name);
    const groupName = account.AccountGroup?.name?.trim() || "未设置所有人";
    const institutionName = account.Institution?.name?.trim() || "未指定机构";
    const ownerName = account.User?.name?.trim() || "未指定";
    const productType = investProductTypeLabel(account.investProductType);

    return {
      id: account.id,
      label: accountLabel,
      groupName,
      groupSort: account.AccountGroup?.sortOrder ?? 9999,
      institutionName,
      ownerName,
      productType,
      marketValue,
      totalCost,
      floatingPnL,
      floatingRate: totalCost > 0 ? floatingPnL / totalCost : 0,
      href: `/?accountId=${account.id}&view=${account.investProductType === "money" ? "investmoney" : "investfund"}`,
    };
  });

  const total = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const totalFloatingPnL = rows.reduce((sum, row) => sum + row.floatingPnL, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);
  const totalFloatingRate = totalCost > 0 ? totalFloatingPnL / totalCost : 0;

  const grouped = new Map<string, { label: string; sort: number; rows: typeof rows }>();
  for (const row of rows) {
    const label =
      groupBy === "institution" ? row.institutionName :
      groupBy === "owner" ? row.ownerName :
      groupBy === "none" ? "全部投资账户" :
      row.groupName;
    const sort = groupBy === "group" ? row.groupSort : label === "未指定" || label === "未指定机构" || label === "未设置所有人" ? 9999 : 0;
    const current = grouped.get(label);
    if (current) current.rows.push(row);
    else grouped.set(label, { label, sort, rows: [row] });
  }

  const groups = Array.from(grouped.values()).sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label, "zh-Hans-CN"));
  for (const group of groups) {
    group.rows.sort((a, b) => b.marketValue - a.marketValue || a.label.localeCompare(b.label, "zh-Hans-CN"));
  }

  function modeHref(mode: GroupMode) {
    const q = new URLSearchParams();
    q.set("groupBy", mode);
    return `/investments?${q.toString()}`;
  }

  function groupTotal(groupRows: typeof rows) {
    const marketValue = groupRows.reduce((sum, row) => sum + row.marketValue, 0);
    const totalCost = groupRows.reduce((sum, row) => sum + row.totalCost, 0);
    const floatingPnL = groupRows.reduce((sum, row) => sum + row.floatingPnL, 0);
    const floatingRate = totalCost > 0 ? floatingPnL / totalCost : 0;
    return { marketValue, totalCost, floatingPnL, floatingRate };
  }

  function fmtRate(value: number) {
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-transparent p-4 md:p-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
              <ArrowLeft size={17} />
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-900">投资分账户</h1>
              <p className="mt-0.5 text-xs text-slate-500">共 {rows.length} 个投资账户，{groups.length} 个所有人</p>
            </div>
          </div>
          <div className="flex items-center rounded-lg bg-slate-100 p-0.5">
            {GROUP_MODES.map((mode) => (
              <Link
                key={mode.key}
                href={modeHref(mode.key)}
                className={`h-7 rounded-md px-3 text-xs leading-7 transition-colors ${groupBy === mode.key ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                {mode.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">投资合计</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{formatMoney(total)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">浮动盈亏</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${pnlCls(totalFloatingPnL)}`}>{formatMoney(totalFloatingPnL)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">浮盈率</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${pnlCls(totalFloatingRate)}`}>{fmtRate(totalFloatingRate)}</div>
          </div>
        </div>

        <div className="space-y-3">
          {groups.map((group) => {
            const gt = groupTotal(group.rows);
            return (
              <section key={group.label} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-800">{group.label}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{group.rows.length} 个账户</div>
                  </div>
                  <div className="grid grid-cols-3 gap-5 text-right text-xs">
                    <div>
                      <div className="text-slate-400">市值</div>
                      <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{formatMoney(gt.marketValue)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">浮盈</div>
                      <div className={`mt-0.5 font-semibold tabular-nums ${pnlCls(gt.floatingPnL)}`}>{formatMoney(gt.floatingPnL)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">浮盈率</div>
                      <div className={`mt-0.5 font-semibold tabular-nums ${pnlCls(gt.floatingRate)}`}>{fmtRate(gt.floatingRate)}</div>
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-slate-100">
                  {group.rows.map((row) => (
                    <Link key={row.id} href={row.href} className="grid grid-cols-[minmax(0,1fr)_120px_120px_86px] items-center gap-3 px-4 py-3 hover:bg-blue-50/40">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800">{row.label}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                          {groupBy !== "group" ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{row.groupName}</span> : null}
                          {groupBy !== "institution" ? <span>{row.institutionName}</span> : null}
                          {groupBy !== "owner" ? <span>{row.ownerName}</span> : null}
                          <span>{row.productType}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">市值</div>
                        <div className="text-xs font-semibold tabular-nums text-slate-800">{formatMoney(row.marketValue)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">浮盈</div>
                        <div className={`text-xs font-semibold tabular-nums ${pnlCls(row.floatingPnL)}`}>{formatMoney(row.floatingPnL)}</div>
                      </div>
                      <div className={`text-right text-xs font-semibold tabular-nums ${pnlCls(row.floatingRate)}`}>
                        {fmtRate(row.floatingRate)}
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
          {rows.length === 0 && <div className="rounded-lg border border-slate-200 bg-white py-8 text-center text-sm text-slate-400">暂无投资账户</div>}
        </div>
      </div>
    </div>
  );
}
