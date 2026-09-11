"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus, ReceiptText, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { formatMoney, formatMoneyYuan } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { DateStepper } from "./DateStepper";
import type {
  ReimbursementActionResult,
  ReimbursementData,
  ReimbursementOverviewData,
} from "@/lib/server/sidebar-actions/reimbursement-actions";

export type ReimbursementCashAccountOption = { id: string; label: string };

export type ReimbursementActions = {
  getData: (objectId: string, objectType: "counterparty" | "institution") => Promise<ReimbursementOverviewData>;
  create: (formData: FormData) => Promise<ReimbursementActionResult>;
  reimburse: (formData: FormData) => Promise<ReimbursementActionResult>;
  delete: (formData: FormData) => Promise<ReimbursementActionResult>;
  updateInvoice: (formData: FormData) => Promise<ReimbursementActionResult>;
};

type InvoiceDraft = { code: string; number: string; amount: string };

const ERROR_KEY_BY_CODE: Record<string, string> = {
  REIMBURSEMENT_TITLE_REQUIRED: "reimburse.alert.titleRequired",
  REIMBURSEMENT_OBJECT_REQUIRED: "reimburse.alert.objectRequired",
  REIMBURSEMENT_ITEMS_REQUIRED: "reimburse.alert.itemsRequired",
  REIMBURSEMENT_ITEM_INVALID: "reimburse.alert.itemInvalid",
  REIMBURSEMENT_NOT_FOUND: "reimburse.alert.notFound",
  REIMBURSEMENT_ALREADY_REIMBURSED: "reimburse.alert.alreadyReimbursed",
  REIMBURSEMENT_CASH_ACCOUNT_REQUIRED: "reimburse.alert.cashAccountRequired",
  REIMBURSEMENT_CASH_ACCOUNT_INVALID: "reimburse.alert.cashAccountInvalid",
  REIMBURSEMENT_DATE_INVALID: "reimburse.alert.dateInvalid",
  REIMBURSEMENT_ADVANCE_ACCOUNT_MISSING: "reimburse.alert.advanceAccountMissing",
  REIMBURSEMENT_BALANCE_INSUFFICIENT: "reimburse.alert.balanceInsufficient",
  REIMBURSEMENT_ITEM_NOT_FOUND: "reimburse.alert.itemNotFound",
  REIMBURSEMENT_INVOICE_AMOUNT_INVALID: "reimburse.alert.invoiceAmountInvalid",
  REIMBURSEMENT_NOT_PENDING: "reimburse.alert.notPending",
  REIMBURSEMENT_UNKNOWN: "reimburse.alert.unknown",
  REIMBURSEMENT_CREATE_FAILED: "reimburse.alert.createFailed",
  REIMBURSEMENT_REIMBURSE_FAILED: "reimburse.alert.reimburseFailed",
  REIMBURSEMENT_DELETE_FAILED: "reimburse.alert.deleteFailed",
};

function errorMessage(code: string, t: (key: string) => string) {
  const key = ERROR_KEY_BY_CODE[code];
  return key ? t(key) : code;
}

export function ReimbursementModal({
  objectId,
  objectType,
  objectName,
  cashAccountOptions,
  actions,
  onClose,
}: {
  objectId: string;
  objectType: "counterparty" | "institution";
  objectName: string;
  cashAccountOptions: ReimbursementCashAccountOption[];
  actions: ReimbursementActions;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ReimbursementOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createNote, setCreateNote] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reimburseTarget, setReimburseTarget] = useState<ReimbursementData | null>(null);
  const [reimburseDate, setReimburseDate] = useState(todayDateLocalYmd());
  const [reimburseCashAccountId, setReimburseCashAccountId] = useState(cashAccountOptions[0]?.id ?? "");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [invoiceDrafts, setInvoiceDrafts] = useState<Record<string, InvoiceDraft>>({});
  const [savingInvoiceId, setSavingInvoiceId] = useState<string | null>(null);
  const [savedInvoiceId, setSavedInvoiceId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const next = await actions.getData(objectId, objectType);
      setData(next);
      if (expandedId) {
        const expanded = next.reimbursements.find((reimbursement) => reimbursement.id === expandedId);
        if (expanded) {
          const drafts: Record<string, InvoiceDraft> = {};
          for (const item of expanded.items) {
            drafts[item.id] = {
              code: item.invoiceCode ?? "",
              number: item.invoiceNumber ?? "",
              amount: item.invoiceAmount == null ? "" : String(item.invoiceAmount),
            };
          }
          setInvoiceDrafts(drafts);
        }
      }
    } catch {
      window.alert(t("reimburse.alert.unknown"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, objectType]);

  const pendingList = useMemo(
    () => (data?.reimbursements ?? []).filter((reimbursement) => reimbursement.status === "pending"),
    [data],
  );
  const reimbursedList = useMemo(
    () => (data?.reimbursements ?? []).filter((reimbursement) => reimbursement.status === "reimbursed"),
    [data],
  );
  const pendingTotal = pendingList.reduce((sum, reimbursement) => sum + reimbursement.totalAmount, 0);
  const reimbursedTotal = reimbursedList.reduce((sum, reimbursement) => sum + reimbursement.totalAmount, 0);

  const openCreate = () => {
    setCreateTitle(t("reimburse.titleDefault", { name: objectName }));
    setCreateNote("");
    setSelectedIds(new Set((data?.candidates ?? []).map((candidate) => candidate.id)));
    setShowCreate(true);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedTotal = useMemo(() => {
    return (data?.candidates ?? [])
      .filter((candidate) => selectedIds.has(candidate.id))
      .reduce((sum, candidate) => sum + candidate.amount, 0);
  }, [data, selectedIds]);

  const submitCreate = async () => {
    if (busy) return;
    const formData = new FormData();
    formData.set("title", createTitle);
    formData.set("note", createNote);
    formData.set("counterpartyId", objectId);
    formData.set("counterpartyName", objectName);
    formData.set("objectType", objectType);
    formData.set("itemIds", Array.from(selectedIds).join(","));
    setBusy(true);
    try {
      const res = await actions.create(formData);
      if (!res.ok) {
        window.alert(errorMessage(res.error, t));
        return;
      }
      setShowCreate(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openReimburse = (reimbursement: ReimbursementData) => {
    setReimburseTarget(reimbursement);
    setReimburseDate(todayDateLocalYmd());
    setReimburseCashAccountId(cashAccountOptions[0]?.id ?? "");
  };

  const submitReimburse = async () => {
    if (!reimburseTarget || busy) return;
    const formData = new FormData();
    formData.set("reimbursementId", reimburseTarget.id);
    formData.set("cashAccountId", reimburseCashAccountId);
    formData.set("date", reimburseDate);
    setBusy(true);
    try {
      const res = await actions.reimburse(formData);
      if (!res.ok) {
        window.alert(errorMessage(res.error, t));
        return;
      }
      setReimburseTarget(null);
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
        window.alert(errorMessage(res.error, t));
        return;
      }
      if (expandedId === reimbursement.id) setExpandedId(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleExpand = (reimbursement: ReimbursementData) => {
    if (expandedId === reimbursement.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(reimbursement.id);
    const drafts: Record<string, InvoiceDraft> = {};
    for (const item of reimbursement.items) {
      drafts[item.id] = {
        code: item.invoiceCode ?? "",
        number: item.invoiceNumber ?? "",
        amount: item.invoiceAmount == null ? "" : String(item.invoiceAmount),
      };
    }
    setInvoiceDrafts(drafts);
  };

  const setDraft = (itemId: string, field: keyof InvoiceDraft, value: string) => {
    setInvoiceDrafts((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? { code: "", number: "", amount: "" }), [field]: value },
    }));
  };

  const submitInvoice = async (itemId: string) => {
    const draft = invoiceDrafts[itemId];
    if (!draft || busy) return;
    const formData = new FormData();
    formData.set("itemId", itemId);
    formData.set("invoiceCode", draft.code);
    formData.set("invoiceNumber", draft.number);
    formData.set("invoiceAmount", draft.amount);
    setSavingInvoiceId(itemId);
    try {
      const res = await actions.updateInvoice(formData);
      if (!res.ok) {
        window.alert(errorMessage(res.error, t));
        return;
      }
      setSavedInvoiceId(itemId);
      window.setTimeout(() => {
        setSavedInvoiceId((current) => (current === itemId ? null : current));
      }, 1500);
      await load();
    } finally {
      setSavingInvoiceId(null);
    }
  };

  const renderItemsTable = (reimbursement: ReimbursementData) => {
    const editable = reimbursement.status === "pending";
    return (
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-1 pr-2 font-medium">{t("reimburse.colDate")}</th>
            <th className="py-1 pr-2 font-medium">{t("reimburse.colCategory")}</th>
            <th className="py-1 pr-2 text-right font-medium">{t("reimburse.colAmount")}</th>
            <th className="py-1 pr-2 font-medium">{t("reimburse.colInvoiceCode")}</th>
            <th className="py-1 pr-2 font-medium">{t("reimburse.colInvoiceNumber")}</th>
            <th className="py-1 pr-2 font-medium">{t("reimburse.colInvoiceAmount")}</th>
            {editable ? <th className="py-1 font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {reimbursement.items.map((item) => {
            const draft = invoiceDrafts[item.id];
            return (
              <tr key={item.id} className="border-b border-slate-100 align-top">
                <td className="whitespace-nowrap py-1.5 pr-2 text-slate-600">{item.entryDate}</td>
                <td className="max-w-[9rem] truncate py-1.5 pr-2 text-slate-600" title={item.categoryName ?? undefined}>
                  {item.categoryName ?? "-"}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums text-slate-800">
                  {formatMoneyYuan(item.amount)}
                </td>
                {editable ? (
                  <>
                    <td className="py-1.5 pr-1">
                      <input
                        type="text"
                        value={draft?.code ?? ""}
                        onChange={(event) => setDraft(item.id, "code", event.target.value)}
                        placeholder="-"
                        className="form-input h-7 w-[7rem] px-1.5 text-xs"
                      />
                    </td>
                    <td className="py-1.5 pr-1">
                      <input
                        type="text"
                        value={draft?.number ?? ""}
                        onChange={(event) => setDraft(item.id, "number", event.target.value)}
                        placeholder="-"
                        className="form-input h-7 w-[7rem] px-1.5 text-xs"
                      />
                    </td>
                    <td className="py-1.5 pr-1">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={draft?.amount ?? ""}
                        onChange={(event) => setDraft(item.id, "amount", event.target.value)}
                        placeholder="-"
                        className="form-input h-7 w-[6rem] px-1.5 text-right text-xs"
                      />
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-right">
                      {savedInvoiceId === item.id ? (
                        <Check className="ml-auto h-4 w-4 text-emerald-500" />
                      ) : (
                        <button
                          type="button"
                          onClick={() => { void submitInvoice(item.id); }}
                          disabled={savingInvoiceId === item.id || busy}
                          className="secondary-button h-7 px-2 text-xs"
                        >
                          {savingInvoiceId === item.id ? "…" : t("reimburse.saveInvoice")}
                        </button>
                      )}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-slate-600">{item.invoiceCode ?? "-"}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-slate-600">{item.invoiceNumber ?? "-"}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums text-slate-600">
                      {item.invoiceAmount == null ? "-" : formatMoneyYuan(item.invoiceAmount)}
                    </td>
                    <td />
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  const renderReimbursementCard = (reimbursement: ReimbursementData) => {
    const expanded = expandedId === reimbursement.id;
    const pending = reimbursement.status === "pending";
    return (
      <div key={reimbursement.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => toggleExpand(reimbursement)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={t("reimburse.expandItems")}
          >
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
            <span className="truncate text-sm font-medium text-slate-800">{reimbursement.title}</span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-4 ${pending ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
              {pending ? t("reimburse.statusPending") : t("reimburse.statusReimbursed")}
            </span>
            <span className="shrink-0 text-xs text-slate-500">
              {t("reimburse.itemCount", { count: reimbursement.items.length })}
            </span>
          </button>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">
            {formatMoneyYuan(reimbursement.totalAmount)}
          </span>
          {pending ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => openReimburse(reimbursement)}
                disabled={busy}
                className="primary-button h-8 px-2.5 text-xs"
              >
                {t("reimburse.reimburseAction")}
              </button>
              <button
                type="button"
                onClick={() => { void submitDelete(reimbursement); }}
                disabled={busy}
                className="secondary-button h-8 w-8 justify-center px-0"
                title={t("common.delete")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <span className="shrink-0 text-xs text-slate-500">
              {t("reimburse.reimbursedTo", {
                date: reimbursement.reimbursedDate ?? "-",
                account: reimbursement.cashAccountName ?? "-",
              })}
            </span>
          )}
        </div>
        {expanded ? (
          <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2">{renderItemsTable(reimbursement)}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="app-modal-backdrop z-50">
      <div className="app-modal-panel max-w-3xl">
        <div className="modal-header shrink-0">
          <div>
            <div className="text-sm font-semibold text-slate-800">{t("reimburse.modalTitle")}</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
              <ReceiptText className="h-3.5 w-3.5" />
              {objectName}
            </div>
          </div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2" disabled={busy}>
            {t("table.close")}
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {loading ? (
            <div className="py-10 text-center text-sm text-slate-400">{t("debtShell.saving")}</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <div className="text-xs text-slate-500">{t("reimburse.pendingSection")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">
                    {t("reimburse.summaryPending", { count: pendingList.length, amount: formatMoney(pendingTotal) })}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <div className="text-xs text-slate-500">{t("reimburse.reimbursedSection")}</div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">
                    {t("reimburse.summaryReimbursed", { count: reimbursedList.length, amount: formatMoney(reimbursedTotal) })}
                  </div>
                </div>
              </div>

              {pendingList.length > 0 ? (
                <div className="space-y-2">{pendingList.map(renderReimbursementCard)}</div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
                  {t("reimburse.noReimbursements")}
                </div>
              )}

              {reimbursedList.length > 0 ? (
                <>
                  <div className="text-xs font-medium text-slate-500">{t("reimburse.reimbursedSection")}</div>
                  <div className="space-y-2">{reimbursedList.map(renderReimbursementCard)}</div>
                </>
              ) : null}

              <div className="flex justify-end border-t border-slate-100 pt-3">
                <button type="button" onClick={openCreate} className="primary-button h-9 px-3" disabled={busy || (data?.candidates.length ?? 0) === 0}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t("reimburse.create")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {showCreate ? (
        <div className="app-modal-backdrop z-[70]">
          <div className="app-modal-panel max-w-2xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{t("reimburse.create")}</div>
              <button type="button" onClick={() => setShowCreate(false)} className="secondary-button h-8 px-2" disabled={busy}>
                {t("table.close")}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.titleLabel")}</label>
                <input
                  type="text"
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  placeholder={t("reimburse.titlePlaceholder")}
                  className="form-input h-9 w-full"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.noteLabel")}</label>
                <ClearableNoteField
                  value={createNote}
                  onValueChange={setCreateNote}
                  className="form-input h-9 w-full"
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-600">{t("reimburse.selectItems")}</label>
                  <span className="text-xs text-slate-500">{t("reimburse.selectedCount", { count: selectedIds.size })}</span>
                </div>
                {data && data.candidates.length > 0 ? (
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {data.candidates.map((candidate) => (
                      <label
                        key={candidate.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(candidate.id)}
                          onChange={() => toggleSelect(candidate.id)}
                          className="h-3.5 w-3.5"
                        />
                        <span className="w-[6.5rem] shrink-0 text-xs text-slate-600">{candidate.date}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-600" title={candidate.categoryName ?? undefined}>
                          {candidate.categoryName ?? "-"}
                        </span>
                        <span className="shrink-0 text-xs font-medium tabular-nums text-slate-800">
                          {formatMoneyYuan(candidate.amount)}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">
                    {t("reimburse.noCandidates")}
                  </div>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-100 p-3">
              <div className="text-sm text-slate-600">
                <span className="text-xs text-slate-500">{t("reimburse.totalLabel")}: </span>
                <span className="font-semibold tabular-nums text-slate-800">{formatMoneyYuan(selectedTotal)}</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setShowCreate(false)} className="secondary-button h-9 px-3" disabled={busy}>
                  {t("common.cancel")}
                </button>
                <button type="button" onClick={() => { void submitCreate(); }} className="primary-button h-9 px-3" disabled={busy || selectedIds.size === 0}>
                  {busy ? t("debtShell.saving") : t("reimburse.createConfirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {reimburseTarget ? (
        <div className="app-modal-backdrop z-[80]">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("reimburse.reimburseAction")}</div>
                <div className="mt-0.5 text-xs text-slate-500">{reimburseTarget.title}</div>
              </div>
              <button type="button" onClick={() => setReimburseTarget(null)} className="secondary-button h-8 px-2" disabled={busy}>
                {t("table.close")}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-xs text-slate-500">{t("reimburse.totalLabel")}</span>
                <span className="text-sm font-semibold tabular-nums text-slate-800">{formatMoneyYuan(reimburseTarget.totalAmount)}</span>
              </div>
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
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 p-3">
              <button type="button" onClick={() => setReimburseTarget(null)} className="secondary-button h-9 px-3" disabled={busy}>
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => { void submitReimburse(); }} className="primary-button h-9 px-3" disabled={busy || !reimburseCashAccountId}>
                {busy ? t("debtShell.saving") : t("reimburse.reimburseConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
