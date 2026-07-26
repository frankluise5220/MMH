import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { formatDateLocal } from "@/lib/date-utils";
import { MobileTransactions, type MobileTransactionRow } from "@/components/mobile/MobileTransactions";
import { MobileTransactionForm } from "@/components/mobile/MobileTransactionForm";
import { buildAccountDisplayOption } from "@/lib/account-display";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const { hidFilter } = await getHouseholdScope();
  const [entries, accounts, categories] = await Promise.all([
    prisma.txRecord.findMany({
      where: { ...hidFilter, deletedAt: null },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        date: true,
        amount: true,
        type: true,
        accountId: true,
        categoryName: true,
        accountName: true,
        toAccountId: true,
        toAccountName: true,
        note: true,
      },
    }),
    prisma.account.findMany({
      where: { ...hidFilter, isActive: true, isPlaceholder: { not: true } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        numberMasked: true,
        groupId: true,
        investProductType: true,
        Institution: { select: { name: true, shortName: true } },
        AccountGroup: { select: { id: true, name: true } },
      },
    }),
    prisma.category.findMany({
      where: { ...hidFilter, type: { in: ["expense", "income"] } },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);

  const accountDisplayById = new Map(
    accounts.map((account) => {
      const option = buildAccountDisplayOption({ ...account, kind: String(account.kind) });
      return [account.id, option.fullLabel || option.selectorLabel || option.label] as const;
    }),
  );
  const rows: MobileTransactionRow[] = entries.map((entry) => ({
    id: entry.id,
    date: formatDateLocal(entry.date),
    amount: Number(entry.amount),
    type: entry.type,
    categoryName: entry.categoryName ?? "",
    accountName: accountDisplayById.get(entry.accountId) ?? entry.accountName ?? "",
    toAccountName: entry.toAccountId ? accountDisplayById.get(entry.toAccountId) ?? entry.toAccountName ?? "" : entry.toAccountName ?? "",
    note: entry.note ?? "",
  }));

  return (
    <>
      <div className="h-full md:hidden">
        <MobileTransactions entries={rows} />
        <MobileTransactionForm
          accounts={accounts.map((account) => ({ ...account, kind: String(account.kind) }))}
          categories={categories}
        />
      </div>
      <div className="hidden h-full items-center justify-center md:flex">
        <div className="text-sm text-slate-500">请使用桌面侧栏进入账户明细工作区。</div>
      </div>
    </>
  );
}
