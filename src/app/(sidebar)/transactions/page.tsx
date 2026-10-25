import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { formatDateUtc } from "@/lib/date-utils";
import { MobileTransactions, type MobileTransactionRow } from "@/components/mobile/MobileTransactions";
import { MobileTransactionForm } from "@/components/mobile/MobileTransactionForm";
import { buildAccountDisplayOption, formatAccountTableLabel } from "@/lib/account-display";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { getServerT } from "@/lib/server/i18n";
import { categoryOrderBy } from "@/lib/category-order";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const t = await getServerT();
  const accountLabelFields = await getServerAccountLabelFields();
  const { householdId, hidFilter } = await getHouseholdScope();
  // 币种要进 label/hover：缺 baseCurrency 时非本位币只剩 ISO 代码也没有出处。
  const baseCurrency = await getHouseholdBaseCurrency(householdId);
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
      where: { ...hidFilter, type: { in: ["expense", "income"] } },
      orderBy: categoryOrderBy(),
      select: { id: true, name: true, type: true, sortOrder: true, isSystem: true },
    }),
  ]);

  const accountDisplayById = new Map(
    accounts.map((account) => {
      const option = buildAccountDisplayOption({ ...account, kind: String(account.kind) }, undefined, { fields: accountLabelFields, baseCurrency });
      return [account.id, {
        label: formatAccountTableLabel(option, "", { fields: accountLabelFields, baseCurrency }),
        // 行内看不到的机构/卡号/非本位币，留给 hover。
        title: option.tableHoverTitle,
      }] as const;
    }),
  );
  const rows: MobileTransactionRow[] = entries.map((entry) => {
    const account = accountDisplayById.get(entry.accountId);
    const toAccount = entry.toAccountId ? accountDisplayById.get(entry.toAccountId) : undefined;
    return {
      id: entry.id,
      date: formatDateUtc(entry.date),
      amount: Number(entry.amount),
      type: entry.type,
      categoryName: entry.categoryName ?? "",
      accountName: account?.label ?? entry.accountName ?? "",
      accountHoverTitle: account?.title ?? "",
      toAccountName: toAccount?.label ?? entry.toAccountName ?? "",
      toAccountHoverTitle: toAccount?.title ?? "",
      note: entry.note ?? "",
    };
  });

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
        <div className="text-sm text-slate-500">{t("transactions.desktopHint")}</div>
      </div>
    </>
  );
}
