"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus, ReceiptText, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatMoney, formatMoneyYuan } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { DateStepper } from "./DateStepper";
import { reimbursementErrorMessage } from "@/lib/reimbursement-error";
import { ReimbursementFormModal, type ReimbursementFormEntry } from "@/components/ReimbursementFormModal";
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

/** Trip leg of a travel item, for example Beijing to Shanghai by train. */
function tripLegLabel(item: ReimbursementData["items"][number]) {
  const leg = item.fromPlace || item.toPlace ? `${item.fromPlace ?? "-"} → ${item.toPlace ?? "-"}` : "";
  if (!item.vehicle) return leg || "-";
  return leg ? `${leg}（${item.vehicle}）` : item.vehicle;
}

export function ReimbursementModal({
  objectId,
  objectType,
  objectName,
  cashAccountOptions,
  actions,
  onClose,
  initialShowCreate = false,
  initialCreateEntries,
}: {
  objectId: string;
  objectType: "counterparty" | "institution";
  objectName: string;
  cashAccountOptions: ReimbursementCashAccountOption[];
  actions: ReimbursementActions;
  onClose: () => void;
  /** Detail-selection entry point: pop the create-form modal on mount, seeded with the picked rows. */
  initialShowCreate?: boolean;
  initialCreateEntries?: ReimbursementFormEntry[];
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ReimbursementOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(initialShowCreate);
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
  // A travel form carries a trip-leg column, so it needs the wider panel.
  const hasTravel = (data?.reimbursements ?? []).some((reimbursement) => reimbursement.kind === "travel");

  // The detail-selection entry seeds the form with picked rows; once the user closes
  // that form (or saves it), fall back to the full candidate list.
  const [seedsConsumed, setSeedsConsumed] = useState(!initialShowCreate);
  const createSeedEntries = seedsConsumed ? [] : (initialCreateEntries ?? []);
  // Candidates from the overview; used by the plain create-reimbursement button.
  const candidateEntries = useMemo<ReimbursementFormEntry[]>(
    () =>
      (data?.candidates ?? []).map((candidate) => ({
        id: candidate.id,
        date: candidate.date,
        amount: candidate.amount,
        categoryName: candidate.categoryName,
        note: candidate.note,
        advanceAccountId: candidate.advanceAccountId,
      })),
    [data],
  );

  const openCreate = () => {
    setShowCreate(true);
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
        window.alert(reimbursementErrorMessage(res.error, t));
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
        window.alert(reimbursementErrorMessage(res.error, t));
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
        window.alert(reimbursementErrorMessage(res.error, t));
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
            <th className="py-1 pr-2 font-medium">
              {reimbursement.kind === "travel" ? t("reimburse.form.colExpenseItem") : t("reimburse.colCategory")}
            </th>
            {reimbursement.kind === "travel" ? (
              <th className="py-1 pr-2 font-medium">
                {t("reimburse.form.colTripFrom")} → {t("reimburse.form.colTripTo")}
              </th>
            ) : null}
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
                <td
                  className="max-w-[9rem] truncate py-1.5 pr-2 text-slate-600"
                  title={item.categoryName ?? undefined}
                >
                  {reimbursement.kind === "travel"
                    ? item.expenseItem
                      ? t(`reimburse.expenseItem.${item.expenseItem}`)
                      : "-"
                    : item.categoryName ?? "-"}
                </td>
                {reimbursement.kind === "travel" ? (
                  <td
                    className="max-w-[14rem] truncate py-1.5 pr-2 text-slate-600"
                    title={tripLegLabel(item)}
                  >
                    {tripLegLabel(item)}
                  </td>
                ) : null}
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
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-4 ${reimbursement.kind === "travel" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
              {reimbursement.kind === "travel" ? t("reimburse.form.kindTravel") : t("reimburse.form.kindAdvance")}
            </span>
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
          <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2">
            {reimbursement.kind === "travel" &&
            (reimbursement.travelStartDate || reimbursement.travelEndDate || reimbursement.travelReason) ? (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                {reimbursement.travelStartDate || reimbursement.travelEndDate ? (
                  <span>
                    {t("reimburse.form.travelStart")} {reimbursement.travelStartDate ?? "-"} ~{" "}
                    {reimbursement.travelEndDate ?? "-"}
                  </span>
                ) : null}
                {reimbursement.travelReason ? (
                  <span>
                    {t("reimburse.form.travelReason")}: {reimbursement.travelReason}
                  </span>
                ) : null}
              </div>
            ) : null}
            {reimbursement.attachmentCount ? (
              <div className="mb-2 text-xs text-slate-500">
                {t("reimburse.attachments", { count: reimbursement.attachmentCount })}
              </div>
            ) : null}
            {renderItemsTable(reimbursement)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="app-modal-backdrop z-50">
      <div className={`app-modal-panel ${hasTravel ? "max-w-4xl" : "max-w-3xl"}`}>
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
                <button type="button" onClick={openCreate} className="primary-button h-9 px-3" disabled={busy || candidateEntries.length === 0}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t("reimburse.create")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {showCreate ? (
        <ReimbursementFormModal
          objectId={objectId}
          objectName={objectName}
          objectType={objectType}
          entries={createSeedEntries}
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
