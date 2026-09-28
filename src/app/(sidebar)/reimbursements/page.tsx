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
        isPlaceholder: false,
        kind: { in: [AccountKind.loan, AccountKind.settlement] },
        debtDirection: "receivable",
        Counterparty: { isReimbursable: true },
      },
      select: { id: true, name: true, counterpartyId: true, Counterparty: { select: { name: true, shortName: true } } },
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
  const selected = accounts.find((item) => item.id === params.accountId) ?? (params.accountId ? null : accounts[0]);
  if (!selected) notFound();
  const objectName = selected.Counterparty?.shortName?.trim() || selected.Counterparty?.name || selected.name;

  return (
    <ReimbursementView
      objectId={selected.counterpartyId ?? ""}
      objectName={objectName}
      accountName={selected.name}
      advanceAccountId={selected.id}
      cashAccountOptions={cashAccounts.map((account) => ({
        id: account.id,
        label: account.name,
        institutionName: account.Institution?.shortName || account.Institution?.name || null,
        numberMasked: account.numberMasked,
        kind: account.kind,
        currency: account.currency,
      }))}
      initialShowCreate={params.create === "1" && !!selected.counterpartyId}
      actions={{
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
      }}
    />
  );
}
