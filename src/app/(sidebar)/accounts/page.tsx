import { AccountKind } from "@prisma/client";
import { Banknote, Coins, CreditCard, HandCoins, Landmark, PiggyBank, Wallet } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import Link from "next/link";

import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { TopEntryLauncher } from "@/components/TopEntryLauncher";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { formatMoney, formatMoneyYuan } from "@/lib/format";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { MobileAccounts } from "@/components/mobile/MobileAccounts";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type CurrentCreditCycle = {
  accountId: string;
  expenseAbs: Prisma.Decimal | number | string | null;
  income: Prisma.Decimal | number | string | null;
  effectiveBill: Prisma.Decimal | number | string | null;
  paid: Prisma.Decimal | number | string | null;
  cumulativeRemain: Prisma.Decimal | number | string | null;
  cumulativeOverpaid: Prisma.Decimal | number | string | null;
  dueDate: Date | null;
};

const MONEY_KINDS: AccountKind[] = [
  AccountKind.bank_debit,
  AccountKind.ewallet,
  AccountKind.cash,
  "deposit" as AccountKind,
  AccountKind.loan,
  AccountKind.other,
];
const CREDIT_KINDS: AccountKind[] = [AccountKind.bank_credit];
const KIND_LABEL: Record<string, string> = {
  bank_debit: "借记卡",
  ewallet: "电子钱包",
  cash: "现金",
  deposit: "存款",
  bank_credit: "信用卡",
  loan: "债务/债权",
  other: "其他",
};
const KIND_ICON = {
  bank_debit: Landmark,
  ewallet: Coins,
  cash: Banknote,
  deposit: PiggyBank,
  bank_credit: CreditCard,
  loan: HandCoins,
  other: Wallet,
};

function dayLabel(day: number | null) {
  return day ? `${day}日` : "未设置";
}

function dateLabel(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : "未生成";
}

function neutralMoneyClass(value: number) {
  return value < 0 ? "text-slate-700" : "text-slate-900";
}

function liabilityMoneyClass(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-emerald-700" : "text-red-700";
  if (value < 0) return isRedUp ? "text-red-700" : "text-emerald-700";
  return "text-slate-900";
}

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const tab = typeof params.tab === "string" && params.tab === "credit" ? "credit" : "assets";
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const isRedUp = colorScheme === "red_up_green_down";

  const accounts = await prisma.account.findMany({
    where: { isActive: true, isPlaceholder: { not: true }, kind: { in: [...MONEY_KINDS, ...CREDIT_KINDS] }, ...hidFilter },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const creditIds = accounts.filter((account) => account.kind === AccountKind.bank_credit).map((account) => account.id);
  const currentCyclesPromise: Promise<CurrentCreditCycle[]> =
    creditIds.length > 0
      ? prisma.creditCardCycle.findMany({
          where: { accountId: { in: creditIds }, isCurrentCycle: true },
          select: {
            accountId: true,
            expenseAbs: true,
            income: true,
            effectiveBill: true,
            paid: true,
            cumulativeRemain: true,
            cumulativeOverpaid: true,
            dueDate: true,
          },
        })
      : Promise.resolve([]);
  const [displayBalanceByAccountId, currentCycles] = await Promise.all([
    computeAccountDisplayBalances(
      accounts
        .filter((account) => account.kind !== AccountKind.bank_credit)
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      hidFilter,
    ),
    currentCyclesPromise,
  ]);
  const cycleByAccountId = new Map<string, CurrentCreditCycle>(currentCycles.map((cycle) => [cycle.accountId, cycle]));

  const moneyAccounts = accounts
    .filter((account) => MONEY_KINDS.includes(account.kind))
    .map((account) => {
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
      return {
        id: account.id,
        name: display.label,
        hoverTitle: display.hoverTitle,
        kind: account.kind,
        groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
        balance: displayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
      };
    });

  const creditAccounts = accounts
    .filter((account) => account.kind === AccountKind.bank_credit)
    .map((account) => {
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
      const cycle = cycleByAccountId.get(account.id);
      const balance = cycle
        ? creditCardDisplayBalanceFromCurrentCycle(cycle)
        : toNumber(account.balance);
      const creditLimit = toNumber(account.creditLimit);
      const currentAmount = toNumber(cycle?.expenseAbs) - toNumber(cycle?.income);
      return {
        id: account.id,
        name: display.label,
        hoverTitle: display.hoverTitle,
        kind: account.kind,
        groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
        balance,
        creditLimit,
        availableLimit: Math.max(0, creditLimit - Math.max(0, balance)),
        currentAmount,
        billingDay: account.billingDay,
        repaymentDay: account.repaymentDay,
        currentBill: toNumber(cycle?.effectiveBill),
        paid: toNumber(cycle?.paid),
        remain: toNumber(cycle?.cumulativeRemain),
        dueDate: cycle?.dueDate ?? null,
      };
    });

  const assetTotal = moneyAccounts
    .filter((account) => account.kind !== AccountKind.loan)
    .reduce((sum, account) => sum + account.balance, 0);
  const loanTotal = moneyAccounts
    .filter((account) => account.kind === AccountKind.loan)
    .reduce((sum, account) => sum + Math.abs(Math.min(0, account.balance)), 0);
  const creditUsedTotal = creditAccounts.reduce((sum, account) => sum + Math.max(0, account.balance), 0);
  const creditLimitTotal = creditAccounts.reduce((sum, account) => sum + account.creditLimit, 0);
  const creditAvailableTotal = Math.max(0, creditLimitTotal - creditUsedTotal);
  const creditCurrentAmountTotal = creditAccounts.reduce((sum, account) => sum + account.currentAmount, 0);
  const creditBillTotal = creditAccounts.reduce((sum, account) => sum + account.currentBill, 0);

  const groupedMoneyAccounts = MONEY_KINDS.map((kind) => ({
    kind,
    label: KIND_LABEL[kind] ?? kind,
    accounts: moneyAccounts.filter((account) => account.kind === kind),
  })).filter((group) => group.accounts.length > 0);

  return (
    <>
    <div className="h-full md:hidden">
      <MobileAccounts
        assetTotal={assetTotal}
        groups={groupedMoneyAccounts.map((group) => ({
          kind: String(group.kind),
          label: group.label,
          accounts: group.accounts.map((account) => ({ ...account, kind: String(account.kind) })),
        }))}
        creditAccounts={creditAccounts.map((account) => ({ ...account, kind: String(account.kind) }))}
        isRedUp={isRedUp}
      />
    </div>
    <div className="hidden h-full md:block">
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">资金账户</div>
            <div className="text-xs text-slate-500">现金、借记卡、信用卡和债务/债权</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <TopEntryLauncher defaultAction="transaction" />
            <Link href="/batch-import" className="secondary-button h-8 px-3 text-xs">
              导入账单
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="flex flex-col gap-5 px-5 py-5 md:flex-row md:items-end md:justify-between md:px-6">
            <div className="space-y-2">
              <div className="text-xs font-medium tracking-[0.18em] text-slate-400 uppercase">Money Accounts</div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">资金账户</h1>
              <p className="text-sm text-slate-500">现金、借记卡、电子钱包、信用卡和债务/债权集中在这里；投资账户继续放在投资页。</p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:min-w-[420px]">
              <SummaryCard label="可用资产" value={formatMoneyYuan(assetTotal)} />
              <SummaryCard label="信用卡已用" value={formatMoneyYuan(creditUsedTotal)} />
              <SummaryCard label="信用卡可用" value={formatMoneyYuan(creditAvailableTotal)} />
              <SummaryCard label="债务/债权" value={formatMoneyYuan(loanTotal)} />
            </div>
          </div>
          <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <TabLink href="/accounts" active={tab === "assets"} label="现金与借记卡" />
              <TabLink href="/accounts?tab=credit" active={tab === "credit"} label="信用卡" />
            </div>
          </div>
        </section>

        {tab === "credit" ? (
          <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr_1.2fr]">
            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CreditCard className="h-4 w-4 text-amber-500" />
                  信用卡汇总
                </div>
                <div className="text-xs text-slate-400">{creditAccounts.length} 张卡</div>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-3">
                <SummaryCard label="总额度" value={formatMoneyYuan(creditLimitTotal)} compact />
                <SummaryCard label="已用额度" value={formatMoneyYuan(creditUsedTotal)} compact />
                <SummaryCard label="可用额度" value={formatMoneyYuan(creditAvailableTotal)} compact />
                <SummaryCard label="本期金额" value={formatMoneyYuan(creditCurrentAmountTotal)} compact />
                <SummaryCard label="本期账单" value={formatMoneyYuan(creditBillTotal)} compact />
              </div>
            </div>

            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Wallet className="h-4 w-4 text-blue-500" />
                  信用卡明细
                </div>
                <div className="text-xs text-slate-400">额度、账单日、还款日</div>
              </div>
              <div className="divide-y divide-slate-100">
                {creditAccounts.length > 0 ? (
                  creditAccounts.map((account) => (
                    <Link key={account.id} href={`/?accountId=${account.id}&view=bill`} title={account.hoverTitle} className="block px-4 py-4 hover:bg-slate-50">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-800" title={account.hoverTitle}>{account.name}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{account.groupName}</span>
                            <span>账单日 {dayLabel(account.billingDay)}</span>
                            <span>还款日 {dayLabel(account.repaymentDay)}</span>
                            <span>到期日 {dateLabel(account.dueDate)}</span>
                          </div>
                        </div>
                        <div className="text-left md:text-right">
                          <div className="text-xs text-slate-400">已用额度</div>
                          <div className={`mt-1 text-sm font-semibold tabular-nums ${liabilityMoneyClass(account.balance, isRedUp)}`}>
                            {formatMoney(account.balance)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                        <MiniMetric label="额度" value={formatMoney(account.creditLimit)} />
                        <MiniMetric label="可用" value={formatMoney(account.availableLimit)} />
                        <MiniMetric label="本期金额" value={formatMoney(account.currentAmount)} valueClass={liabilityMoneyClass(account.currentAmount, isRedUp)} />
                        <MiniMetric label="本期账单" value={formatMoney(account.currentBill)} valueClass={liabilityMoneyClass(account.currentBill, isRedUp)} />
                        <MiniMetric label="待还" value={formatMoney(account.remain)} valueClass={liabilityMoneyClass(account.remain, isRedUp)} />
                      </div>
                    </Link>
                  ))
                ) : (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">暂无信用卡账户</div>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.85fr_1.25fr]">
            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Landmark className="h-4 w-4 text-blue-500" />
                  分类汇总
                </div>
                <div className="text-xs text-slate-400">{moneyAccounts.length} 个账户</div>
              </div>
              <div className="space-y-3 px-4 py-4">
                {groupedMoneyAccounts.map((group) => {
                  const total = group.accounts.reduce((sum, account) => sum + account.balance, 0);
                  const Icon = KIND_ICON[group.kind] ?? Wallet;
                  return (
                    <div key={group.kind} className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-slate-700">{group.label}</div>
                          <div className={`text-base font-semibold tabular-nums ${neutralMoneyClass(total)}`}>{formatMoney(total)}</div>
                        </div>
                        <div className="text-xs text-slate-400">{group.accounts.length} 个</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Wallet className="h-4 w-4 text-cyan-500" />
                  账户明细
                </div>
                <div className="text-xs text-slate-400">点击进入流水明细</div>
              </div>
              <div className="divide-y divide-slate-100">
                {moneyAccounts.length > 0 ? (
                  moneyAccounts.map((account) => {
                    const Icon = KIND_ICON[account.kind] ?? Wallet;
                    const detailView =
                      String(account.kind) === "deposit"
                        ? "deposit"
                        : account.kind === "loan"
                          ? "debt"
                          : "detail";
                    return (
                      <Link key={account.id} href={`/?accountId=${account.id}&view=${detailView}`} title={account.hoverTitle} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-800" title={account.hoverTitle}>{account.name}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                            <span>{KIND_LABEL[account.kind] ?? account.kind}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{account.groupName}</span>
                          </div>
                        </div>
                        <div className={`shrink-0 text-sm font-semibold tabular-nums ${neutralMoneyClass(account.balance)}`}>
                          {formatMoney(account.balance)}
                        </div>
                      </Link>
                    );
                  })
                ) : (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">暂无资金账户</div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
    </div>
    </>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-4 py-2 text-sm transition-colors ${
        active
          ? "bg-white text-blue-700 shadow-sm ring-1 ring-blue-100"
          : "text-slate-500 hover:bg-white/70 hover:text-slate-700"
      }`}
    >
      {label}
    </Link>
  );
}

function SummaryCard({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-slate-100 bg-slate-50/80 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function MiniMetric({ label, value, valueClass = "text-slate-800" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-1 font-medium tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
