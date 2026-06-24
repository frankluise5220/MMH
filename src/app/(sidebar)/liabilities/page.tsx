import { AccountKind } from "@prisma/client";
import { ArrowLeftRight, Building2, CreditCard, HandCoins, Landmark } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { buildAccountDisplayOption } from "@/lib/account-display";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { formatMoney } from "@/lib/format";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

const DEBT_KINDS = [AccountKind.bank_credit, AccountKind.loan];

function yuan(value: number) {
  return `¥${formatMoney(value)}`;
}

function amountClass(value: number, intent: "payable" | "receivable" | "neutral" = "neutral") {
  if (value === 0) return "text-slate-500";
  if (intent === "receivable") return "text-emerald-700";
  if (intent === "payable") return "text-rose-700";
  return value > 0 ? "text-slate-900" : "text-slate-500";
}

function directionOf(account: { kind: AccountKind; balance: unknown }): "payable" | "receivable" {
  if (account.kind === AccountKind.bank_credit) return "payable";
  return toNumber(account.balance) >= 0 ? "receivable" : "payable";
}

function kindLabel(kind: AccountKind) {
  if (kind === AccountKind.bank_credit) return "信用卡";
  if (kind === AccountKind.loan) return "借入/借出";
  return "借入借出账户";
}

function dayLabel(day: number | null) {
  return day ? `${day}日` : "未设置";
}

export default async function LiabilitiesPage() {
  const cookieStore = await cookies();
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const { hidFilter } = await getHouseholdScope();
  const accounts = await prisma.account.findMany({
    where: { isActive: true, isPlaceholder: { not: true }, kind: { in: DEBT_KINDS }, ...hidFilter },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const rows = accounts.map((account) => {
    const direction = directionOf(account);
    const balance = toNumber(account.balance);
    const amount = Math.abs(balance);
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelMode);
    const institutionName = display.institutionName || "未设置往来机构/人员";
    const debtPersonKey = institutionName
      ? `institution:${account.institutionId ?? institutionName}`
      : `account:${account.id}`;
    return {
      id: account.id,
      name: display.label,
      shortName: account.name,
      kind: account.kind,
      direction,
      balance,
      amount,
      groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
      institutionName,
      billingDay: account.billingDay,
      repaymentDay: account.repaymentDay,
      creditLimit: account.creditLimit == null ? 0 : toNumber(account.creditLimit),
      numberMasked: account.numberMasked,
      debtPersonKey,
    };
  });

  const payableTotal = rows.filter((row) => row.direction === "payable").reduce((sum, row) => sum + row.amount, 0);
  const receivableTotal = rows.filter((row) => row.direction === "receivable").reduce((sum, row) => sum + row.amount, 0);
  const creditTotal = rows.filter((row) => row.kind === AccountKind.bank_credit).reduce((sum, row) => sum + row.amount, 0);
  const loanTotal = rows.filter((row) => row.kind === AccountKind.loan && row.direction === "payable").reduce((sum, row) => sum + row.amount, 0);
  const netDebt = payableTotal - receivableTotal;

  const institutionRows = Array.from(
    rows.reduce((map, row) => {
      const current = map.get(row.institutionName) ?? {
        key: row.debtPersonKey,
        name: row.institutionName,
        payable: 0,
        receivable: 0,
        count: 0,
      };
      current.count += 1;
      if (row.direction === "receivable") current.receivable += row.amount;
      else current.payable += row.amount;
      map.set(row.institutionName, current);
      return map;
    }, new Map<string, { key: string; name: string; payable: number; receivable: number; count: number }>()),
  ).map(([, value]) => value).sort((a, b) => (b.payable + b.receivable) - (a.payable + a.receivable));

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">借入借出</div>
            <div className="text-xs text-slate-500">往来机构/人员、余额列表和明细</div>
          </div>
          <Link href="/settings/accounts" className="secondary-button h-8 px-3 text-xs">
            管理借入借出账户
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-5">
            <SummaryCard label="总余额" value={receivableTotal - payableTotal} intent={receivableTotal >= payableTotal ? "receivable" : "payable"} />
            <SummaryCard label="借入余额" value={payableTotal} intent="payable" />
            <SummaryCard label="借出余额" value={receivableTotal} intent="receivable" />
            <SummaryCard label="信用卡" value={creditTotal} intent="payable" />
            <SummaryCard label="借入/借出" value={loanTotal} intent="payable" />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.85fr_1.25fr]">
          <div className="panel-surface">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-blue-500" />
                往来机构/人员
              </div>
              <div className="text-xs text-slate-400">{institutionRows.length} 个对象</div>
            </div>
            <div className="divide-y divide-slate-100">
              {institutionRows.length > 0 ? (
                institutionRows.map((institution) => (
                  <Link key={institution.key} href={`/?view=debt&debtPerson=${encodeURIComponent(institution.key)}`} className="block px-4 py-3 hover:bg-slate-50">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-800">{institution.name}</div>
                        <div className="mt-1 text-xs text-slate-400">{institution.count} 个账户</div>
                      </div>
                      <div className="text-right text-xs tabular-nums">
                        <div className={amountClass(institution.payable, "payable")}>欠款 {yuan(institution.payable)}</div>
                        <div className={amountClass(institution.receivable, "receivable")}>应收 {yuan(institution.receivable)}</div>
                      </div>
                    </div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">暂无往来机构/人员</div>
              )}
            </div>
          </div>

          <div className="panel-surface">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <ArrowLeftRight className="h-4 w-4 text-cyan-500" />
                余额列表
              </div>
              <div className="text-xs text-slate-400">点击查看明细</div>
            </div>
            <div className="divide-y divide-slate-100">
              {rows.length > 0 ? (
                rows.map((row) => {
                  const Icon = row.kind === AccountKind.bank_credit ? CreditCard : HandCoins;
                  const href = row.kind === AccountKind.loan
                    ? `/?view=debt&debtPerson=${encodeURIComponent(row.debtPersonKey)}`
                    : `/?accountId=${row.id}&view=bill`;
                  return (
                    <Link key={row.id} href={href} className="block px-4 py-4 hover:bg-slate-50">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-800">{row.name}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{kindLabel(row.kind)}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.groupName}</span>
                            <span
                              className={`rounded border px-1.5 py-0.5 ${
                                row.direction === "receivable"
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-rose-200 bg-rose-50 text-rose-700"
                              }`}
                            >
                              {row.direction === "receivable" ? "借出" : "借入"}
                            </span>
                            <span>账单日 {dayLabel(row.billingDay)}</span>
                            <span>还款日 {dayLabel(row.repaymentDay)}</span>
                            {row.numberMasked ? <span>尾号 {row.numberMasked}</span> : null}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-xs text-slate-400">{row.direction === "receivable" ? "借出余额" : "借入余额"}</div>
                          <div className={`mt-1 text-sm font-semibold tabular-nums ${amountClass(row.amount, row.direction)}`}>
                            {yuan(row.amount)}
                          </div>
                          {row.creditLimit > 0 ? <div className="mt-1 text-[11px] text-slate-400">额度 {yuan(row.creditLimit)}</div> : null}
                        </div>
                      </div>
                    </Link>
                  );
                })
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">
                  暂无信用卡或借入借出账户
                </div>
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
  intent,
}: {
  label: string;
  value: number;
  intent: "payable" | "receivable";
}) {
  const Icon = intent === "receivable" ? Landmark : CreditCard;
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-2 text-base font-semibold tabular-nums ${amountClass(value, intent)}`}>{yuan(value)}</div>
    </div>
  );
}
