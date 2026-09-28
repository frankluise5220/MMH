"use client";

import { useEffect, useMemo, useState } from "react";
import { Banknote, Check, Link2, Pencil, Plus, Printer, ReceiptText, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatMoney, formatMoneyYuan } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { DateStepper } from "./DateStepper";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { reimbursementErrorMessage } from "@/lib/reimbursement-error";
import { ReimbursementFormModal, type ReimbursementFormEntry } from "@/components/ReimbursementFormModal";
import { ReimbursementPreview } from "@/components/ReimbursementPreview";
import { ReimbursementEditor } from "@/components/ReimbursementEditor";
import { CalcInput } from "@/components/CalcInput";
import type {
  ReimbursementActionResult,
  ReimbursementBatchData,
  ReimbursementData,
  ReimbursementOverviewData,
} from "@/lib/server/sidebar-actions/reimbursement-actions";

export type ReimbursementCashAccountOption = {
  id: string;
  label: string;
  institutionName?: string | null;
  numberMasked?: string | null;
  kind?: string | null;
  currency?: string | null;
};

const reimbursementActionButtonClass = "flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export type ReimbursementActions = {
  getData: (objectId: string, objectType: "counterparty" | "institution", advanceAccountId: string) => Promise<ReimbursementOverviewData>;
  createBatch: (formData: FormData) => Promise<ReimbursementActionResult & { batchId?: string }>;
  updateBatch: (formData: FormData) => Promise<ReimbursementActionResult>;
  deleteBatch: (formData: FormData) => Promise<ReimbursementActionResult>;
  create: (formData: FormData) => Promise<ReimbursementActionResult>;
  reimburse: (formData: FormData) => Promise<ReimbursementActionResult>;
  reimburseBatch: (formData: FormData) => Promise<ReimbursementActionResult>;
  updateSettlement: (formData: FormData) => Promise<ReimbursementActionResult>;
  deleteSettlement: (formData: FormData) => Promise<ReimbursementActionResult>;
  approve: (formData: FormData) => Promise<ReimbursementActionResult>;
  cancelApproval: (formData: FormData) => Promise<ReimbursementActionResult>;
  delete: (formData: FormData) => Promise<ReimbursementActionResult>;
  updateInvoice: (formData: FormData) => Promise<ReimbursementActionResult>;
  update: (formData: FormData) => Promise<ReimbursementActionResult>;
  updateItem: (formData: FormData) => Promise<ReimbursementActionResult>;
  createItem: (formData: FormData) => Promise<ReimbursementActionResult>;
  deleteItem: (formData: FormData) => Promise<ReimbursementActionResult>;
  linkTransaction: (formData: FormData) => Promise<ReimbursementActionResult>;
  linkTransactions: (formData: FormData) => Promise<ReimbursementActionResult>;
  unlinkTransaction: (formData: FormData) => Promise<ReimbursementActionResult>;
};

export function ReimbursementWorkspace({
  objectId,
  objectType,
  objectName,
  accountName,
  advanceAccountId,
  cashAccountOptions,
  actions,
  initialShowCreate = false,
  initialCreateEntries,
}: {
  objectId: string;
  objectType: "counterparty" | "institution";
  objectName: string;
  accountName: string;
  advanceAccountId: string;
  cashAccountOptions: ReimbursementCashAccountOption[];
  actions: ReimbursementActions;
  /** Detail-selection entry point: pop the create-form modal on mount, seeded with the picked rows. */
  initialShowCreate?: boolean;
  initialCreateEntries?: ReimbursementFormEntry[];
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ReimbursementOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(initialShowCreate);
  const [showCreateBatch, setShowCreateBatch] = useState(false);
  const [batchTitle, setBatchTitle] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [batchStartDate, setBatchStartDate] = useState("");
  const [batchEndDate, setBatchEndDate] = useState("");
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<ReimbursementData | null>(null);
  const [approvedAmount, setApprovedAmount] = useState("");
  const [approvalDate, setApprovalDate] = useState(todayDateLocalYmd());
  const [approvalNote, setApprovalNote] = useState("");
  const [paymentBatch, setPaymentBatch] = useState<ReimbursementBatchData | null>(null);
  const [paymentApprovedAmounts, setPaymentApprovedAmounts] = useState<Record<string, string>>({});
  const [paymentFees, setPaymentFees] = useState<Record<string, string>>({});
  const [reimburseDate, setReimburseDate] = useState(todayDateLocalYmd());
  const [reimburseCashAccountId, setReimburseCashAccountId] = useState(cashAccountOptions[0]?.id ?? "");
  const [reimburseNote, setReimburseNote] = useState("");
  const [balanceDiffMode, setBalanceDiffMode] = useState<"loss" | "remain">("loss");
  const [printTarget, setPrintTarget] = useState<ReimbursementData | null>(null);
  const [linkingReimbursementId, setLinkingReimbursementId] = useState<string | null>(null);
  const [linkTransactionIds, setLinkTransactionIds] = useState<string[]>([]);
  // ADT state: which reimbursement is selected to show items
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  // Editor state: which reimbursement is being edited
  const [editingReimbId, setEditingReimbId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await actions.getData(objectId, objectType, advanceAccountId);
      setData(next);
    } catch (error) {
      console.error("Failed to load reimbursement overview", {
        objectId,
        objectType,
        advanceAccountId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, objectType, advanceAccountId]);

  // Reimbursement being edited
  const editingReimb = useMemo(
    () => (data?.reimbursements ?? []).find((r) => r.id === editingReimbId) ?? null,
    [data, editingReimbId],
  );
  const linkingReimbursement = useMemo(
    () => (data?.reimbursements ?? []).find((reimbursement) => reimbursement.id === linkingReimbursementId) ?? null,
    [data, linkingReimbursementId],
  );
  const selectedBatch = useMemo(
    () => (data?.batches ?? []).find((batch) => batch.id === selectedBatchId) ?? data?.batches[0] ?? null,
    [data, selectedBatchId],
  );
  const batchReimbursements = useMemo(
    () => (data?.reimbursements ?? []).filter((reimbursement) => reimbursement.batchId === selectedBatch?.id),
    [data, selectedBatch],
  );
  const pendingList = batchReimbursements.filter((reimbursement) => reimbursement.approvalStatus === "pending");
  const reimbursedList = batchReimbursements.filter((reimbursement) => reimbursement.status === "reimbursed");
  const pendingTotal = pendingList.reduce((sum, reimbursement) => sum + reimbursement.totalAmount, 0);
  const reimbursedTotal = reimbursedList.reduce((sum, reimbursement) => sum + reimbursement.totalAmount, 0);
  const batchPayableCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const reimbursement of data?.reimbursements ?? []) {
      if (reimbursement.status !== "pending" || !reimbursement.batchId) continue;
      counts.set(reimbursement.batchId, (counts.get(reimbursement.batchId) ?? 0) + 1);
    }
    return counts;
  }, [data]);
  const paymentBatchPayableCount = paymentBatch
    ? batchPayableCounts.get(paymentBatch.id) ?? 0
    : 0;
  const paymentDocuments = useMemo(
    () => paymentBatch
      ? (data?.reimbursements ?? []).filter((reimbursement) => reimbursement.batchId === paymentBatch.id && reimbursement.status === "pending")
      : [],
    [data, paymentBatch],
  );
  const paymentClaimedTotal = paymentDocuments.reduce((sum, reimbursement) => sum + reimbursement.totalAmount, 0);
  const paymentApprovedTotal = paymentDocuments.reduce((sum, reimbursement) => {
    const draft = paymentApprovedAmounts[reimbursement.id];
    const amount = draft == null || draft.trim() === "" ? reimbursement.approvedAmount ?? reimbursement.totalAmount : Number(draft);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const paymentLinkedTransactionTotal = paymentDocuments.reduce((sum, reimbursement) => sum + reimbursement.linkedTransactionTotal, 0);
  const paymentFeeTotal = paymentDocuments.reduce((sum, reimbursement) => {
    const draft = paymentFees[reimbursement.id];
    const amount = draft == null || draft.trim() === "" ? 0 : Number(draft);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const paymentActualTotal = paymentApprovedTotal + paymentFeeTotal;
  const paymentTransferTotal = paymentDocuments.reduce((sum, reimbursement) => {
    const draft = paymentApprovedAmounts[reimbursement.id];
    const approved = draft == null || draft.trim() === "" ? reimbursement.approvedAmount ?? reimbursement.totalAmount : Number(draft);
    const feeDraft = paymentFees[reimbursement.id];
    const fee = feeDraft == null || feeDraft.trim() === "" ? 0 : Number(feeDraft);
    const amount = approved + (Number.isFinite(fee) ? fee : 0);
    if (!Number.isFinite(amount)) return sum;
    return sum + (balanceDiffMode === "loss"
      ? reimbursement.linkedTransactionTotal
      : Math.min(amount, reimbursement.linkedTransactionTotal));
  }, 0);

  // The detail-selection entry seeds the form with picked rows; once the user closes
  // that form (or saves it), fall back to the full candidate list.
  const [seedsConsumed, setSeedsConsumed] = useState(!initialShowCreate);
  const createSeedEntries = seedsConsumed ? [] : (initialCreateEntries ?? []);
  const batchColumns = useMemo<AdvancedDataTableColumn<ReimbursementBatchData>[]>(() => [
    {
      key: "title",
      label: t("reimburse.table.batch"),
      width: 220,
      minWidth: 140,
      filterText: (batch) => batch.title,
      sortValue: (batch) => batch.title,
      render: (batch) => <span className="font-medium text-slate-800">{batch.title}</span>,
    },
    {
      key: "note",
      label: t("reimburse.batch.note"),
      width: 220,
      minWidth: 120,
      hideable: true,
      filterText: (batch) => batch.note,
      sortValue: (batch) => batch.note ?? "",
      truncate: true,
      cellTitle: (batch) => batch.note,
      render: (batch) => <span className="text-slate-500">{batch.note || "-"}</span>,
    },
    {
      key: "dateRange",
      label: t("reimburse.batch.dateRange"),
      width: 190,
      minWidth: 140,
      hideable: true,
      filterKind: "dateRange",
      filterText: (batch) => batch.startDate ?? batch.endDate ?? "",
      sortValue: (batch) => batch.startDate ?? "",
      render: (batch) => <span className="tabular-nums text-slate-600">{batch.startDate || batch.endDate ? `${batch.startDate ?? "…"} – ${batch.endDate ?? "…"}` : "-"}</span>,
    },
    {
      key: "documentCount",
      label: t("reimburse.batch.documentCount"),
      width: 100,
      minWidth: 76,
      align: "center",
      hideable: true,
      filterKind: "numberRange",
      filterText: (batch) => String(batch.documentCount),
      filterNumber: (batch) => batch.documentCount,
      sortValue: (batch) => batch.documentCount,
      render: (batch) => <span className="tabular-nums text-slate-600">{batch.documentCount}</span>,
    },
    {
      key: "totalAmount",
      label: t("reimburse.batch.declaredAmount"),
      width: 130,
      minWidth: 100,
      align: "right",
      filterKind: "numberRange",
      filterText: (batch) => String(batch.totalAmount),
      filterNumber: (batch) => batch.totalAmount,
      sortValue: (batch) => batch.totalAmount,
      render: (batch) => <span className="font-semibold tabular-nums">{formatMoneyYuan(batch.totalAmount)}</span>,
    },
    {
      key: "batchActualAmount",
      label: t("reimburse.batch.actualReceived"),
      width: 130,
      minWidth: 100,
      align: "right",
      hideable: true,
      filterKind: "numberRange",
      filterText: (batch) => String(batch.actualAmount),
      filterNumber: (batch) => batch.actualAmount,
      sortValue: (batch) => batch.actualAmount,
      render: (batch) => <span className="tabular-nums text-slate-600">{formatMoneyYuan(batch.actualAmount)}</span>,
    },
    {
      key: "status",
      label: t("reimburse.batch.status"),
      width: 110,
      minWidth: 90,
      align: "center",
      hideable: true,
      filterText: (batch) => t(`reimburse.document.status.${batch.status}`),
      sortValue: (batch) => batch.status,
      render: (batch) => <span className="text-slate-600">{t(`reimburse.document.status.${batch.status}`)}</span>,
    },
  ], [t]);

  const documentColumns = useMemo<AdvancedDataTableColumn<ReimbursementData>[]>(() => [
    {
      key: "documentNumber",
      label: t("reimburse.document.number"),
      width: 150,
      minWidth: 110,
      filterText: (reimbursement) => reimbursement.documentNumber || reimbursement.title,
      sortValue: (reimbursement) => reimbursement.documentNumber || reimbursement.title,
      render: (reimbursement) => <span className="font-medium text-slate-700">{reimbursement.documentNumber || reimbursement.title || "-"}</span>,
    },
    {
      key: "createdAt",
      label: t("reimburse.document.submittedDate"),
      width: 115,
      minWidth: 105,
      filterText: (reimbursement) => reimbursement.createdAt.slice(0, 10),
      sortValue: (reimbursement) => reimbursement.createdAt,
      render: (reimbursement) => <span className="tabular-nums text-slate-600">{reimbursement.createdAt.slice(0, 10)}</span>,
    },
    {
      key: "kind",
      label: t("reimburse.document.type"),
      width: 120,
      minWidth: 100,
      filterText: (reimbursement) => t(reimbursement.kind === "travel" ? "reimburse.form.kindTravel" : reimbursement.kind === "general" ? "reimburse.form.kindGeneral" : "reimburse.form.kindAdvance"),
      sortValue: (reimbursement) => reimbursement.kind,
      render: (reimbursement) => <span className="text-slate-700">{t(reimbursement.kind === "travel" ? "reimburse.form.kindTravel" : reimbursement.kind === "general" ? "reimburse.form.kindGeneral" : "reimburse.form.kindAdvance")}</span>,
    },
    {
      key: "totalAmount",
      label: t("reimburse.document.claimedAmount"),
      width: 130,
      minWidth: 100,
      align: "right",
      filterKind: "numberRange",
      filterText: (reimbursement) => String(reimbursement.totalAmount),
      filterNumber: (reimbursement) => reimbursement.totalAmount,
      sortValue: (reimbursement) => reimbursement.totalAmount,
      render: (reimbursement) => <span className="font-semibold tabular-nums">{formatMoneyYuan(reimbursement.totalAmount)}</span>,
    },
    {
      key: "approvedAmount",
      label: t("reimburse.document.approvedAmount"),
      width: 130,
      minWidth: 100,
      align: "right",
      hideable: true,
      filterKind: "numberRange",
      filterText: (reimbursement) => reimbursement.approvedAmount == null ? "" : String(reimbursement.approvedAmount),
      filterNumber: (reimbursement) => reimbursement.approvedAmount,
      sortValue: (reimbursement) => reimbursement.approvedAmount ?? -1,
      render: (reimbursement) => <span className="tabular-nums text-slate-600">{reimbursement.approvedAmount == null ? "-" : formatMoneyYuan(reimbursement.approvedAmount)}</span>,
    },
    {
      key: "documentActualAmount",
      label: t("reimburse.document.receivedAmount"),
      width: 130,
      minWidth: 100,
      align: "right",
      hideable: true,
      filterKind: "numberRange",
      filterText: (reimbursement) => reimbursement.actualAmount == null ? "" : String(reimbursement.actualAmount),
      filterNumber: (reimbursement) => reimbursement.actualAmount,
      sortValue: (reimbursement) => reimbursement.actualAmount ?? -1,
      render: (reimbursement) => <span className="tabular-nums text-slate-600">{reimbursement.actualAmount == null ? "-" : formatMoneyYuan(reimbursement.actualAmount)}</span>,
    },
    {
      key: "status",
      label: t("reimburse.batch.status"),
      width: 110,
      minWidth: 90,
      align: "center",
      filterText: (reimbursement) => t(`reimburse.document.status.${reimbursement.approvalStatus}`),
      sortValue: (reimbursement) => reimbursement.approvalStatus,
      render: (reimbursement) => <span className="text-slate-500">{t(`reimburse.document.status.${reimbursement.approvalStatus}`)}</span>,
    },
  ], [t]);

  const openCreate = () => {
    setShowCreate(true);
  };

  const openCreateBatch = () => {
    setBatchTitle("");
    setBatchNote("");
    setBatchStartDate("");
    setBatchEndDate("");
    setEditingBatchId(null);
    setShowCreateBatch(true);
  };

  const submitCreateBatch = async () => {
    const title = batchTitle.trim();
    if (!title || busy) return;
    const formData = new FormData();
    formData.set("advanceAccountId", advanceAccountId);
    formData.set("title", title);
    formData.set("note", batchNote);
    formData.set("startDate", batchStartDate);
    formData.set("endDate", batchEndDate);
    setBusy(true);
    try {
      const result = await actions.createBatch(formData);
      if (!result.ok || !result.batchId) {
        window.alert(reimbursementErrorMessage(result.ok ? "REIMBURSEMENT_BATCH_CREATE_FAILED" : result.error, t));
        return;
      }
      setBatchTitle("");
      setBatchNote("");
      setBatchStartDate("");
      setBatchEndDate("");
      setShowCreateBatch(false);
      await load();
      setSelectedBatchId(result.batchId);
    } finally {
      setBusy(false);
    }
  };

  const openEditBatch = (batch: NonNullable<typeof selectedBatch>) => {
    setBatchTitle(batch.title);
    setBatchNote(batch.note ?? "");
    setBatchStartDate(batch.startDate ?? "");
    setBatchEndDate(batch.endDate ?? "");
    setEditingBatchId(batch.id);
  };

  const submitEditBatch = async () => {
    if (!editingBatchId || busy || !batchTitle.trim()) return;
    const formData = new FormData();
    formData.set("batchId", editingBatchId);
    formData.set("advanceAccountId", advanceAccountId);
    formData.set("title", batchTitle.trim());
    formData.set("note", batchNote);
    formData.set("startDate", batchStartDate);
    formData.set("endDate", batchEndDate);
    setBusy(true);
    try {
      const result = await actions.updateBatch(formData);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error, t));
        return;
      }
      setEditingBatchId(null);
      setBatchTitle("");
      setBatchNote("");
      setBatchStartDate("");
      setBatchEndDate("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitDeleteBatch = async (batch: ReimbursementBatchData) => {
    if (busy) return;
    if (batch.documentCount > 0) {
      window.alert(t("reimburse.batch.deleteHasDocuments", { count: String(batch.documentCount) }));
      return;
    }
    if (!window.confirm(t("reimburse.batch.deleteConfirm", { title: batch.title }))) return;
    const formData = new FormData();
    formData.set("batchId", batch.id);
    formData.set("advanceAccountId", advanceAccountId);
    setBusy(true);
    try {
      const result = await actions.deleteBatch(formData);
      if (!result.ok) {
        if (result.error.startsWith("REIMBURSEMENT_BATCH_HAS_DOCUMENTS:")) {
          const count = result.error.split(":")[1] ?? "0";
          window.alert(t("reimburse.batch.deleteHasDocuments", { count }));
        } else {
          window.alert(reimbursementErrorMessage(result.error, t));
        }
        return;
      }
      if (selectedBatchId === batch.id) setSelectedBatchId(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openBatchPayment = (batch: ReimbursementBatchData) => {
    setPaymentBatch(batch);
    setPaymentApprovedAmounts(
      Object.fromEntries(
        (data?.reimbursements ?? [])
          .filter((reimbursement) => reimbursement.batchId === batch.id && reimbursement.status === "pending")
          .map((reimbursement) => [reimbursement.id, String(reimbursement.approvedAmount ?? reimbursement.totalAmount)]),
      ),
    );
    setPaymentFees(
      Object.fromEntries(
        (data?.reimbursements ?? [])
          .filter((reimbursement) => reimbursement.batchId === batch.id && reimbursement.status === "pending")
          .map((reimbursement) => [reimbursement.id, "0"]),
      ),
    );
    setReimburseDate(todayDateLocalYmd());
    setReimburseCashAccountId(cashAccountOptions[0]?.id ?? "");
    setReimburseNote("");
    setBalanceDiffMode("loss");
  };

  const submitApproval = async () => {
    if (!approvalTarget || busy) return;
    const formData = new FormData();
    formData.set("reimbursementId", approvalTarget.id);
    formData.set("approvedAmount", approvedAmount);
    formData.set("approvalDate", approvalDate);
    formData.set("approvalNote", approvalNote);
    setBusy(true);
    try {
      const res = await actions.approve(formData);
      if (!res.ok) {
        window.alert(reimbursementErrorMessage(res.error, t));
        return;
      }
      setApprovalTarget(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitCancelApproval = async () => {
    if (!approvalTarget || busy) return;
    if (!window.confirm(t("reimburse.document.cancelApprovalConfirm"))) return;
    const formData = new FormData();
    formData.set("reimbursementId", approvalTarget.id);
    setBusy(true);
    try {
      const result = await actions.cancelApproval(formData);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error, t));
        return;
      }
      setApprovalTarget(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitBatchPayment = async () => {
    if (!paymentBatch || busy) return;
    const formData = new FormData();
    formData.set("batchId", paymentBatch.id);
    formData.set("cashAccountId", reimburseCashAccountId);
    formData.set("date", reimburseDate);
    formData.set("note", reimburseNote);
    formData.set("balanceDiffMode", balanceDiffMode);
    formData.set("approvedAmounts", JSON.stringify(paymentApprovedAmounts));
    formData.set("feeAmounts", JSON.stringify(paymentFees));
    setBusy(true);
    try {
      const result = await actions.reimburseBatch(formData);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error, t));
        return;
      }
      setPaymentBatch(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async (reimbursement: ReimbursementData) => {
    if (busy || !window.confirm(t("reimburse.deleteConfirm"))) return;
    const formData = new FormData();
    formData.set("reimbursementId", reimbursement.id);
    setBusy(true);
    try {
      const res = await actions.delete(formData);
      if (!res.ok) {
        window.alert(reimbursementErrorMessage(res.error, t));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const linkTransactions = async (reimbursement: ReimbursementData, txRecordIds: string[]) => {
    if (busy) return;
    const formData = new FormData();
    formData.set("reimbursementId", reimbursement.id);
    formData.set("txRecordIds", JSON.stringify(txRecordIds));
    setBusy(true);
    try {
      const result = await actions.linkTransactions(formData);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error, t));
        return;
      }
      await load();
      setLinkingReimbursementId(null);
      setLinkTransactionIds([]);
    } finally {
      setBusy(false);
    }
  };

  const unlinkTransaction = async (reimbursement: ReimbursementData, itemId: string) => {
    if (busy) return;
    const formData = new FormData();
    formData.set("reimbursementId", reimbursement.id);
    formData.set("txRecordId", itemId);
    setBusy(true);
    try {
      const result = await actions.unlinkTransaction(formData);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error, t));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background p-4 md:p-5">
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-slate-800">{t("reimburse.workspaceTitle")}</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
              <ReceiptText className="h-3.5 w-3.5" />
              {accountName}
            </div>
          </div>
          <button type="button" onClick={() => window.history.back()} className="secondary-button h-8 px-2" disabled={busy}>
            {t("table.close")}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              {t("debtShell.saving")}
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="text-sm text-rose-600">{t("reimburse.loadFailed")}</div>
              <div className="max-w-full break-all text-xs text-slate-500">{loadError}</div>
              <button type="button" onClick={() => void load()} className="secondary-button h-8 px-3" disabled={loading}>
                {t("reimburse.retryLoad")}
              </button>
            </div>
              ) : (
            <div className="grid h-full min-h-0 w-full grid-rows-[minmax(14rem,1fr)_minmax(12rem,0.8fr)] gap-3 overflow-hidden">
              {/* Upper pane: batches */}
              <section className="flex h-full min-h-0 flex-col overflow-hidden">
                {/* Summary stats */}
                <div className="mb-2 grid shrink-0 grid-cols-2 gap-2">
                  <div className="rounded border border-amber-200 bg-amber-50/60 px-2 py-1.5">
                    <div className="text-[11px] text-amber-600">{t("reimburse.pendingSection")}</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-amber-800">
                      {t("reimburse.summaryPending", { count: pendingList.length, amount: formatMoney(pendingTotal) })}
                    </div>
                  </div>
                  <div className="rounded border border-emerald-200 bg-emerald-50/60 px-2 py-1.5">
                    <div className="text-[11px] text-emerald-600">{t("reimburse.reimbursedSection")}</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-emerald-800">
                      {t("reimburse.summaryReimbursed", { count: reimbursedList.length, amount: formatMoney(reimbursedTotal) })}
                    </div>
                  </div>
                </div>

                {/* Batch table */}
                <div className="mb-2 flex shrink-0 items-center justify-between">
                  <span className="text-xs text-slate-400">{t("reimburse.table.batchCount", { count: data?.batches.length ?? 0 })}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openCreateBatch}
                      className="primary-button flex h-8 items-center gap-1.5 px-3 text-xs"
                      disabled={busy}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("reimburse.batchCreate")}
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  <AdvancedDataTable
                    storageKey="mmh_reimbursement_batches_table_v1"
                    columns={batchColumns}
                    rows={data?.batches ?? []}
                    rowKey={(batch) => batch.id}
                    minTableWidth={920}
                    emptyText={t("reimburse.noReimbursements")}
                    showFilters
                    fillHeight
                    compactRows
                    toolbarMode="none"
                    rowActionsWidth={104}
                    rowActionsMinWidth={96}
                    onRowClick={(batch) => setSelectedBatchId(batch.id)}
                    rowClassName={(batch) => `cursor-pointer ${batch.id === selectedBatch?.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
                    rowActions={(batch) => (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={`${reimbursementActionButtonClass} text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50`}
                          onClick={(event) => { event.stopPropagation(); openBatchPayment(batch); }}
                          disabled={busy || (batchPayableCounts.get(batch.id) ?? 0) === 0}
                          title={t("reimburse.batch.reimburse")}
                          aria-label={t("reimburse.batch.reimburse")}
                        >
                          <Banknote className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className={`${reimbursementActionButtonClass} text-slate-700 hover:bg-slate-50 hover:text-blue-600`}
                          onClick={(event) => { event.stopPropagation(); openEditBatch(batch); }}
                          title={t("reimburse.edit")}
                          aria-label={t("reimburse.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className={`${reimbursementActionButtonClass} text-rose-600 hover:border-rose-200 hover:bg-rose-50`}
                          title={t("reimburse.batch.delete")}
                          aria-label={t("reimburse.batch.delete")}
                          onClick={(event) => { event.stopPropagation(); void submitDeleteBatch(batch); }}
                          disabled={busy}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  />
                </div>

              </section>

              {/* Lower pane: documents in selected batch */}
              <section className="flex h-full min-h-0 flex-col overflow-hidden">
                {selectedBatch ? (
                  <>
                    <div className="shrink-0 border-b border-blue-200 bg-blue-50 px-3 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-blue-700">{t("reimburse.table.batchTitle", { title: selectedBatch.title })}</span>
                        {selectedBatch.status === "reimbursed" ? (
                          <button type="button" onClick={openCreateBatch} className="primary-button h-7 px-2 text-xs" disabled={busy}>
                            <Plus className="mr-1 inline h-3 w-3" />{t("reimburse.batchCreate")}
                          </button>
                        ) : (
                          <button type="button" onClick={openCreate} className="primary-button h-7 px-2 text-xs" disabled={busy}>{t("reimburse.create")}</button>
                        )}
                      </div>
                    </div>
                    <div className="min-h-0 flex-1">
                      <AdvancedDataTable
                        storageKey="mmh_reimbursement_documents_table_v1"
                        columns={documentColumns}
                        rows={batchReimbursements}
                        rowKey={(reimbursement) => reimbursement.id}
                        minTableWidth={820}
                        emptyText={t("reimburse.noReimbursements")}
                        showFilters
                        fillHeight
                        compactRows
                        toolbarMode="none"
                        rowActionsWidth={156}
                        rowActionsMinWidth={144}
                        rowClassName={() => "hover:bg-slate-50"}
                        rowActions={(reimbursement) => (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              className={`${reimbursementActionButtonClass} text-slate-600 hover:bg-slate-50 hover:text-blue-600`}
                              title={t("reimburse.print")}
                              aria-label={t("reimburse.print")}
                              onClick={(event) => { event.stopPropagation(); setPrintTarget(reimbursement); }}
                            >
                              <Printer className="h-3.5 w-3.5" />
                            </button>
                            {reimbursement.status === "pending" ? (
                              <button
                                type="button"
                                className={`${reimbursementActionButtonClass} text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50`}
                                title={t("reimburse.document.audit")}
                                aria-label={t("reimburse.document.audit")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setApprovalTarget(reimbursement);
                                  setApprovedAmount(String(reimbursement.approvedAmount ?? reimbursement.totalAmount));
                                  setApprovalDate(reimbursement.approvalDate ?? todayDateLocalYmd());
                                  setApprovalNote(reimbursement.approvalNote ?? "");
                                }}
                                disabled={busy}
                              >
                                <Check className="h-3 w-3" />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`${reimbursementActionButtonClass} text-rose-600 hover:border-rose-200 hover:bg-rose-50`}
                              title={t("reimburse.document.delete")}
                              aria-label={t("reimburse.document.delete")}
                              onClick={(event) => { event.stopPropagation(); void submitDelete(reimbursement); }}
                              disabled={busy || reimbursement.status !== "pending"}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              className={`${reimbursementActionButtonClass} text-slate-700 hover:bg-slate-50 hover:text-blue-600`}
                              title={t("reimburse.edit")}
                              aria-label={t("reimburse.edit")}
                              onClick={(event) => { event.stopPropagation(); setEditingReimbId(reimbursement.id); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              className={`${reimbursementActionButtonClass} text-slate-600 hover:bg-slate-50 hover:text-blue-600`}
                              title={t("reimburse.source.add")}
                              aria-label={t("reimburse.source.add")}
                            onClick={(event) => { event.stopPropagation(); setLinkTransactionIds([]); setLinkingReimbursementId(reimbursement.id); }}
                            >
                              <Link2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    {t("reimburse.editor.selectHint")}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {showCreate ? (
        <ReimbursementFormModal
          objectId={objectId}
          objectName={objectName}
          advanceAccountId={advanceAccountId}
          objectType={objectType}
          entries={createSeedEntries}
          batchId={selectedBatch?.id}
          actions={actions}
          onClose={() => {
            setSeedsConsumed(true);
            setShowCreate(false);
          }}
          onCreated={() => {
            setSeedsConsumed(true);
            void load();
          }}
        />
      ) : null}

      {showCreateBatch || editingBatchId ? (
        <div className="app-modal-backdrop z-[70]">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{t(editingBatchId ? "reimburse.batch.edit" : "reimburse.batchCreate")}</div>
              <button type="button" onClick={() => { setShowCreateBatch(false); setEditingBatchId(null); setBatchTitle(""); setBatchNote(""); setBatchStartDate(""); setBatchEndDate(""); }} className="secondary-button h-8 px-2" disabled={busy}>{t("table.close")}</button>
            </div>
            <div className="space-y-3 p-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.batchTitle")}</label>
                <input autoFocus value={batchTitle} onChange={(event) => setBatchTitle(event.target.value)} className="form-input h-9 w-full" onKeyDown={(event) => { if (event.key === "Enter") void (editingBatchId ? submitEditBatch() : submitCreateBatch()); }} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.batch.note")}</label>
                <input value={batchNote} onChange={(event) => setBatchNote(event.target.value)} className="form-input h-9 w-full" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.batch.dateRange")}</label>
                <div className="flex items-center gap-2">
                  <input type="date" value={batchStartDate} onChange={(event) => setBatchStartDate(event.target.value)} className="form-input h-9 min-w-0 flex-1" />
                  <span className="text-slate-400">~</span>
                  <input type="date" value={batchEndDate} onChange={(event) => setBatchEndDate(event.target.value)} className="form-input h-9 min-w-0 flex-1" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 p-3">
              <button type="button" onClick={() => { setShowCreateBatch(false); setEditingBatchId(null); setBatchTitle(""); setBatchNote(""); setBatchStartDate(""); setBatchEndDate(""); }} className="secondary-button h-9 px-3" disabled={busy}>{t("common.cancel")}</button>
              <button type="button" onClick={() => void (editingBatchId ? submitEditBatch() : submitCreateBatch())} className="primary-button h-9 px-3" disabled={busy || !batchTitle.trim()}>{busy ? t("debtShell.saving") : t("common.save")}</button>
            </div>
          </div>
        </div>
      ) : null}

      {paymentBatch ? (
        <div className="app-modal-backdrop z-[80]">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("reimburse.batch.reimburse")}</div>
                <div className="mt-0.5 text-xs text-slate-500">{paymentBatch.title}</div>
              </div>
              <button type="button" onClick={() => setPaymentBatch(null)} className="secondary-button h-8 px-2" disabled={busy}>
                {t("table.close")}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-[11px] text-slate-500">{t("reimburse.batch.paymentDocuments")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{paymentBatchPayableCount}</div>
                </div>
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-[11px] text-slate-500">{t("reimburse.batch.paymentClaimedTotal")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{formatMoneyYuan(paymentClaimedTotal)}</div>
                </div>
                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2">
                  <div className="text-[11px] text-blue-600">{t("reimburse.batch.paymentApprovedTotal")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-blue-800">{formatMoneyYuan(paymentApprovedTotal)}</div>
                </div>
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-[11px] text-slate-500">{t("reimburse.batch.paymentLinkedTotal")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{formatMoneyYuan(paymentLinkedTransactionTotal)}</div>
                </div>
                <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="text-[11px] text-emerald-700">{t("reimburse.batch.paymentTransferTotal")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-emerald-800">{formatMoneyYuan(paymentTransferTotal)}</div>
                </div>
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
                  <div className="text-[11px] text-amber-700">{t("reimburse.batch.paymentFeeTotal")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-amber-800">{formatMoneyYuan(paymentFeeTotal)}</div>
                </div>
                <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="text-[11px] text-emerald-700">{t("reimburse.batch.paymentActualTotal")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-emerald-800">{formatMoneyYuan(paymentActualTotal)}</div>
                </div>
              </div>
              <div className="overflow-hidden rounded border border-slate-200">
                <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_8rem] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
                  <span>{t("reimburse.batch.paymentDocument")}</span>
                  <span className="text-right">{t("reimburse.document.claimedAmount")}</span>
                  <span className="text-right">{t("reimburse.document.approvedAmount")}</span>
                  <span className="text-right">{t("reimburse.batch.paymentFeeTotal")}</span>
                </div>
                <div className="max-h-52 overflow-y-auto">
                  {paymentDocuments.map((reimbursement) => (
                    <div key={reimbursement.id} className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_8rem] items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-slate-700" title={reimbursement.title}>{reimbursement.title}</div>
                        <div className="mt-0.5 text-[11px] text-slate-400">{reimbursement.createdAt.slice(0, 10)}</div>
                      </div>
                      <div className="text-right text-xs tabular-nums text-slate-600">{formatMoneyYuan(reimbursement.totalAmount)}</div>
                      <CalcInput
                        value={paymentApprovedAmounts[reimbursement.id] ?? String(reimbursement.approvedAmount ?? reimbursement.totalAmount)}
                        onChange={(value) => setPaymentApprovedAmounts((current) => ({ ...current, [reimbursement.id]: value }))}
                        hideCalculator
                        inputClassName="h-7 w-full px-1.5 text-right text-xs tabular-nums"
                        ariaLabel={`${t("reimburse.document.approvedAmount")} ${reimbursement.title}`}
                      />
                      <CalcInput
                        value={paymentFees[reimbursement.id] ?? "0"}
                        onChange={(value) => setPaymentFees((current) => ({ ...current, [reimbursement.id]: value }))}
                        hideCalculator
                        inputClassName="h-7 w-full px-1.5 text-right text-xs tabular-nums"
                        ariaLabel={`${t("reimburse.batch.paymentFeeTotal")} ${reimbursement.title}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <fieldset>
                <legend className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.reimburseBalanceDiffMode")}</legend>
                <div className="flex flex-col gap-2 text-xs text-slate-700">
                  <label className="flex items-center gap-2"><input type="radio" name="reimbursement-balance-diff" checked={balanceDiffMode === "loss"} onChange={() => setBalanceDiffMode("loss")} />{t("reimburse.reimburseBalanceDiffLoss")}</label>
                  <label className="flex items-center gap-2"><input type="radio" name="reimbursement-balance-diff" checked={balanceDiffMode === "remain"} onChange={() => setBalanceDiffMode("remain")} />{t("reimburse.reimburseBalanceDiffRemain")}</label>
                </div>
              </fieldset>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.reimburseDate")}</label>
                <DateStepper value={reimburseDate} onChange={setReimburseDate} className="h-9 w-full" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.cashAccount")}</label>
                <select
                  value={reimburseCashAccountId}
                  onChange={(event) => setReimburseCashAccountId(event.target.value)}
                  className="form-input h-9 w-full"
                >
                  {cashAccountOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {[option.label, option.institutionName, option.numberMasked, option.kind ? t(`account.kind.${option.kind}`) : null, option.currency].filter(Boolean).join(" · ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.batch.paymentNote")}</label>
                <textarea
                  value={reimburseNote}
                  onChange={(event) => setReimburseNote(event.target.value)}
                  className="form-textarea min-h-[4.5rem] resize-y"
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 p-3">
              <button type="button" onClick={() => setPaymentBatch(null)} className="secondary-button h-9 px-3" disabled={busy}>
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => { void submitBatchPayment(); }} className="primary-button h-9 px-3" disabled={busy || !reimburseCashAccountId || paymentBatchPayableCount === 0}>
                {busy ? t("debtShell.saving") : t("reimburse.batch.reimburseConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {printTarget ? (
        <ReimbursementPreview
          reimbursement={printTarget}
          counterpartyName={objectName}
          onClose={() => setPrintTarget(null)}
        />
      ) : null}

      {linkingReimbursement ? (
        <div className="app-modal-backdrop z-[80]">
          <div className="app-modal-panel max-w-3xl">
            <div className="modal-header shrink-0">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("reimburse.source.add")}</div>
                <div className="mt-0.5 text-xs text-slate-500">{linkingReimbursement.title}</div>
              </div>
              <button type="button" onClick={() => { setLinkingReimbursementId(null); setLinkTransactionIds([]); }} className="secondary-button h-8 px-2" disabled={busy}>{t("table.close")}</button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <section>
                <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.source.linkedTransactions")}</div>
                {linkingReimbursement.linkedTransactions.length ? (
                  <div className="divide-y divide-slate-100 rounded border border-slate-200">
                    {linkingReimbursement.linkedTransactions.map((item) => (
                      <div key={item.txRecordId} className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs">
                        <span className="min-w-0 truncate text-slate-600">{item.date} · {item.categoryName ?? "-"} · {formatMoneyYuan(item.amount)}{item.note ? ` · ${item.note}` : ""}</span>
                        <button
                          type="button"
                          className="secondary-button h-6 shrink-0 px-2 text-xs"
                          disabled={busy || linkingReimbursement.status !== "pending"}
                          onClick={() => {
                            if (window.confirm(t("reimburse.source.unlinkConfirm"))) void unlinkTransaction(linkingReimbursement, item.txRecordId);
                          }}
                        >
                          {t("reimburse.source.unlink")}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : <div className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">{t("reimburse.source.noLinkedTransactions")}</div>}
              </section>
              <section>
                <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.source.selectTransaction")}</div>
                <div className="max-h-64 overflow-y-auto rounded border border-slate-200">
                  {(data?.candidates ?? []).filter((candidate) => candidate.advanceAccountId === linkingReimbursement.advanceAccountId).map((candidate) => (
                    <label key={candidate.id} className="flex cursor-pointer items-start gap-2 border-b border-slate-100 px-2 py-1.5 text-xs last:border-b-0 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={linkTransactionIds.includes(candidate.id)}
                        onChange={(event) => setLinkTransactionIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))}
                        disabled={busy || linkingReimbursement.status !== "pending"}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 text-slate-600">{candidate.date} · {candidate.categoryName ?? "-"} · <span className="tabular-nums">{formatMoneyYuan(candidate.amount)}</span>{candidate.note ? ` · ${candidate.note}` : ""}</span>
                    </label>
                  ))}
                  {(data?.candidates ?? []).filter((candidate) => candidate.advanceAccountId === linkingReimbursement.advanceAccountId).length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-slate-400">{t("reimburse.source.noCandidates")}</div>
                  ) : null}
                </div>
              </section>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 p-3">
              <button type="button" onClick={() => { setLinkingReimbursementId(null); setLinkTransactionIds([]); }} className="secondary-button h-9 px-3" disabled={busy}>{t("common.cancel")}</button>
              <button
                type="button"
                onClick={() => { if (linkTransactionIds.length > 0) void linkTransactions(linkingReimbursement, linkTransactionIds); }}
                className="primary-button h-9 px-3"
                disabled={busy || linkingReimbursement.status !== "pending" || linkTransactionIds.length === 0}
              >
                {busy ? t("debtShell.saving") : t("reimburse.source.link")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {approvalTarget || editingReimb ? (
        <div className="app-modal-backdrop z-[80]">
          <div
            className="app-modal-panel resize"
            style={{
              width: "min(80rem, 92vw)",
              height: "min(90vh, 58rem)",
              minWidth: "min(720px, calc(100vw - 2rem))",
              minHeight: "min(520px, calc(100vh - 2rem))",
              maxWidth: "calc(100vw - 2rem)",
            }}
          >
            <ReimbursementEditor
              reimbursement={approvalTarget ?? editingReimb!}
              batches={data?.batches ?? []}
              accountName={accountName}
              candidates={data?.candidates ?? []}
              mode={approvalTarget ? "audit" : "edit"}
              auditAmount={approvedAmount}
              onAuditAmountChange={setApprovedAmount}
              auditDate={approvalDate}
              onAuditDateChange={setApprovalDate}
              auditNote={approvalNote}
              onAuditNoteChange={setApprovalNote}
              onAuditSubmit={() => void submitApproval()}
              onCancelApproval={() => void submitCancelApproval()}
              canCancelApproval={approvalTarget?.approvedAmount != null && approvalTarget.status !== "reimbursed"}
              auditBusy={busy}
              actions={{
                update: actions.update,
                updateItem: actions.updateItem,
                createItem: actions.createItem,
                deleteItem: actions.deleteItem,
                linkTransaction: actions.linkTransaction,
                linkTransactions: actions.linkTransactions,
                unlinkTransaction: actions.unlinkTransaction,
              }}
              onClose={() => {
                setApprovalTarget(null);
                setEditingReimbId(null);
              }}
              onSaved={async () => { await load(); }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
