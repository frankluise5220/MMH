"use client";

import { useI18n } from "@/lib/i18n";
import { formatMoneyYuan } from "@/lib/format";
import { Eraser, Link2, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DateStepper } from "./DateStepper";
import { CalcInput, evaluateCalcInputExpression } from "./CalcInput";
import { reimbursementErrorMessage } from "@/lib/reimbursement-error";
import type {
  ReimbursementBatchData,
  ReimbursementCandidateData,
  ReimbursementData,
  ReimbursementExpenseItemValue,
  ReimbursementKindValue,
} from "@/lib/server/sidebar-actions/reimbursement-actions";

// ─── Editable row state ──────────────────────────────────────────────────────
type EditableItem = {
  id: string;
  txRecordId: string | null;
  categoryName: string | null;
  expenseItem: ReimbursementExpenseItemValue | null;
  days: string;
  fromPlace: string;
  toPlace: string;
  amount: string;
  outsideTransportAmount: string;
  cityTransportAmount: string;
  subsidyAmount: string;
  lodgingAmount: string;
  entryDate: string;
  note: string | null;
};

// ─── Header state ────────────────────────────────────────────────────────────
type EditableHeader = {
  batchId: string;
  documentNumber: string;
  travelStartDate: string;
  travelEndDate: string;
  travelReason: string;
  note: string;
  attachmentCount: string;
};

// ─── Main editor component ───────────────────────────────────────────────────
export function ReimbursementEditor({
  reimbursement,
  batches,
  candidates,
  accountName,
  actions,
  mode = "edit",
  auditAmount,
  onAuditAmountChange,
  auditDate,
  onAuditDateChange,
  auditNote,
  onAuditNoteChange,
  onAuditSubmit,
  onCancelApproval,
  canCancelApproval = false,
  auditBusy = false,
  onClose,
  onSaved,
}: {
  reimbursement: ReimbursementData;
  batches: ReimbursementBatchData[];
  candidates: ReimbursementCandidateData[];
  accountName: string;
  actions: {
    update: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
    updateItem: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
    createItem: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
    deleteItem: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
    linkTransaction: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
    linkTransactions: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
    unlinkTransaction: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
  };
  mode?: "edit" | "audit";
  auditAmount?: string;
  onAuditAmountChange?: (value: string) => void;
  auditDate?: string;
  onAuditDateChange?: (value: string) => void;
  auditNote?: string;
  onAuditNoteChange?: (value: string) => void;
  onAuditSubmit?: () => void;
  onCancelApproval?: () => void;
  canCancelApproval?: boolean;
  auditBusy?: boolean;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const { t } = useI18n();

  const isPending = reimbursement.status === "pending";
  const isAuditMode = mode === "audit";
  const isEditable = isPending && !isAuditMode;
  const [kind, setKind] = useState<ReimbursementKindValue>(reimbursement.kind);
  const isTravel = kind === "travel";

  // ── Header state ────────────────────────────────────────────────────────────
  const [header, setHeader] = useState<EditableHeader>({
    batchId: reimbursement.batchId ?? "",
    documentNumber: reimbursement.documentNumber ?? reimbursement.title,
    travelStartDate: reimbursement.travelStartDate ?? "",
    travelEndDate: reimbursement.travelEndDate ?? "",
    travelReason: reimbursement.travelReason ?? "",
    note: reimbursement.note ?? "",
    attachmentCount: String(reimbursement.attachmentCount ?? ""),
  });

  // ── Items state ─────────────────────────────────────────────────────────────
  const [items, setItems] = useState<EditableItem[]>(() =>
    reimbursement.items.map((item) => ({
      id: item.id,
      txRecordId: item.txRecordId,
      categoryName: item.categoryName,
      expenseItem: item.expenseItem,
      days: String(item.days ?? ""),
      fromPlace: item.fromPlace ?? "",
      toPlace: item.toPlace ?? "",
      amount: String(item.amount),
      outsideTransportAmount: String(item.outsideTransportAmount ?? 0),
      cityTransportAmount: String(item.cityTransportAmount ?? 0),
      subsidyAmount: String(item.subsidyAmount ?? 0),
      lodgingAmount: String(item.lodgingAmount ?? 0),
      entryDate: item.entryDate,
      note: item.note,
    })),
  );

  const [savingHeader, setSavingHeader] = useState(false);
  const [savingItems, setSavingItems] = useState(false);
  const [linkingTransaction, setLinkingTransaction] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<string[]>([]);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [linkedTransactions, setLinkedTransactions] = useState(reimbursement.linkedTransactions);
  const preserveLocalStateRef = useRef(false);
  useEffect(() => {
    if (preserveLocalStateRef.current) {
      preserveLocalStateRef.current = false;
      return;
    }
    setHeader({
      batchId: reimbursement.batchId ?? "",
      documentNumber: reimbursement.documentNumber ?? reimbursement.title,
      travelStartDate: reimbursement.travelStartDate ?? "",
      travelEndDate: reimbursement.travelEndDate ?? "",
      travelReason: reimbursement.travelReason ?? "",
      note: reimbursement.note ?? "",
      attachmentCount: String(reimbursement.attachmentCount ?? ""),
    });
    setKind(reimbursement.kind);
    setItems(reimbursement.items.map((item) => ({
      id: item.id,
      txRecordId: item.txRecordId,
      categoryName: item.categoryName,
      expenseItem: item.expenseItem,
      days: String(item.days ?? ""),
      fromPlace: item.fromPlace ?? "",
      toPlace: item.toPlace ?? "",
      amount: String(item.amount),
      outsideTransportAmount: String(item.outsideTransportAmount ?? 0),
      cityTransportAmount: String(item.cityTransportAmount ?? 0),
      subsidyAmount: String(item.subsidyAmount ?? 0),
      lodgingAmount: String(item.lodgingAmount ?? 0),
      entryDate: item.entryDate,
      note: item.note,
    })));
    setLinkedTransactions(reimbursement.linkedTransactions);
  }, [reimbursement]);

  // ── Derived totals ──────────────────────────────────────────────────────────
  const itemTotals = useMemo(() => {
    return items.map((item) => {
      const parsed = isTravel
        ? [item.outsideTransportAmount, item.cityTransportAmount, item.subsidyAmount, item.lodgingAmount]
          .reduce((sum, value) => sum + (evaluateCalcInputExpression(value, 0) ?? 0), 0)
        : (evaluateCalcInputExpression(item.amount, 0) ?? 0);
      return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
    });
  }, [items, isTravel]);

  const totalAmount = useMemo(() => itemTotals.reduce((s, v) => s + v, 0), [itemTotals]);
  const auditAmountValue = evaluateCalcInputExpression(auditAmount ?? "", 0);
  const linkedTransactionTotal = useMemo(
    () => linkedTransactions.reduce((sum, item) => sum + item.amount, 0),
    [linkedTransactions],
  );
  const selectedBatch = batches.find((batch) => batch.id === header.batchId);
  const linkedTransactionIds = new Set(linkedTransactions.map((item) => item.txRecordId));
  const availableCandidates = candidates.filter(
    (candidate) => candidate.advanceAccountId === reimbursement.advanceAccountId && !linkedTransactionIds.has(candidate.id),
  );
  const travelColumnTotals = items.reduce((totals, item, index) => {
    totals.outsideTransport += Math.round((evaluateCalcInputExpression(item.outsideTransportAmount, 0) ?? 0) * 100);
    totals.cityTransport += Math.round((evaluateCalcInputExpression(item.cityTransportAmount, 0) ?? 0) * 100);
    totals.allowance += Math.round((evaluateCalcInputExpression(item.subsidyAmount, 0) ?? 0) * 100);
    totals.lodging += Math.round((evaluateCalcInputExpression(item.lodgingAmount, 0) ?? 0) * 100);
    totals.subtotal += Math.round((itemTotals[index] ?? 0) * 100);
    return totals;
  }, { outsideTransport: 0, cityTransport: 0, allowance: 0, lodging: 0, subtotal: 0 });

  // ── Patch helpers ───────────────────────────────────────────────────────────
  const patchItem = (id: string, patch: Partial<EditableItem>) => {
    setItems((cur) => cur.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const renderTravelAmount = (
    item: EditableItem,
    expenseItem: ReimbursementExpenseItemValue,
    field: "outsideTransportAmount" | "cityTransportAmount" | "subsidyAmount" | "lodgingAmount",
  ) => {
    if (!isEditable) return formatMoneyYuan(Number(item[field]) || 0);
    return (
      <CalcInput
        value={item[field]}
        onChange={(value) => patchItem(item.id, { [field]: value })}
        precision={2}
        hideCalculator
        inputClassName={`${INPUT_STYLE} h-7 text-right font-sans`}
        className="w-full"
      />
    );
  };

  const buildItemFormData = (item: EditableItem, index: number) => {
    const fd = new FormData();
    fd.set("itemId", item.id);
    fd.set("reimbursementId", reimbursement.id);
    fd.set("expenseItem", item.expenseItem ?? "");
    fd.set("categoryName", item.categoryName ?? "");
    fd.set("fromPlace", item.fromPlace);
    fd.set("toPlace", item.toPlace);
    fd.set("amount", item.amount);
    if (isTravel) {
      fd.set("outsideTransportAmount", item.outsideTransportAmount);
      fd.set("cityTransportAmount", item.cityTransportAmount);
      fd.set("subsidyAmount", item.subsidyAmount);
      fd.set("lodgingAmount", item.lodgingAmount);
      fd.set("amount", String(itemTotals[index] ?? 0));
    }
    fd.set("entryDate", item.entryDate);
    fd.set("days", item.days);
    fd.set("note", item.note ?? "");
    return fd;
  };

  const saveItemData = async (item: EditableItem, index: number) => {
    const formData = buildItemFormData(item, index);
    return item.id.startsWith("draft-")
      ? actions.createItem(formData)
      : actions.updateItem(formData);
  };

  // Save the header and every edited row together so the main Save button
  // cannot leave date or amount changes only in the editor's local state.
  const saveAll = async () => {
    if (savingHeader || savingItems || !isEditable) return;
    setSavingHeader(true);
    try {
      const headerFormData = new FormData();
      headerFormData.set("reimbursementId", reimbursement.id);
      headerFormData.set("kind", kind);
      headerFormData.set("batchId", header.batchId);
      headerFormData.set("documentNumber", header.documentNumber);
      headerFormData.set("title", header.documentNumber);
      headerFormData.set("travelStartDate", header.travelStartDate);
      headerFormData.set("travelEndDate", header.travelEndDate);
      headerFormData.set("travelReason", header.travelReason);
      headerFormData.set("note", header.note);
      headerFormData.set("attachmentCount", header.attachmentCount);
      const headerResult = await actions.update(headerFormData);
      if (!headerResult.ok) {
        window.alert(reimbursementErrorMessage(headerResult.error!, t));
        return;
      }

      for (const [index, item] of items.entries()) {
        const itemResult = await saveItemData(item, index);
        if (!itemResult.ok) {
          window.alert(reimbursementErrorMessage(itemResult.error!, t));
          return;
        }
      }

      setSavedMessage(t("reimburse.alert.saved"));
      window.setTimeout(() => setSavedMessage(null), 2000);
      preserveLocalStateRef.current = true;
      await onSaved?.();
    } finally {
      setSavingHeader(false);
    }
  };

  const linkTransactions = async (txRecordIds: string[]) => {
    if (linkingTransaction || !isEditable) return;
    setLinkingTransaction(true);
    try {
      const fd = new FormData();
      fd.set("reimbursementId", reimbursement.id);
      fd.set("txRecordIds", JSON.stringify(txRecordIds));
      const result = await actions.linkTransactions(fd);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error!, t));
        return;
      }
      const selectedCandidates = availableCandidates.filter((item) => txRecordIds.includes(item.id));
      if (selectedCandidates.length > 0) {
        setLinkedTransactions((current) => [...current, ...selectedCandidates.map((candidate) => ({
          txRecordId: candidate.id,
          date: candidate.date,
          amount: candidate.amount,
          categoryName: candidate.categoryName,
          note: candidate.note,
        }))]);
      }
      preserveLocalStateRef.current = true;
      await onSaved?.();
      setSavedMessage(t("reimburse.source.linked"));
      setSelectedTransactionIds([]);
      setShowLinkDialog(false);
    } finally {
      setLinkingTransaction(false);
    }
  };

  const clearTransaction = async (txRecordId: string) => {
    if (linkingTransaction || !isEditable || !window.confirm(t("reimburse.source.clearConfirm"))) return;
    setLinkingTransaction(true);
    try {
      const fd = new FormData();
      fd.set("reimbursementId", reimbursement.id);
      fd.set("txRecordId", txRecordId);
      const result = await actions.unlinkTransaction(fd);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error!, t));
        return;
      }
      setLinkedTransactions((current) => current.filter((item) => item.txRecordId !== txRecordId));
      preserveLocalStateRef.current = true;
      await onSaved?.();
      setSavedMessage(t("reimburse.source.cleared"));
    } finally {
      setLinkingTransaction(false);
    }
  };

  const deleteItem = async (itemId: string) => {
    if (savingItems || !isEditable || !window.confirm(t("reimburse.item.deleteConfirm"))) return;
    if (itemId.startsWith("draft-")) {
      setItems((current) => current.filter((item) => item.id !== itemId));
      return;
    }
    setSavingItems(true);
    try {
      const fd = new FormData();
      fd.set("reimbursementId", reimbursement.id);
      fd.set("itemId", itemId);
      const result = await actions.deleteItem(fd);
      if (!result.ok) {
        window.alert(reimbursementErrorMessage(result.error!, t));
        return;
      }
      setItems((current) => current.filter((item) => item.id !== itemId));
      preserveLocalStateRef.current = true;
      await onSaved?.();
      setSavedMessage(t("reimburse.item.deleted"));
    } finally {
      setSavingItems(false);
    }
  };

  const addItem = () => {
    if (!isEditable) return;
    setItems((current) => [
      ...current,
      {
        id: `draft-${Date.now()}-${current.length}`,
        txRecordId: null,
        categoryName: kind === "general" ? "" : null,
        expenseItem: null,
        days: "",
        fromPlace: "",
        toPlace: "",
        amount: "0",
        outsideTransportAmount: "0",
        cityTransportAmount: "0",
        subsidyAmount: "0",
        lodgingAmount: "0",
        entryDate: "",
        note: "",
      },
    ]);
  };

  const changeKind = (nextKind: ReimbursementKindValue) => {
    if (!isEditable || nextKind === kind) return;
    setItems((current) => current.map((item, index) => {
      if (nextKind === "travel" && kind !== "travel") {
        const amount = evaluateCalcInputExpression(item.amount, 0) ?? 0;
        return {
          ...item,
          expenseItem: item.expenseItem ?? "transport",
          outsideTransportAmount: item.outsideTransportAmount === "0"
            ? String(amount)
            : item.outsideTransportAmount,
        };
      }
      if (nextKind !== "travel" && kind === "travel") {
        return { ...item, amount: String(itemTotals[index] ?? 0) };
      }
      return item;
    }));
    setKind(nextKind);
  };

  // ─── Column widths for ADT table ────────────────────────────────────────────
  // Column widths for the report detail table.
  const COL_DATE = "8rem";
  const COL_AMOUNT = "7rem";
  const INPUT_STYLE =
    "w-full border border-transparent bg-transparent px-1 py-0.5 text-xs text-slate-700 outline-none focus:border-blue-400 focus:bg-white rounded-sm transition";

  return (
    <div className="flex min-h-0 flex-col" style={{ minHeight: "400px" }}>
      {/* ── Toolbar ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-700">{t(isAuditMode ? "reimburse.document.audit" : "reimburse.editor.title")}</span>
          {savedMessage && (
            <span className="text-xs text-emerald-600">{savedMessage}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isEditable && (
            <button
              type="button"
              onClick={saveAll}
              disabled={savingHeader || savingItems}
              className="primary-button flex h-8 items-center gap-1.5 px-3 text-xs"
            >
              <Save className="h-3.5 w-3.5" />
              {savingHeader ? "…" : t("common.save")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="secondary-button flex h-8 w-8 shrink-0 items-center justify-center p-0 leading-none"
            title={t("table.close")}
          >
            <X aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={2.25} />
          </button>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-4 md:p-6">
        <article className="w-full border border-slate-300 bg-white px-3 py-4 shadow-sm md:px-5 md:py-5">
          <header className="border-b-2 border-slate-700 pb-4 text-center">
            <div className="text-lg font-semibold tracking-wide text-slate-800">{header.documentNumber || t("reimburse.form.titleFallback")}</div>
            <div className="mt-1 text-xs text-slate-500">{accountName}</div>
          </header>

          <section className="mt-3 grid grid-cols-12 border-l border-t border-slate-300 text-xs">
            <div className="col-span-3 border-b border-r border-slate-300 p-1.5">
              <div className="text-slate-500">{t("reimburse.batch.belongsTo")}</div>
              <select value={header.batchId} onChange={(event) => setHeader((current) => ({ ...current, batchId: event.target.value }))} disabled={!isEditable} className="mt-0.5 h-7 w-full border-b border-dotted border-slate-400 bg-transparent font-medium text-slate-800 outline-none disabled:appearance-none">
                {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.title}</option>)}
              </select>
            </div>
            <div className="col-span-3 border-b border-r border-slate-300 p-1.5">
              <div className="text-slate-500">{t("reimburse.document.type")}</div>
              {isEditable ? (
                <select
                  value={kind}
                  onChange={(event) => changeKind(event.target.value as ReimbursementKindValue)}
                  className="mt-0.5 h-7 w-full border-b border-dotted border-slate-400 bg-transparent font-medium text-slate-800 outline-none"
                >
                  <option value="travel">{t("reimburse.form.kindTravel")}</option>
                  <option value="general">{t("reimburse.form.kindGeneral")}</option>
                  <option value="advance">{t("reimburse.form.kindAdvance")}</option>
                </select>
              ) : (
                <div className="mt-0.5 font-medium text-slate-800">
                  {t(kind === "travel" ? "reimburse.form.kindTravel" : kind === "general" ? "reimburse.form.kindGeneral" : "reimburse.form.kindAdvance")}
                </div>
              )}
            </div>
            <div className="col-span-6 border-b border-r border-slate-300 p-1.5">
              <div className="text-slate-500">{t("reimburse.document.number")}</div>
              <input type="text" value={header.documentNumber} onChange={(e) => setHeader((h) => ({ ...h, documentNumber: e.target.value }))} disabled={!isEditable} className={`${INPUT_STYLE} mt-0.5 h-7 border-b border-dotted border-slate-400 text-slate-800 ${!isEditable ? "cursor-not-allowed" : ""}`} />
            </div>
            {isTravel && (
              <>
                <div className="col-span-12 border-b border-r border-slate-300 p-1.5 sm:col-span-5">
                  <label className="block text-slate-500">{t("reimburse.form.travelDateRange")}</label>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1">
                    <DateStepper
                      value={header.travelStartDate}
                      onChange={(v) => setHeader((h) => ({ ...h, travelStartDate: v }))}
                      disabled={!isEditable}
                      compact
                      className="h-7 min-w-0 flex-1 border-b border-dotted border-slate-400 text-xs"
                    />
                    <span className="shrink-0 text-slate-400">~</span>
                    <DateStepper
                      value={header.travelEndDate}
                      onChange={(v) => setHeader((h) => ({ ...h, travelEndDate: v }))}
                      disabled={!isEditable}
                      compact
                      className="h-7 min-w-0 flex-1 border-b border-dotted border-slate-400 text-xs"
                    />
                  </div>
                </div>
                <div className="col-span-9 border-b border-r border-slate-300 p-1.5 sm:col-span-6">
                  <label className="block text-slate-500">{t("reimburse.form.travelReason")}</label>
                  <input
                    type="text"
                    value={header.travelReason}
                    onChange={(e) => setHeader((h) => ({ ...h, travelReason: e.target.value }))}
                    disabled={!isEditable}
                    className={`${INPUT_STYLE} mt-0.5 h-7 border-b border-dotted border-slate-400 text-slate-800 ${!isEditable ? "cursor-not-allowed" : ""}`}
                  />
                </div>
                <div className="col-span-3 border-b border-r border-slate-300 p-1 sm:col-span-1">
                  <label className="block truncate text-slate-500">{t("reimburse.form.attachmentCount")}</label>
                  <CalcInput
                    value={header.attachmentCount}
                    onChange={(value) => setHeader((h) => ({ ...h, attachmentCount: value }))}
                    disabled={!isEditable}
                    precision={0}
                    hideCalculator
                    inputClassName={`${INPUT_STYLE} mt-0.5 h-7 border-b border-dotted border-slate-400 text-slate-800 font-sans`}
                    className="w-full"
                  />
                </div>
              </>
            )}
            {!isTravel && kind === "advance" && (
            <div className="col-span-12 border-b border-r border-slate-300 p-1.5">
              <label className="block text-slate-500">{t("reimburse.form.attachmentCount")}</label>
                <CalcInput
                  value={header.attachmentCount}
                  onChange={(value) => setHeader((h) => ({ ...h, attachmentCount: value }))}
                  disabled={!isEditable}
                  precision={0}
                  hideCalculator
                  inputClassName={`${INPUT_STYLE} mt-0.5 h-7 max-w-24 border-b border-dotted border-slate-400 text-slate-800 font-sans`}
                  className="max-w-24"
                />
            </div>
            )}
          </section>

        {/* ── ADT Table ── */}
        <div className="mt-5 overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="bg-slate-100 text-slate-600">
                <th className="border-b border-r border-slate-300 px-2 py-1.5 text-left font-medium" style={{ width: COL_DATE }}>
                  {t("reimburse.colDate")}
                </th>
                {isTravel ? (
                  <>
                    <th className="border-b border-r border-slate-300 px-2 py-1.5 text-left font-medium">{t("reimburse.travel.routeVehicle")}</th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">{t("reimburse.travel.outsideTransport")}</th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">{t("reimburse.travel.cityTransport")}</th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">{t("reimburse.travel.days")}</th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">{t("reimburse.travel.allowance")}</th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">{t("reimburse.expenseItem.lodging")}</th>
                  </>
                ) : (
                  <>
                    <th className="border-b border-r border-slate-300 px-2 py-1.5 text-left font-medium">{t(kind === "general" ? "reimburse.form.generalReason" : "reimburse.colCategory")}</th>
                    <th className="border-b border-r border-slate-300 px-2 py-1.5 text-right font-medium" style={{ width: COL_AMOUNT }}>{t("reimburse.colAmount")}</th>
                  </>
                )}
                <th className="w-24 border-b border-r border-slate-300 px-2 py-1.5 text-right font-medium">{t("reimburse.editor.subtotal")}</th>
                <th className="border-b border-r border-slate-300 px-2 py-1.5 text-left font-medium">{t("reimburse.colNote")}</th>
                {isEditable ? (
                  <th className="w-10 border-b border-r border-slate-300 px-1 text-center">
                    <button
                      type="button"
                      onClick={addItem}
                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:border-blue-400 hover:text-blue-600"
                      title={t("reimburse.item.add")}
                      aria-label={t("reimburse.item.add")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const itemTotal = itemTotals[i];
                return (
                  <tr key={item.id} className="hover:bg-blue-50/40">
                    {/* Date */}
                    <td className="border-b border-r border-slate-200 px-1 py-1">
                      {isEditable ? (
                        <DateStepper
                          value={item.entryDate}
                          onChange={(value) => patchItem(item.id, { entryDate: value })}
                          className="h-7 w-[7.5rem] text-xs"
                          compact
                        />
                      ) : (
                        <span className="px-1 text-slate-600">{item.entryDate}</span>
                      )}
                    </td>

                    {isTravel ? (
                      <>
                        <td className="border-b border-r border-slate-200 p-0.5 text-slate-600">
                          {isEditable ? (
                            <div className="grid grid-cols-2 gap-1">
                              <input
                                type="text"
                                value={item.fromPlace}
                                onChange={(event) => patchItem(item.id, { fromPlace: event.target.value })}
                                placeholder={t("reimburse.travel.fromPlace")}
                                className={`${INPUT_STYLE} h-7 min-w-0 border-b border-slate-200`}
                              />
                              <input
                                type="text"
                                value={item.toPlace}
                                onChange={(event) => patchItem(item.id, { toPlace: event.target.value })}
                                placeholder={t("reimburse.travel.toPlace")}
                                className={`${INPUT_STYLE} h-7 min-w-0 border-b border-slate-200`}
                              />
                            </div>
                          ) : (
                            <>
                              <div className="truncate" title={[item.fromPlace, item.toPlace].filter(Boolean).join(" -> ")}>
                                {[item.fromPlace, item.toPlace].filter(Boolean).join(" -> ") || "-"}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0.5 text-right tabular-nums">{renderTravelAmount(item, "transport", "outsideTransportAmount")}</td>
                        <td className="border-b border-r border-slate-200 p-0.5 text-right tabular-nums">{renderTravelAmount(item, "cityTransport", "cityTransportAmount")}</td>
                        <td className="border-b border-r border-slate-200 px-1 py-0.5 text-right tabular-nums">
                          {isEditable ? (
                            <CalcInput
                              value={item.days}
                              onChange={(value) => patchItem(item.id, { days: value })}
                              precision={0}
                              hideCalculator
                              inputClassName={`${INPUT_STYLE} h-7 text-right font-sans`}
                              className="w-full"
                            />
                        ) : item.days ?? "-"}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0.5 text-right tabular-nums">{renderTravelAmount(item, "subsidy", "subsidyAmount")}</td>
                        <td className="border-b border-r border-slate-200 p-0.5 text-right tabular-nums">{renderTravelAmount(item, "lodging", "lodgingAmount")}</td>
                      </>
                    ) : (
                      <>
                        <td className="border-b border-r border-slate-200 px-1 py-1.5 text-slate-600">
                          {isEditable && kind === "general" ? (
                            <input
                              type="text"
                              value={item.categoryName ?? ""}
                              onChange={(event) => patchItem(item.id, { categoryName: event.target.value })}
                              placeholder={t("reimburse.form.generalReasonPlaceholder")}
                              className={INPUT_STYLE}
                            />
                          ) : item.expenseItem ? t(`reimburse.expenseItem.${item.expenseItem}`) : item.categoryName ?? "-"}
                        </td>
                        <td className="border-b border-r border-slate-200 px-1 py-1 text-right">
                          {isEditable ? (
                            <CalcInput
                              value={item.amount}
                              onChange={(value) => patchItem(item.id, { amount: value })}
                              precision={2}
                              hideCalculator
                              inputClassName={`${INPUT_STYLE} text-right font-sans`}
                              className="w-full"
                            />
                          ) : formatMoneyYuan(itemTotal)}
                        </td>
                      </>
                    )}
                    <td className="border-b border-r border-slate-200 px-2 py-1.5 text-right font-medium tabular-nums text-slate-700">{formatMoneyYuan(itemTotal)}</td>
                    <td className="border-b border-r border-slate-200 px-1 py-0.5 text-slate-500">
                      {isEditable ? (
                        <input
                          type="text"
                          value={item.note ?? ""}
                          onChange={(event) => patchItem(item.id, { note: event.target.value })}
                          className={INPUT_STYLE}
                        />
                      ) : item.note ?? "-"}
                    </td>

                    {/* Save row button */}
                    {isEditable ? (
                      <td className="border-b border-r border-slate-200 px-1 py-1 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() => { void deleteItem(item.id); }}
                            disabled={savingItems}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:border-rose-400 hover:text-rose-600 disabled:opacity-40"
                            title={t("reimburse.item.delete")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}

              {/* ── Total row ── */}
              <tr className="bg-slate-100 font-semibold">
                <td className="border-t border-r border-slate-300 px-2 py-1.5 text-slate-600" colSpan={isTravel ? 2 : 2}>
                  {t("reimburse.totalLabel")}
                </td>
                {isTravel ? (
                  <>
                    <td className="border-t border-r border-slate-300 px-1 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(travelColumnTotals.outsideTransport / 100)}</td>
                    <td className="border-t border-r border-slate-300 px-1 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(travelColumnTotals.cityTransport / 100)}</td>
                    <td className="border-t border-r border-slate-300" />
                    <td className="border-t border-r border-slate-300 px-1 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(travelColumnTotals.allowance / 100)}</td>
                    <td className="border-t border-r border-slate-300 px-1 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(travelColumnTotals.lodging / 100)}</td>
                    <td className="border-t border-r border-slate-300 px-2 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(travelColumnTotals.subtotal / 100)}</td>
                    <td className="border-t border-r border-slate-300" />
                  </>
                ) : (
                  <>
                    <td className="border-t border-r border-slate-300 px-2 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(totalAmount)}</td>
                    <td className="border-t border-r border-slate-300 px-2 py-1.5 text-right tabular-nums text-slate-800">{formatMoneyYuan(totalAmount)}</td>
                    <td className="border-t border-r border-slate-300" />
                  </>
                )}
                {isEditable ? <td className="border-t border-r border-slate-300" /> : null}
              </tr>
            </tbody>
          </table>
        </div>

        <section className={`mt-4 grid grid-cols-1 border-l border-t border-slate-300 text-xs ${isAuditMode ? "sm:grid-cols-1" : "sm:grid-cols-3"}`}>
          {!isAuditMode ? (
            <div className="border-b border-r border-slate-300 p-2">
              <div className="text-slate-500">{t("reimburse.document.approvedAmount")}</div>
              <div className="mt-1 text-right text-base font-semibold tabular-nums text-slate-800">{reimbursement.approvedAmount == null ? "-" : formatMoneyYuan(reimbursement.approvedAmount)}</div>
            </div>
          ) : null}
          {!isAuditMode ? <div className="border-b border-r border-slate-300 p-2">
            <div className="text-slate-500">{t("reimburse.reimburseDate")}</div>
            <div className="mt-1 text-right font-medium tabular-nums text-slate-800">{reimbursement.reimbursedDate ?? "-"}</div>
          </div> : null}
        </section>

        {isAuditMode ? (
          <section className="mt-3 grid grid-cols-1 border-l border-t border-slate-300 text-xs sm:grid-cols-12">
            <label className="border-b border-r border-slate-300 p-2 sm:col-span-3">
              <span className="text-slate-500">{t("reimburse.document.approvalDate")}</span>
              <DateStepper
                value={auditDate ?? ""}
                onChange={(value) => onAuditDateChange?.(value)}
                className="mt-1 h-8 w-full"
              />
            </label>
            <div className="border-b border-r border-slate-300 p-2 sm:col-span-2">
              <span className="text-slate-500">{t("reimburse.reimburseDate")}</span>
              <div className="mt-1 h-8 flex items-center justify-end font-medium tabular-nums text-slate-800">
                {reimbursement.reimbursedDate ?? "-"}
              </div>
            </div>
            <label className="border-b border-r border-slate-300 p-2 sm:col-span-2">
              <span className="text-slate-500">{t("reimburse.document.approvedAmount")}</span>
              <CalcInput
                value={auditAmount ?? ""}
                onChange={(value) => onAuditAmountChange?.(value)}
                precision={2}
                hideCalculator
                inputClassName="mt-1 h-8 w-full text-right tabular-nums font-sans"
                className="w-full"
              />
            </label>
            <label className="border-b border-r border-slate-300 p-2 sm:col-span-3">
              <span className="text-slate-500">{t("reimburse.document.approvalNote")}</span>
              <input
                type="text"
                value={auditNote ?? ""}
                onChange={(event) => onAuditNoteChange?.(event.target.value)}
                className="mt-1 h-8 w-full rounded-sm border border-slate-300 px-2 text-sm font-normal text-slate-800"
              />
            </label>
            <div className="flex items-end gap-1 border-b border-r border-slate-300 p-2 sm:col-span-2">
              {canCancelApproval ? (
                <button
                  type="button"
                  onClick={onCancelApproval}
                  className="secondary-button h-8 flex-1 px-2 text-xs"
                  disabled={auditBusy}
                >
                  {t("reimburse.document.cancelApproval")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onAuditSubmit}
                className="primary-button h-8 flex-1 px-3 text-xs"
                disabled={auditBusy || auditAmountValue == null}
              >
                {auditBusy ? t("debtShell.saving") : t("common.save")}
              </button>
            </div>
          </section>
        ) : null}

        {!isAuditMode && selectedBatch?.note && (
          <div className="mt-4 border-t border-slate-300 pt-2 text-xs">
            <span className="font-medium text-slate-600">{t("reimburse.batch.note")}：</span>
            <span className="whitespace-pre-wrap text-slate-700">{selectedBatch.note}</span>
          </div>
        )}

        {/* ── Source entries reference ── */}
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-slate-600">{t("reimburse.editor.sourceInfo")}</div>
              {isEditable && (
                <button
                  type="button"
                  onClick={() => { setSelectedTransactionIds([]); setShowLinkDialog(true); }}
                  className="secondary-button inline-flex h-7 items-center gap-1.5 px-2 text-xs"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {t("reimburse.source.add")}
                </button>
              )}
            </div>
            {linkedTransactions.length > 0 ? (
              <div className="overflow-x-auto rounded border border-slate-200 bg-white">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-slate-600">
                    <tr>
                      <th className="border-b border-r border-slate-200 px-2 py-1.5 text-left font-medium">{t("reimburse.source.date")}</th>
                      <th className="border-b border-r border-slate-200 px-2 py-1.5 text-left font-medium">{t("reimburse.source.category")}</th>
                      <th className="border-b border-r border-slate-200 px-2 py-1.5 text-right font-medium">{t("reimburse.source.amount")}</th>
                      <th className="border-b border-r border-slate-200 px-2 py-1.5 text-left font-medium">{t("reimburse.source.note")}</th>
                      {isEditable ? <th className="w-16 border-b border-slate-200" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {linkedTransactions.map((item) => (
                      <tr key={item.txRecordId}>
                        <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-600">{item.date}</td>
                        <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-600">{item.categoryName ?? "-"}</td>
                        <td className="border-b border-r border-slate-100 px-2 py-1.5 text-right font-medium tabular-nums text-slate-700">{formatMoneyYuan(item.amount)}</td>
                        <td className="max-w-[20rem] border-b border-r border-slate-100 px-2 py-1.5 text-slate-500">{item.note || "-"}</td>
                        {isEditable ? (
                          <td className="border-b border-slate-100 px-1 py-1 text-center">
                            <button type="button" onClick={() => void clearTransaction(item.txRecordId)} disabled={linkingTransaction} className="inline-flex h-6 items-center justify-center rounded border border-slate-200 bg-white px-1.5 text-slate-600 hover:border-amber-300 hover:text-amber-700 disabled:opacity-50" title={t("reimburse.source.clear")}>
                              <Eraser className="h-3 w-3" />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-semibold text-slate-700">
                      <td className="border-r border-slate-200 px-2 py-1.5" colSpan={2}>{t("reimburse.source.summary", { count: linkedTransactions.length })}</td>
                      <td className="border-r border-slate-200 px-2 py-1.5 text-right tabular-nums">{formatMoneyYuan(linkedTransactionTotal)}</td>
                      <td className="border-slate-200 px-2 py-1.5" colSpan={isEditable ? 2 : 1} />
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">{t("reimburse.source.noLinkedTransactions")}</div>
            )}
          </div>
        </article>
      </div>
      {showLinkDialog ? (
        <div className="app-modal-backdrop z-[90]">
          <div className="app-modal-panel max-w-xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{t("reimburse.source.add")}</div>
              <button type="button" onClick={() => setShowLinkDialog(false)} className="secondary-button h-8 px-2" disabled={linkingTransaction}>
                {t("table.close")}
              </button>
            </div>
            <div className="space-y-3 p-4">
              <section>
                <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.source.linkedTransactions")}</div>
                {linkedTransactions.length > 0 ? (
                  <div className="overflow-x-auto rounded border border-slate-200">
                    <table className="w-full border-collapse text-xs">
                      <thead className="bg-slate-50 text-slate-600"><tr>
                        <th className="border-b border-r border-slate-200 px-2 py-1 text-left font-medium">{t("reimburse.source.date")}</th>
                        <th className="border-b border-r border-slate-200 px-2 py-1 text-left font-medium">{t("reimburse.source.category")}</th>
                        <th className="border-b border-r border-slate-200 px-2 py-1 text-right font-medium">{t("reimburse.source.amount")}</th>
                        <th className="border-b border-slate-200 px-2 py-1 text-left font-medium">{t("reimburse.source.note")}</th>
                        <th className="border-b border-slate-200" />
                      </tr></thead>
                      <tbody>{linkedTransactions.map((item) => (
                        <tr key={item.txRecordId}>
                          <td className="border-b border-r border-slate-100 px-2 py-1">{item.date}</td>
                          <td className="border-b border-r border-slate-100 px-2 py-1">{item.categoryName ?? "-"}</td>
                          <td className="border-b border-r border-slate-100 px-2 py-1 text-right tabular-nums">{formatMoneyYuan(item.amount)}</td>
                          <td className="max-w-[18rem] border-b border-r border-slate-100 px-2 py-1">{item.note || "-"}</td>
                          <td className="border-b border-slate-100 px-1 py-1"><button type="button" className="secondary-button h-6 shrink-0 px-2 text-xs" disabled={linkingTransaction} onClick={() => void clearTransaction(item.txRecordId)}>{t("reimburse.source.clear")}</button></td>
                        </tr>
                      ))}<tr className="bg-slate-50 font-semibold"><td className="px-2 py-1.5" colSpan={2}>{t("reimburse.source.summary", { count: linkedTransactions.length })}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatMoneyYuan(linkedTransactionTotal)}</td><td colSpan={2} /></tr></tbody>
                    </table>
                  </div>
                ) : <div className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">{t("reimburse.source.noLinkedTransactions")}</div>}
              </section>
              <section>
                <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.source.selectTransaction")}</div>
                {availableCandidates.length > 0 ? (
                  <div className="max-h-64 overflow-y-auto rounded border border-slate-200">
                    {availableCandidates.map((candidate) => (
                      <label key={candidate.id} className="flex cursor-pointer items-start gap-2 border-b border-slate-100 px-2 py-1.5 text-xs last:border-b-0 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedTransactionIds.includes(candidate.id)}
                          onChange={(event) => setSelectedTransactionIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))}
                          disabled={linkingTransaction}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 text-slate-600">{candidate.date} · {candidate.categoryName ?? "-"} · <span className="tabular-nums">{formatMoneyYuan(candidate.amount)}</span>{candidate.note ? ` · ${candidate.note}` : ""}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                <div className="border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">
                  {t("reimburse.source.noCandidates")}
                </div>
                )}
              </section>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 p-3">
              <button type="button" onClick={() => setShowLinkDialog(false)} className="secondary-button h-9 px-3" disabled={linkingTransaction}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => { if (selectedTransactionIds.length > 0) void linkTransactions(selectedTransactionIds); }}
                className="primary-button h-9 px-3"
                disabled={linkingTransaction || selectedTransactionIds.length === 0}
              >
                {linkingTransaction ? t("debtShell.saving") : t("reimburse.source.link")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
