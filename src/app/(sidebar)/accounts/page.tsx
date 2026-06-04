import Link from "next/link";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

function kindLabel(kind: AccountKind) {
  if (kind === AccountKind.cash) return "现金";
  if (kind === AccountKind.bank_debit) return "借记卡";
  if (kind === AccountKind.bank_credit) return "信用卡";
  if (kind === AccountKind.investment) return "投资";
  if (kind === AccountKind.ewallet) return "电子钱包";
  if (kind === AccountKind.loan) return "贷款";
  return "其他";
}

const kindOrder: AccountKind[] = [
  AccountKind.cash,
  AccountKind.bank_debit,
  AccountKind.bank_credit,
  AccountKind.ewallet,
  AccountKind.loan,
  AccountKind.other,
];

export default async function AccountsPage({
  searchParams,
}: {
  searchParams?: Promise<{ group?: string; owner?: string; view?: string }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const pnlCls = (n: number) => n > 0 ? (isRedUp ? "text-red-600" : "text-emerald-700") : n < 0 ? (isRedUp ? "text-emerald-700" : "text-red-600") : "text-slate-600";

  const groupParam =
    typeof params?.group === "string"
      ? params.group.trim()
      : typeof params?.owner === "string"
        ? params.owner.trim()
        : "__all__";
  const view = typeof params?.view === "string" ? params.view.trim() : "kind";

  const [groups, accounts, sums] = await Promise.all([
    prisma.accountGroup.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.account.findMany({
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ isActive: "desc" }, { kind: "asc" }, { name: "asc" }],
    }),
    prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { accountId: { not: "" } },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  const statsByAccountId = new Map<string, { balance: number; count: number }>();
  for (const row of sums) {
    if (!row.accountId) continue;
    statsByAccountId.set(row.accountId, {
      balance: toNumber(row._sum.amount),
      count: row._count as number,
    });
  }

  type AccountRow = {
    id: string;
    name: string;
    label: string;
    currency: string;
    isActive: boolean;
    institutionName: string;
    groupId: string;
    groupName: string;
    kind: AccountKind;
    balance: number;
    count: number;
  };

  const rows: AccountRow[] = accounts.filter((a: (typeof accounts)[number]) => a.kind !== AccountKind.investment).map((a: (typeof accounts)[number]) => {
    const stats = statsByAccountId.get(a.id) ?? { balance: 0, count: 0 };
    const institutionName = a.Institution?.name ?? "";
    const label = institutionName ? `${institutionName}·${a.name}` : a.name;
    return {
      id: a.id,
      name: a.name,
      label,
      currency: a.currency,
      isActive: a.isActive,
      institutionName,
      groupId: a.groupId,
      groupName: a.AccountGroup?.name ?? "",
      kind: a.kind,
      balance: Number(a.balance),
      count: stats.count,
    };
  });

  const assetKinds = new Set<AccountKind>([AccountKind.cash, AccountKind.bank_debit, AccountKind.ewallet, AccountKind.other]);
  const liabilityKinds = new Set<AccountKind>([AccountKind.bank_credit, AccountKind.loan]);

  const assetTotal = rows
    .filter((r) => r.isActive)
    .filter((r) => assetKinds.has(r.kind))
    .reduce((acc, r) => acc + r.balance, 0);
  const liabilityTotal = rows
    .filter((r) => r.isActive)
    .filter((r) => liabilityKinds.has(r.kind))
    .reduce((acc, r) => acc + (r.balance < 0 ? -r.balance : 0), 0);
  const netAssets = assetTotal - liabilityTotal;

  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));

  const groupsWithAccounts = (() => {
    const byGroupId = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byGroupId.get(r.groupId) ?? [];
      list.push(r);
      byGroupId.set(r.groupId, list);
    }
    return [...byGroupId.entries()]
      .map(([groupId, list]) => ({
        groupId,
        title: (groupNameById.get(groupId) ?? list[0]?.groupName ?? "未指定") as string,
        list,
        total: list.reduce((acc, x) => acc + x.balance, 0),
      }))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  })();

  const allGroup = {
    groupId: "__all__",
    title: "全部",
    list: rows,
    total: rows.reduce((acc, x) => acc + x.balance, 0),
  };

  const effectiveGroups =
    !groupParam || groupParam === "all"
      ? groupsWithAccounts
      : groupParam === "__all__"
        ? [allGroup]
        : groupsWithAccounts.filter((g) => g.groupId === groupParam);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="h-12 flex items-center justify-between px-4">
          <div className="text-sm font-semibold text-slate-800">账户中心</div>
          <Link
            href="/settings"
            className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
          >
            系统设置
          </Link>
        </div>
        <div className="h-11 px-4 flex items-center justify-between border-t border-slate-200 bg-slate-50">
          <form method="get" className="flex items-center gap-2">
            <select
              name="group"
              defaultValue={groupParam || "all"}
              className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none"
            >
              <option value="all">按人员分</option>
              <option value="__all__">全部（不分所有者）</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <select
              name="view"
              defaultValue={view}
              className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none"
            >
              <option value="kind">按类型分</option>
              <option value="institution">按机构分</option>
            </select>
            <button className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">
              应用
            </button>
          </form>
          <div className="flex items-center gap-4">
            <div className="text-xs text-slate-600">
              资产：
              <span className={`ml-1 tabular-nums font-semibold ${pnlCls(assetTotal)}`}>
                {formatMoney(assetTotal)}
              </span>
            </div>
            <div className="text-xs text-slate-600">
              负债：
              <span className="ml-1 tabular-nums font-semibold text-red-500">
                {formatMoney(liabilityTotal)}
              </span>
            </div>
            <div className="text-xs text-slate-600">
              总资产：
              <span className={`ml-1 tabular-nums font-semibold ${pnlCls(netAssets)}`}>
                {formatMoney(netAssets)}
              </span>
            </div>
            <div className="text-xs text-slate-500 tabular-nums">{rows.length} 个账户</div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {effectiveGroups
          .filter((g) => g.list.length > 0)
          .map((g) => {
            const subGroups =
              view === "kind"
                ? kindOrder
                    .map((kind) => {
                      const list = g.list.filter((x) => x.kind === kind);
                      return {
                        key: `kind:${kind}`,
                        title: kindLabel(kind),
                        list,
                        total: list.reduce((acc, x) => acc + x.balance, 0),
                      };
                    })
                    .filter((x) => x.list.length > 0)
                : (() => {
                    const map = new Map<string, typeof rows>();
                    for (const r of g.list) {
                      const key = r.institutionName || "未指定机构";
                      const list = map.get(key) ?? [];
                      list.push(r);
                      map.set(key, list);
                    }
                    return [...map.entries()]
                      .map(([title, list]) => ({
                        key: `inst:${title}`,
                        title,
                        list: list.slice().sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN")),
                        total: list.reduce((acc, x) => acc + x.balance, 0),
                      }))
                      .sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
                  })();

            return (
              <div key={g.groupId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-800">{g.title}</div>
                  <div className={`text-sm font-semibold tabular-nums ${pnlCls(g.total)}`}>
                    {formatMoney(g.total)}
                  </div>
                </div>

                <div className="p-3 space-y-3">
                  {subGroups.map((sg) => (
                    <div key={sg.key} className="border border-slate-200 rounded-lg overflow-hidden">
                      <div className="px-4 py-2 bg-white border-b border-slate-200 flex items-center justify-between">
                        <div className="text-xs font-semibold text-slate-700">{sg.title}</div>
                        <div className={`text-xs font-semibold tabular-nums ${pnlCls(sg.total)}`}>
                          {formatMoney(sg.total)}
                        </div>
                      </div>
                      <div className="overflow-auto">
                        <table className="min-w-[800px] w-full border-separate border-spacing-0">
                          <colgroup>
                            <col style={{width: "22%"}} />
                            <col style={{width: "12%"}} />
                            <col style={{width: "12%"}} />
                            <col style={{width: "7%"}} />
                            <col style={{width: "14%"}} />
                            <col style={{width: "8%"}} />
                            <col style={{width: "8%"}} />
                            <col style={{width: "8%"}} />
                          </colgroup>
                          <thead className="sticky top-0 z-10">
                            <tr className="bg-white">
                              <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-100">账户</th>
                              {view === "kind" ? (
                                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">类型</th>
                              ) : (
                                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">机构</th>
                              )}
                              {view === "kind" ? (
                                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">机构</th>
                              ) : (
                                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">类型</th>
                              )}
                              <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">币种</th>
                              <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">余额</th>
                              <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">记录数</th>
                              <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">状态</th>
                              <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-100">查看</th>
                            </tr>
                          </thead>
                          <tbody className="text-sm">
                            {sg.list
                              .slice()
                              .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"))
                              .map((a) => (
                                <tr key={a.id} className="hover:bg-slate-50">
                                  <td className="px-4 py-2 border-b border-slate-100 text-xs text-slate-800 truncate max-w-0">{a.label}</td>
                                  {view === "kind" ? (
                                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">{kindLabel(a.kind)}</td>
                                  ) : (
                                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600 truncate max-w-0">{a.institutionName || "未指定机构"}</td>
                                  )}
                                  {view === "kind" ? (
                                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600 truncate max-w-0">{a.institutionName || ""}</td>
                                  ) : (
                                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">{kindLabel(a.kind)}</td>
                                  )}
                                  <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">{a.currency}</td>
                                  <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnlCls(a.balance)}`}>
                                    {formatMoney(a.balance)}
                                  </td>
                                  <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{a.count}</td>
                                  <td className="px-3 py-2 border-b border-slate-100">
                                    <span
                                      className={`text-xs px-2 py-1 rounded-md border ${
                                        a.isActive
                                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                          : "bg-slate-50 text-slate-500 border-slate-200"
                                      }`}
                                    >
                                      {a.isActive ? "启用" : "停用"}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 border-b border-slate-100">
                                    <Link
                                      href={`/?accountId=${encodeURIComponent(a.id)}`}
                                      className="h-7 inline-flex items-center px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
                                    >
                                      流水
                                    </Link>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
