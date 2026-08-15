import { AccountKind } from "@prisma/client";
import { ArrowLeft } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { formatMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import type { InvestBalanceDetail } from "@/lib/invest-balance";
import { loadInvestBalances } from "@/lib/server/cached-data";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getServerT } from "@/lib/server/i18n";
import { MobileInvestments } from "@/components/mobile/MobileInvestments";

export const dynamic = "force-dynamic";

const INVEST_KINDS = [AccountKind.investment];
const GROUP_MODES = [
  { key: "group", labelKey: "investments.groupByOwner" },
  { key: "institution", labelKey: "investments.groupByInstitution" },
  { key: "owner", labelKey: "investments.groupByOwner" },
  { key: "none", labelKey: "investments.groupByNone" },
] as const;

type GroupMode = typeof GROUP_MODES[number]["key"];

function investProductTypeLabel(type: string | null, t: (key: string) => string) {
  if (type === "fund") return t("investment.product.fund");
  if (type === "money") return t("investment.product.money");
  if (type === "wealth") return t("investment.product.wealth");
  if (type === "metal") return t("investment.product.metal");
  if (type === "stock") return t("investment.product.stock");
  if (type === "property") return t("investment.product.property");
  return t("invest.productTypeDefault");
}

export default async function InvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getServerT();
  const groupByParam = typeof params.groupBy === "string" ? params.groupBy : "group";
  const groupBy = GROUP_MODES.some((mode) => mode.key === groupByParam) ? (groupByParam as GroupMode) : "group";
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const pnlCls = (n: number) => pnlClassFromRedUp(n, isRedUp);

  const [accounts, investBalById] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, kind: { in: INVEST_KINDS }, ...hidFilter },
      select: {
        id: true,
        name: true,
        kind: true,
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
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      groupId: account.AccountGroup?.id,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelTemplate);
    const accountLabel = display.label;
    const groupName = account.AccountGroup?.name?.trim() || t("investments.noOwner");
    const institutionName = display.institutionName || t("investments.noInstitution");
    const ownerName = account.User?.name?.trim() || t("investments.unspecified");
    const productType = investProductTypeLabel(account.investProductType, t);

    return {
      id: account.id,
      label: accountLabel,
      hoverTitle: display.hoverTitle,
      groupName,
      groupSort: account.AccountGroup?.sortOrder ?? 9999,
      institutionName,
      ownerName,
      productType,
      marketValue,
      totalCost,
      floatingPnL,
      floatingRate: totalCost > 0 ? floatingPnL / totalCost : 0,
      href: `/?accountId=${account.id}&view=${getInvestmentAccountView(account)}`,
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
      groupBy === "none" ? t("investments.allAccounts") :
      row.groupName;
    const sort = groupBy === "group" ? row.groupSort : label === t("investments.unspecified") || label === t("investments.noInstitution") || label === t("investments.noOwner") ? 9999 : 0;
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
    return formatPercent(value);
  }

  return (
    <>
    <div className="h-full md:hidden">
      <MobileInvestments
        rows={rows}
        total={total}
        totalCost={totalCost}
        totalFloatingPnL={totalFloatingPnL}
        isRedUp={isRedUp}
      />
    </div>
    <div className="hidden h-full md:block">
    <div className="flex-1 min-h-0 overflow-auto bg-transparent p-4 md:p-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
              <ArrowLeft size={17} />
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-900">{t("investments.title")}</h1>
              <p className="mt-0.5 text-xs text-slate-500">{t("investments.summary", { count: rows.length, groupCount: groups.length })}</p>
            </div>
          </div>
          <div className="flex items-center rounded-lg bg-slate-100 p-0.5">
            {GROUP_MODES.map((mode) => (
              <Link
                key={mode.key}
                href={modeHref(mode.key)}
                className={`h-7 rounded-md px-3 text-xs leading-7 transition-colors ${groupBy === mode.key ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                {t(mode.labelKey)}
              </Link>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{t("investments.totalLabel")}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{formatMoney(total)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{t("invest.floatingPnL")}</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${pnlCls(totalFloatingPnL)}`}>{formatMoney(totalFloatingPnL)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{t("invest.floatingRate")}</div>
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
                    <div className="mt-0.5 text-xs text-slate-400">{t("invest.accountCount", { count: group.rows.length })}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-5 text-right text-xs">
                    <div>
                      <div className="text-slate-400">{t("investments.marketValue")}</div>
                      <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{formatMoney(gt.marketValue)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">{t("investments.floatingProfit")}</div>
                      <div className={`mt-0.5 font-semibold tabular-nums ${pnlCls(gt.floatingPnL)}`}>{formatMoney(gt.floatingPnL)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">{t("invest.floatingRate")}</div>
                      <div className={`mt-0.5 font-semibold tabular-nums ${pnlCls(gt.floatingRate)}`}>{fmtRate(gt.floatingRate)}</div>
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-slate-100">
                  {group.rows.map((row) => (
                    <Link key={row.id} href={row.href} title={row.hoverTitle} className="grid grid-cols-[minmax(0,1fr)_120px_120px_86px] items-center gap-3 px-4 py-3 hover:bg-blue-50/40">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800" title={row.hoverTitle}>{row.label}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                          {groupBy !== "group" ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{row.groupName}</span> : null}
                          {groupBy !== "institution" ? <span>{row.institutionName}</span> : null}
                          {groupBy !== "owner" ? <span>{row.ownerName}</span> : null}
                          <span>{row.productType}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">{t("investments.marketValue")}</div>
                        <div className="text-xs font-semibold tabular-nums text-slate-800">{formatMoney(row.marketValue)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">{t("investments.floatingProfit")}</div>
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
          {rows.length === 0 && <div className="rounded-lg border border-slate-200 bg-white py-8 text-center text-sm text-slate-400">{t("invest.noAccounts")}</div>}
        </div>
      </div>
    </div>
    </div>
    </>
  );
}
