import { notFound } from "next/navigation";
import { AccountKind } from "@prisma/client";

import { MobileTransactionForm } from "@/components/mobile/MobileTransactionForm";
import { MobileTransactions, type MobileTransactionRow } from "@/components/mobile/MobileTransactions";
import { prisma } from "@/lib/db/prisma";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { toNumber, formatDateUtc } from "@/lib/date-utils";
import { buildAccountDisplayOption, formatAccountTableLabel } from "@/lib/account-display";
import { getMaintainedAccountBalances } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { getServerT } from "@/lib/server/i18n";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import { categoryOrderBy } from "@/lib/category-order";

export const dynamic = "force-dynamic";

const KIND_LABEL_KEYS: Record<string, string> = {
  bank_debit: "account.kind.bank_debit",
  bank_credit: "account.kind.bank_credit",
  ewallet: "account.kind.ewallet",
  cash: "account.kind.cash",
  deposit: "account.kind.deposit",
  loan: "account.kind.loan",
  other: "account.kind.other",
};

export default async function MobileAccountDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const t = await getServerT();
  const accountLabelFields = await getServerAccountLabelFields();
  const { householdId, hidFilter } = await getHouseholdScope();
  // 币种要进 label/hover：缺 baseCurrency 时非本位币只剩 ISO 代码也没有出处。
  const baseCurrency = await getHouseholdBaseCurrency(householdId);
  const [account, accounts, categories] = await Promise.all([
    prisma.account.findFirst({
      where: { id: accountId, isPlaceholder: { not: true }, ...hidFilter },
      include: { AccountGroup: { select: { name: true } } },
    }),
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, ...hidFilter },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        currency: true,
        numberMasked: true,
        groupId: true,
        investProductType: true,
        Institution: { select: { name: true, shortName: true, type: true } },
        AccountGroup: { select: { id: true, name: true } },
        Counterparty: { select: { name: true, shortName: true } },
      },
    }),
    prisma.category.findMany({
      where: { type: { in: ["expense", "income"] }, ...hidFilter },
      orderBy: categoryOrderBy(),
      select: { id: true, name: true, type: true, sortOrder: true, isSystem: true },
    }),
  ]);
  if (!account) notFound();

  const [entries, balances, currentCreditCycle] = await Promise.all([
    prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...hidFilter,
        ...txRecordAccountScopeWhere(accountId),
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
    getMaintainedAccountBalances([account], hidFilter),
    account.kind === AccountKind.bank_credit
      ? prisma.creditCardCycle.findFirst({
          where: { accountId: account.id, isCurrentCycle: true },
          select: { effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
        })
      : Promise.resolve(null),
  ]);

  const accountDisplayById = new Map(
    accounts.map((item) => {
      const option = buildAccountDisplayOption({ ...item, kind: String(item.kind) }, undefined, { fields: accountLabelFields, baseCurrency });
      return [item.id, {
        label: formatAccountTableLabel(option, "", { fields: accountLabelFields, baseCurrency }),
        // 行内看不到的机构/卡号/非本位币，留给 hover。
        title: option.tableHoverTitle,
      }] as const;
    }),
  );
  const rows: MobileTransactionRow[] = entries.map((entry) => {
    const amount = toNumber(entry.amount);
    const account = accountDisplayById.get(entry.accountId);
    const toAccount = entry.toAccountId ? accountDisplayById.get(entry.toAccountId) : undefined;
    return {
      id: entry.id,
      date: formatDateUtc(entry.date),
      amount,
      flowAmount: entry.accountId === accountId ? amount : -amount,
      type: entry.type,
      categoryName: entry.categoryName ?? "",
      accountName: account?.label ?? entry.accountName ?? "",
      accountHoverTitle: account?.title ?? "",
      toAccountName: toAccount?.label ?? entry.toAccountName ?? "",
      toAccountHoverTitle: toAccount?.title ?? "",
      note: entry.note ?? "",
    };
  });
  const balance = account.kind === AccountKind.bank_credit
    ? -creditCardDisplayBalanceFromCurrentCycle(currentCreditCycle, toNumber(account.balance))
    : balances.get(account.id) ?? toNumber(account.balance);
  const kind = String(account.kind);

  return (
    <>
      <div className="h-full md:hidden">
        <MobileTransactions
          entries={rows}
          accountSummary={{
            title: account.name,
            subtitle: `${t(KIND_LABEL_KEYS[kind] ?? "account.kind.other")}${account.AccountGroup?.name ? ` · ${account.AccountGroup.name}` : ""}`,
            balance,
            balanceLabel: kind === "bank_credit" ? t("mobile.detail.balanceDue") : t("mobile.detail.balance"),
            backHref: "/accounts",
          }}
        />
        <MobileTransactionForm
          accounts={accounts.map((item) => ({ ...item, kind: String(item.kind) }))}
          categories={categories}
          defaultAccountId={account.id}
        />
      </div>
      <div className="hidden h-full items-center justify-center md:flex">
        <div className="text-sm text-slate-500">{t("mobile.detail.desktopHint")}</div>
      </div>
    </>
  );
}
