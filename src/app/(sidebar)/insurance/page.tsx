import { cookies } from "next/headers";
import Link from "next/link";
import { Shield, Building2, UserRound, ArrowDownLeft, ArrowUpRight } from "lucide-react";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { formatMoney } from "@/lib/format";
import { toNumber } from "@/lib/date-utils";

export const dynamic = "force-dynamic";

function amountClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function productTypeLabel(type: string | null) {
  switch (type) {
    case "savings": return "储蓄型";
    case "dividend": return "分红型";
    case "annuity": return "年金型";
    case "universal": return "万能型";
    case "investment_linked": return "投连型";
    case "critical_illness": return "重疾险";
    case "medical": return "医疗险";
    case "accident": return "意外险";
    case "term_life": return "定期寿险";
    case "whole_life": return "终身寿险";
    default: return "保险";
  }
}

export default async function InsurancePage() {
  const { hidFilter } = await getHouseholdScope();
  const cookieStore = await cookies();
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );

  const products = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { include: { AccountGroup: true, Institution: true } },
      Institution: true,
      OwnerGroup: true,
      InsuredUser: true,
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  const productIds = products.map((item) => item.id);
  const entries = productIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          ...hidFilter,
          deletedAt: null,
          type: "investment",
          source: "insurance",
          insuranceProductId: { in: productIds },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      })
    : [];

  const rows = products.map((product) => {
    const account = product.Account;
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelTemplate);

    const relatedEntries = entries.filter((entry) => entry.insuranceProductId === product.id);
    const balance = relatedEntries.reduce((sum, entry) => {
      return sum + (entry.fundSubtype === "redeem" ? -Math.abs(toNumber(entry.amount)) : Math.abs(toNumber(entry.amount)));
    }, 0);

    return {
      id: product.id,
      name: product.name,
      shortName: product.shortName?.trim() || "",
      typeLabel: productTypeLabel(product.productType),
      institutionName: product.Institution?.name?.trim() || account.Institution?.name?.trim() || "未设机构",
      ownerName: product.OwnerGroup?.name?.trim() || account.AccountGroup?.name?.trim() || "未设所有人",
      insuredUserName: product.InsuredUser?.name?.trim() || "",
      accountId: account.id,
      accountLabel: display.label,
      balance,
      buyCount: relatedEntries.filter((entry) => entry.fundSubtype === "buy").length,
      redeemCount: relatedEntries.filter((entry) => entry.fundSubtype === "redeem").length,
      entries: relatedEntries,
    };
  });

  const grouped = Array.from(
    rows.reduce((map, row) => {
      const key = `${row.institutionName}__${row.ownerName}`;
      const current = map.get(key) ?? {
        key,
        institutionName: row.institutionName,
        ownerName: row.ownerName,
        rows: [] as typeof rows,
      };
      current.rows.push(row);
      map.set(key, current);
      return map;
    }, new Map<string, { key: string; institutionName: string; ownerName: string; rows: typeof rows }>()),
  )
    .map(([, value]) => value)
    .sort((a, b) => {
      const inst = a.institutionName.localeCompare(b.institutionName, "zh-Hans-CN");
      if (inst !== 0) return inst;
      return a.ownerName.localeCompare(b.ownerName, "zh-Hans-CN");
    });

  const totalBalance = rows.reduce((sum, row) => sum + row.balance, 0);
  const totalBuy = rows.reduce((sum, row) => sum + row.buyCount, 0);
  const totalRedeem = rows.reduce((sum, row) => sum + row.redeemCount, 0);

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">保险</div>
            <div className="text-xs text-slate-500">按机构与所有人查看保险产品、买入和赎回记录</div>
          </div>
          <Link href="/" className="primary-button h-8 px-3 text-xs">
            记一笔
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <SummaryCard label="保险产品" value={String(rows.length)} />
            <SummaryCard label="当前持仓" value={formatMoney(totalBalance)} valueClass={amountClass(totalBalance)} />
            <SummaryCard label="买入记录" value={String(totalBuy)} />
            <SummaryCard label="赎回记录" value={String(totalRedeem)} />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.25fr]">
          <div className="panel-surface overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-blue-500" />
                左侧分组
              </div>
              <div className="text-xs text-slate-400">机构 - 所有人</div>
            </div>
            <div className="divide-y divide-slate-100">
              {grouped.length > 0 ? grouped.map((group) => (
                <div key={group.key} className="px-4 py-3">
                  <div className="text-sm font-semibold text-slate-800">{group.institutionName}</div>
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2 pl-3 text-xs text-slate-500">
                      <UserRound className="h-3.5 w-3.5" />
                      {group.ownerName}
                    </div>
                    <div className="space-y-1 pl-6">
                      {group.rows.map((row) => (
                        <Link
                          key={row.id}
                          href={`/?accountId=${row.accountId}&view=investfund`}
                          className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <span className="min-w-0 flex-1 truncate">{row.name}</span>
                          <span className={`tabular-nums font-medium ${amountClass(row.balance)}`}>{formatMoney(row.balance)}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              )) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">暂无保险产品</div>
              )}
            </div>
          </div>

          <div className="panel-surface overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Shield className="h-4 w-4 text-cyan-500" />
                保险持仓
              </div>
              <div className="text-xs text-slate-400">按保险产品查看买入和赎回记录</div>
            </div>
            <div className="divide-y divide-slate-100">
              {rows.length > 0 ? rows.map((row) => (
                <div key={row.id} className="px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        {row.name}
                        <span className="ml-2 text-xs font-normal text-slate-500">{row.typeLabel}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.institutionName}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.ownerName}</span>
                        {row.insuredUserName ? <span className="rounded bg-slate-100 px-1.5 py-0.5">被保人 {row.insuredUserName}</span> : null}
                        <span>账户 {row.accountLabel}</span>
                        <span>买入 {row.buyCount}</span>
                        <span>赎回 {row.redeemCount}</span>
                      </div>
                    </div>
                    <div className={`shrink-0 text-right text-sm font-semibold tabular-nums ${amountClass(row.balance)}`}>
                      {formatMoney(row.balance)}
                    </div>
                  </div>

                  <div className="mt-3 overflow-auto">
                    <table className="min-w-[720px] w-full border-separate border-spacing-0">
                      <thead>
                        <tr>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">日期</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">动作</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">资金账户</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">备注</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-right text-xs font-semibold text-slate-600">金额</th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.entries.length > 0 ? row.entries.map((entry) => {
                          const cashLabel =
                            entry.fundSubtype === "redeem"
                              ? (entry.toAccountName ?? "-")
                              : (entry.accountName ?? "-");
                          const amount = entry.fundSubtype === "redeem"
                            ? Math.abs(toNumber(entry.amount))
                            : toNumber(entry.amount);
                          const displayAmount = entry.fundSubtype === "redeem" ? amount : -Math.abs(amount);
                          return (
                            <tr key={entry.id} className="hover:bg-slate-50">
                              <td className="border-b border-slate-100 px-2 py-2 text-xs text-slate-700 tabular-nums">{entry.date.toISOString().slice(0, 10)}</td>
                              <td className="border-b border-slate-100 px-2 py-2 text-xs text-slate-700">
                                <span className="inline-flex items-center gap-1">
                                  {entry.fundSubtype === "redeem" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
                                  {entry.fundSubtype === "redeem" ? "赎回" : "买入"}
                                </span>
                              </td>
                              <td className="border-b border-slate-100 px-2 py-2 text-xs text-slate-600">{cashLabel}</td>
                              <td className="max-w-[280px] truncate border-b border-slate-100 px-2 py-2 text-xs text-slate-600" title={entry.note ?? ""}>
                                {entry.note || "-"}
                              </td>
                              <td className={`border-b border-slate-100 px-2 py-2 text-right text-xs font-semibold tabular-nums ${amountClass(displayAmount)}`}>
                                {formatMoney(displayAmount)}
                              </td>
                            </tr>
                          );
                        }) : (
                          <tr>
                            <td className="px-2 py-6 text-center text-xs text-slate-400" colSpan={5}>暂无记录</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">暂无保险持仓</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  valueClass = "text-slate-900",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
