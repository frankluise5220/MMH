import { notFound } from "next/navigation";
import { AccountKind } from "@prisma/client";
import { ReimbursementView } from "@/components/ReimbursementView";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  createReimbursement,
  createReimbursementBatch,
  createReimbursementItem,
  deleteReimbursementBatch,
  deleteReimbursement,
  deleteReimbursementItem,
  getReimbursementOverview,
  linkReimbursementTransaction,
  linkReimbursementTransactions,
  reimburseReimbursement,
  reimburseReimbursementBatch,
  approveReimbursement,
  cancelReimbursementApproval,
  deleteReimbursementSettlement,
  unlinkReimbursementTransaction,
  updateReimbursement,
  updateReimbursementBatch,
  updateReimbursementItem,
  updateReimbursementItemInvoice,
  updateReimbursementSettlement,
} from "@/lib/server/sidebar-actions/reimbursement-actions";

export const dynamic = "force-dynamic";

export default async function ReimbursementsPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string; create?: string }>;
}) {
  const params = await searchParams;
  const { householdId } = await getHouseholdScope();
  const [accounts, cashAccounts] = await Promise.all([
    prisma.account.findMany({
      where: {
        householdId,
        isActive: true,
        // 与侧边栏「费用报销」入口的判定保持同一口径（未标记的占位账户一律排除）。
        isPlaceholder: { not: true },
        kind: { in: [AccountKind.loan, AccountKind.settlement] },
        liabilityDirection: "receivable",
        Counterparty: { isReimbursable: true },
      },
      select: {
        id: true,
        name: true,
        counterpartyId: true,
        Counterparty: { select: { name: true, shortName: true } },
      },
      orderBy: [{ name: "asc" }],
    }),
    prisma.account.findMany({
      where: {
        householdId,
        isActive: true,
        isPlaceholder: false,
        kind: { in: [AccountKind.cash, AccountKind.bank_debit, AccountKind.ewallet, AccountKind.bank_credit] },
      },
      select: {
        id: true,
        name: true,
        currency: true,
        kind: true,
        numberMasked: true,
        Institution: { select: { name: true, shortName: true } },
      },
      orderBy: [{ name: "asc" }],
    }),
  ]);

  // Group advance accounts by counterparty for the global view's object picker.
  const objectOptions = (() => {
    const byCounterparty = new Map<string, { id: string; name: string; advanceAccountIds: string[] }>();
    for (const account of accounts) {
      if (!account.counterpartyId) continue;
      const name = account.Counterparty?.shortName?.trim() || account.Counterparty?.name || account.name;
      const existing = byCounterparty.get(account.counterpartyId);
      if (existing) {
        existing.advanceAccountIds.push(account.id);
      } else {
        byCounterparty.set(account.counterpartyId, { id: account.counterpartyId, name, advanceAccountIds: [account.id] });
      }
    }
    return Array.from(byCounterparty.values());
  })();

  const actions = {
    getData: getReimbursementOverview,
    createBatch: createReimbursementBatch,
    updateBatch: updateReimbursementBatch,
    deleteBatch: deleteReimbursementBatch,
    create: createReimbursement,
    reimburse: reimburseReimbursement,
    reimburseBatch: reimburseReimbursementBatch,
    updateSettlement: updateReimbursementSettlement,
    deleteSettlement: deleteReimbursementSettlement,
    approve: approveReimbursement,
    cancelApproval: cancelReimbursementApproval,
    delete: deleteReimbursement,
    updateInvoice: updateReimbursementItemInvoice,
    update: updateReimbursement,
    updateItem: updateReimbursementItem,
    createItem: createReimbursementItem,
    deleteItem: deleteReimbursementItem,
    linkTransaction: linkReimbursementTransaction,
    linkTransactions: linkReimbursementTransactions,
    unlinkTransaction: unlinkReimbursementTransaction,
  };

  const cashAccountOptions = cashAccounts.map((account) => ({
    id: account.id,
    label: account.name,
    institutionName: account.Institution?.shortName || account.Institution?.name || null,
    numberMasked: account.numberMasked,
    kind: account.kind,
    currency: account.currency,
  }));

  // Global view: no accountId → aggregate every reimbursable counterparty.
  if (!params.accountId) {
    return (
      <ReimbursementView
        objectId=""
        objectName=""
        accountName=""
        advanceAccountId=""
        cashAccountOptions={cashAccountOptions}
        objectOptions={objectOptions}
        initialShowCreate={params.create === "1"}
        actions={actions}
      />
    );
  }

  const selected = accounts.find((item) => item.id === params.accountId);
  if (!selected) notFound();
  const objectName = selected.Counterparty?.shortName?.trim() || selected.Counterparty?.name || selected.name;

  return (
    <ReimbursementView
      objectId={selected.counterpartyId ?? ""}
      objectName={objectName}
      accountName={selected.name}
      advanceAccountId={selected.id}
      cashAccountOptions={cashAccountOptions}
      objectOptions={objectOptions}
      initialShowCreate={params.create === "1" && !!selected.counterpartyId}
      actions={actions}
    />
  );
}
