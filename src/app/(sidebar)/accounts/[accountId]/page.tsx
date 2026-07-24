import { notFound } from "next/navigation";
import { AccountKind } from "@prisma/client";

import { MobileTransactionForm } from "@/components/mobile/MobileTransactionForm";
import { MobileTransactions, type MobileTransactionRow } from "@/components/mobile/MobileTransactions";
import { prisma } from "@/lib/db/prisma";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { formatDateLocal, toNumber } from "@/lib/date-utils";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  bank_debit: "借记卡",
  bank_credit: "信用卡",
  ewallet: "电子钱包",
  cash: "现金",
  deposit: "存款",
  loan: "债务/债权",
  other: "其他账户",
};

export default async function MobileAccountDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const { hidFilter } = await getHouseholdScope();
  const [account, accounts, categories] = await Promise.all([
    prisma.account.findFirst({
      where: { id: accountId, isPlaceholder: { not: true }, ...hidFilter },
      include: { AccountGroup: { select: { name: true } } },
    }),
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, ...hidFilter },
      orderBy: { name: "asc" },
      select: { id: true, name: true, kind: true },
    }),
    prisma.category.findMany({
      where: { type: { in: ["expense", "income"] }, ...hidFilter },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);
  if (!account) notFound();

  const [entries, balances, currentCreditCycle] = await Promise.all([
    prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...hidFilter,
        OR: [{ accountId }, { toAccountId: accountId }],
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        date: true,
        amount: true,
        type: true,
        categoryName: true,
        accountId: true,
        accountName: true,
        toAccountId: true,
        toAccountName: true,
        note: true,
      },
    }),
    computeAccountDisplayBalances([account], hidFilter),
    account.kind === AccountKind.bank_credit
      ? prisma.creditCardCycle.findFirst({
          where: { accountId: account.id, isCurrentCycle: true },
          select: { effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
        })
      : Promise.resolve(null),
  ]);

  const rows: MobileTransactionRow[] = entries.map((entry) => {
    const amount = toNumber(entry.amount);
    return {
      id: entry.id,
      date: formatDateLocal(entry.date),
      amount,
      flowAmount: entry.accountId === accountId ? amount : -amount,
      type: entry.type,
      categoryName: entry.categoryName ?? "",
      accountName: entry.accountName ?? "",
      toAccountName: entry.toAccountName ?? "",
      note: entry.note ?? "",
    };
  });
  const balance = account.kind === AccountKind.bank_credit
    ? creditCardDisplayBalanceFromCurrentCycle(currentCreditCycle, toNumber(account.balance))
    : balances.get(account.id) ?? toNumber(account.balance);
  const kind = String(account.kind);

  return (
    <>
      <div className="h-full md:hidden">
        <MobileTransactions
          entries={rows}
          accountSummary={{
            title: account.name,
            subtitle: `${KIND_LABEL[kind] ?? kind}${account.AccountGroup?.name ? ` · ${account.AccountGroup.name}` : ""}`,
            balance,
            balanceLabel: kind === "bank_credit" ? "当前应还" : "当前余额",
            backHref: "/accounts",
          }}
        />
        <MobileTransactionForm
          accounts={accounts.map((item) => ({ id: item.id, name: item.name, kind: String(item.kind) }))}
          categories={categories}
          defaultAccountId={account.id}
        />
      </div>
      <div className="hidden h-full items-center justify-center md:flex">
        <div className="text-sm text-slate-500">请使用桌面侧栏进入账户明细工作区。</div>
      </div>
    </>
  );
}
