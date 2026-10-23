"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useI18n } from "@/lib/i18n";
import { formatAmountDraft, formatMoneyYuan } from "@/lib/format";
import { Eraser, Link2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DateStepper } from "./DateStepper";
import { CalcInput, evaluateCalcInputExpression } from "./CalcInput";
import { EntryModalShell } from "./EntryModalShell";
import {
  HEADER_CELL,
  HEADER_DATE,
  HEADER_EDIT,
  HEADER_FIELD,
  REIMBURSE_PANEL_STYLE,
} from "./reimbursement-table-styles";
import { reimbursementErrorMessage } from "@/lib/reimbursement-error";
import {
  MAX_EXPENSE_ROWS,
  ReimbursementDocumentForm,
  SOURCE_SCROLL_MAX_H,
  type ReimbursementDraftHeader,
  type ReimbursementDraftRow,
} from "./ReimbursementDocumentForm";
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
  // 「代付」报销类型已废弃：历史 advance 单据按一般报销编辑。
  const [kind, setKind] = useState<ReimbursementKindValue>(reimbursement.kind === "advance" ? "general" : reimbursement.kind);
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
      amount: formatAmountDraft(item.amount),
      outsideTransportAmount: formatAmountDraft(item.outsideTransportAmount ?? 0),
      cityTransportAmount: formatAmountDraft(item.cityTransportAmount ?? 0),
      subsidyAmount: formatAmountDraft(item.subsidyAmount ?? 0),
      lodgingAmount: formatAmountDraft(item.lodgingAmount ?? 0),
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
    setKind(reimbursement.kind === "advance" ? "general" : reimbursement.kind);
    setItems(reimbursement.items.map((item) => ({
      id: item.id,
      txRecordId: item.txRecordId,
      categoryName: item.categoryName,
      expenseItem: item.expenseItem,
      days: String(item.days ?? ""),
      fromPlace: item.fromPlace ?? "",
      toPlace: item.toPlace ?? "",
      amount: formatAmountDraft(item.amount),
      outsideTransportAmount: formatAmountDraft(item.outsideTransportAmount ?? 0),
      cityTransportAmount: formatAmountDraft(item.cityTransportAmount ?? 0),
      subsidyAmount: formatAmountDraft(item.subsidyAmount ?? 0),
      lodgingAmount: formatAmountDraft(item.lodgingAmount ?? 0),
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

  // 共用表单用「抬头对象 + patch」和「行 key + patch」接口：编辑窗的明细行以 id 作 key。
  const patchDraftHeader = (patch: Partial<ReimbursementDraftHeader>) =>
    setHeader((current) => ({ ...current, ...patch }));

  const draftRows: ReimbursementDraftRow[] = items.map((item) => ({
    key: item.id,
    txRecordId: item.txRecordId,
    expenseItem: item.expenseItem,
    categoryName: item.categoryName,
    entryDate: item.entryDate,
    fromPlace: item.fromPlace,
    toPlace: item.toPlace,
    days: item.days,
    amount: item.amount,
    outsideTransportAmount: item.outsideTransportAmount,
    cityTransportAmount: item.cityTransportAmount,
    subsidyAmount: item.subsidyAmount,
    lodgingAmount: item.lodgingAmount,
    note: item.note,
  }));

  const patchDraftRow = (key: string, patch: Partial<ReimbursementDraftRow>) => {
    setItems((current) => current.map((item) => (item.id === key ? { ...item, ...patch } : item)));
  };

  const addItem = () => {
    if (!isEditable) return;
    setItems((current) => {
      if (current.length >= MAX_EXPENSE_ROWS) return current;
      return [
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
      ];
    });
  };

  // 页签只示意单据类型：类型在创建时确定（差旅费报销 / 一般报销），
  // 另一个页签禁用，编辑与审核都不能改到另一种类型。
  const kindTabs = [
    { id: "travel", label: t("reimburse.form.kindTravel"), disabled: kind !== "travel" },
    { id: "general", label: t("reimburse.form.kindGeneral"), disabled: kind !== "general" },
  ];

  // 表单提交：审核态提交审批，编辑态保存单据，只读态什么也不做（按钮此时不渲染）。
  const submitFromShell = () => {
    if (isAuditMode) {
      if (auditAmountValue != null) onAuditSubmit?.();
      return;
    }
    if (isEditable) saveAll();
  };

  // 窗口外壳：与新建窗同一个 `EntryModalShell` —— 标题栏、页签、卡片、按钮行、层级、高度全由它统一，
  // 这里只提供内容（纸面表单 + 审核区 + 原始记录）与本窗的主操作。
  return (
    <EntryModalShell
      open
      heightKey="reimburse-document"
      width="3xl"
      heightMode="natural"
      panelStyle={REIMBURSE_PANEL_STYLE}
      title={
        <>
          {t(isAuditMode ? "reimburse.document.audit" : "reimburse.editor.title")}
          {savedMessage ? <span className="ml-2 text-xs font-normal text-emerald-600">{savedMessage}</span> : null}
        </>
      }
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        submitFromShell();
      }}
      tabs={kindTabs}
      activeTabId={kind === "travel" ? "travel" : "general"}
      onTabChange={() => {}}
      footer={
        isAuditMode ? (
          <>
            {canCancelApproval ? (
              <button
                type="button"
                onClick={onCancelApproval}
                className="secondary-button h-9 px-3"
                disabled={auditBusy}
              >
                {t("reimburse.document.cancelApproval")}
              </button>
            ) : null}
            <button
              type="submit"
              className="primary-button h-9 px-3"
              disabled={auditBusy || auditAmountValue == null}
            >
              {auditBusy ? t("liabilityShell.saving") : t("common.save")}
            </button>
          </>
        ) : isEditable ? (
          <button
            type="submit"
            className="primary-button h-9 px-3"
            disabled={savingHeader || savingItems}
          >
            {savingHeader ? t("liabilityShell.saving") : t("common.save")}
          </button>
        ) : undefined
      }
    >
        {/* 纸面表单：抬头 / 明细表 / 合计行与新建弹窗共用 `ReimbursementDocumentForm`。 */}
        <ReimbursementDocumentForm
          kind={kind}
          header={header}
          onHeaderChange={patchDraftHeader}
          rows={draftRows}
          onRowChange={patchDraftRow}
          readOnly={!isEditable}
          busy={savingItems}
          batches={batches}
          settledDate={reimbursement.reimbursedDate ?? null}
          /* 详情 / 审核窗不显示备注格（备注只在新建时填写）。 */
          hideNote
          /* 不再显示「归属对象」格：对象已落在报销批次上，抬头由「归属批次」表达。 */
          onAddRow={addItem}
          onRemoveRow={(key) => void deleteItem(key)}
          titleBlock={
            /* 只留单据编号：归属对象已在抬头格里，这里再写一次是同一个名字重复两遍。 */
            <header className="border-b-2 border-slate-700 pb-4 text-center">
              <div className="text-lg font-semibold tracking-wide text-slate-800">
                {header.documentNumber || t("reimburse.form.titleFallback")}
              </div>
            </header>
          }
        />

        {isAuditMode ? (
          <section className="mt-3 text-xs">
            {/* 审核只开放这一块：可编辑格靠底色与控件本身表达，不写规则说明。 */}
            <div className="grid grid-cols-1 border-l border-t border-slate-300 sm:grid-cols-12">
              {/* 审批日期：可编辑 */}
              <label className={`${HEADER_CELL} bg-amber-100/70 sm:col-span-4`}>
                <span className="flex w-[4.5rem] shrink-0 items-center whitespace-nowrap border-r border-slate-300 px-2 text-[11px] font-medium text-amber-700">{t("reimburse.document.approvalDate")}</span>
                <span className={HEADER_EDIT}>
                  <DateStepper
                    value={auditDate ?? ""}
                    onChange={(value) => onAuditDateChange?.(value)}
                    className={HEADER_DATE}
                    compact
                  />
                </span>
              </label>
              {/* 到账日期已在抬头展示，这里不再重复。 */}
              {/* 审批金额：可编辑 */}
              <label className={`${HEADER_CELL} bg-amber-100/70 sm:col-span-2`}>
                <span className="flex w-[4.5rem] shrink-0 items-center whitespace-nowrap border-r border-slate-300 px-2 text-[11px] font-medium text-amber-700">{t("reimburse.document.approvedAmount")}</span>
                <span className={HEADER_EDIT}>
                  <CalcInput
                    bare
                    value={auditAmount ?? ""}
                    onChange={(value) => onAuditAmountChange?.(value)}
                    precision={2}
                    hideCalculator
                    inputClassName={`${HEADER_FIELD} text-right tabular-nums font-sans`}
                    className="h-full min-w-0 flex-1"
                  />
                </span>
              </label>
              {/* 审批备注：可编辑（占满右侧，保存按钮在窗口右下角，不占格） */}
              <label className={`${HEADER_CELL} bg-amber-100/70 sm:col-span-6`}>
                <span className="flex w-[4.5rem] shrink-0 items-center whitespace-nowrap border-r border-slate-300 px-2 text-[11px] font-medium text-amber-700">{t("reimburse.document.approvalNote")}</span>
                <span className={HEADER_EDIT}>
                  <input
                    type="text"
                    value={auditNote ?? ""}
                    onChange={(event) => onAuditNoteChange?.(event.target.value)}
                    className={HEADER_FIELD}
                  />
                </span>
              </label>
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
          <div className="mt-3 border border-slate-300 bg-slate-50 px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-slate-600">{t("reimburse.editor.sourceInfo")}</div>
              {isEditable && (
                <button
                  type="button"
                  onClick={() => { setSelectedTransactionIds([]); setShowLinkDialog(true); }}
                  className="inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:border-slate-400 hover:text-slate-800"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {t("reimburse.source.add")}
                </button>
              )}
            </div>
            {linkedTransactions.length > 0 ? (
              <div className={`overflow-auto border border-slate-300 bg-white ${SOURCE_SCROLL_MAX_H}`}>
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-slate-100 text-slate-600">
                    <tr>
                      <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-left font-medium">{t("reimburse.source.date")}</th>
                      <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-left font-medium">{t("reimburse.source.category")}</th>
                      <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-right font-medium">{t("reimburse.source.amount")}</th>
                      <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-left font-medium">{t("reimburse.source.note")}</th>
                      {isEditable ? <th className="sticky top-0 z-10 w-16 border-b border-slate-200 bg-slate-100" /> : null}
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
                            <button type="button" onClick={() => void clearTransaction(item.txRecordId)} disabled={linkingTransaction} className="inline-flex h-6 items-center justify-center rounded-none border border-slate-300 bg-white px-1.5 text-slate-600 hover:border-amber-400 hover:text-amber-700 disabled:opacity-50" title={t("reimburse.source.clear")}>
                              <Eraser className="h-3 w-3" />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-semibold text-slate-700">
                      <td className="sticky bottom-0 z-10 border-r border-slate-200 bg-slate-50 px-2 py-1.5" colSpan={2}>{t("reimburse.source.summary", { count: linkedTransactions.length })}</td>
                      <td className="sticky bottom-0 z-10 border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-right tabular-nums">{formatMoneyYuan(linkedTransactionTotal)}</td>
                      <td className="sticky bottom-0 z-10 border-slate-200 bg-slate-50 px-2 py-1.5" colSpan={isEditable ? 2 : 1} />
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-400">{t("reimburse.source.noLinkedTransactions")}</div>
            )}
          </div>
      {showLinkDialog ? (
        <ModalLayer className="app-modal-backdrop">
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
                  <div className="overflow-x-auto border border-slate-300">
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
                          <td className="border-b border-slate-100 px-1 py-1"><button type="button" className="inline-flex h-6 shrink-0 items-center border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:border-amber-400 hover:text-amber-700 disabled:opacity-40" disabled={linkingTransaction} onClick={() => void clearTransaction(item.txRecordId)}>{t("reimburse.source.clear")}</button></td>
                        </tr>
                      ))}<tr className="bg-slate-50 font-semibold"><td className="px-2 py-1.5" colSpan={2}>{t("reimburse.source.summary", { count: linkedTransactions.length })}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatMoneyYuan(linkedTransactionTotal)}</td><td colSpan={2} /></tr></tbody>
                    </table>
                  </div>
                ) : <div className="border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-400">{t("reimburse.source.noLinkedTransactions")}</div>}
              </section>
              <section>
                <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.source.selectTransaction")}</div>
                {/* 默认 3 行，勾选候选后再放开到 5 行——刚打开时不撑高对话框。 */}
                {availableCandidates.length > 0 ? (
                  <div
                    className={`overflow-y-auto border border-slate-300 transition-[max-height] duration-200 ease-out ${
                      selectedTransactionIds.length > 0 ? "max-h-[9.125rem]" : "max-h-[5.5rem]"
                    }`}
                  >
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
                <div className="border border-dashed border-slate-300 px-3 py-5 text-center text-xs text-slate-400">
                  {t("reimburse.source.noCandidates")}
                </div>
                )}
              </section>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 p-3">
              <button
                type="button"
                onClick={() => { if (selectedTransactionIds.length > 0) void linkTransactions(selectedTransactionIds); }}
                className="inline-flex h-9 items-center bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={linkingTransaction || selectedTransactionIds.length === 0}
              >
                {linkingTransaction ? t("liabilityShell.saving") : t("reimburse.source.link")}
              </button>
            </div>
          </div>
        </ModalLayer>
      ) : null}
    </EntryModalShell>
  );
}
