"use client";

import { useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { formatMoneyYuan } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { reimbursementErrorMessage } from "@/lib/reimbursement-error";
import { DateStepper } from "./DateStepper";
import type {
  ReimbursementActionResult,
  ReimbursementExpenseItemValue,
  ReimbursementKindValue,
} from "@/lib/server/sidebar-actions/reimbursement-actions";

/** A transaction carried over from the detail list selection. */
export type ReimbursementFormEntry = {
  id: string;
  date: string;
  amount: number;
  categoryName: string | null;
  note: string | null;
  advanceAccountId: string | null;
};

export type ReimbursementObjectOption = {
  id: string;
  name: string;
  /** Advance (receivable) account ids belonging to this object; lets the detail-entry button resolve which object a picked row belongs to. */
  advanceAccountIds?: string[];
};

export type ReimbursementFormActions = {
  create: (formData: FormData) => Promise<ReimbursementActionResult>;
};

type DraftRow = {
  key: string;
  txRecordId: string | null;
  advanceAccountId: string | null;
  expenseItem: ReimbursementExpenseItemValue | null;
  fromPlace: string;
  toPlace: string;
  vehicle: string;
  amount: string;
  entryDate: string;
  categoryName: string | null;
  note: string | null;
};

/** Travel items mirror a paper travel expense form: main categories first, then
 * the miscellaneous items that used to collapse into the generic "other" bucket. */
const TRAVEL_EXPENSE_ITEMS: ReimbursementExpenseItemValue[] = [
  "transport",
  "lodging",
  "meal",
  "cityTransport",
  "subsidy",
  "conference",
  "ticketing",
  "refundFee",
  "insurance",
  "parking",
  "toll",
  "phone",
  "other",
];

function parseAmount(value: string) {
  const parsed = parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ReimbursementFormModal({
  objectId,
  objectName,
  objectType = "counterparty",
  objectOptions = [],
  entries = [],
  defaultKind = "travel",
  actions,
  onClose,
  onCreated,
}: {
  objectId?: string;
  objectName?: string;
  objectType?: "counterparty" | "institution";
  objectOptions?: ReimbursementObjectOption[];
  entries?: ReimbursementFormEntry[];
  defaultKind?: ReimbursementKindValue;
  actions: ReimbursementFormActions;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { t } = useI18n();
  const seqRef = useRef(0);
  const makeKey = () => {
    seqRef.current += 1;
    return `reimb-row-${seqRef.current}`;
  };

  const [kind, setKind] = useState<ReimbursementKindValue>(defaultKind);
  const [pickedObjectId, setPickedObjectId] = useState(objectId ?? objectOptions[0]?.id ?? "");
  const [title, setTitle] = useState(() =>
    objectName ? t("reimburse.titleDefault", { name: objectName }) : t("reimburse.form.titleFallback"),
  );
  const [note, setNote] = useState("");
  const [travelStartDate, setTravelStartDate] = useState(todayDateLocalYmd());
  const [travelEndDate, setTravelEndDate] = useState(todayDateLocalYmd());
  const [travelReason, setTravelReason] = useState("");
  const [attachmentCount, setAttachmentCount] = useState("");
  const [rows, setRows] = useState<DraftRow[]>(() =>
    entries.map((entry) => ({
      key: makeKey(),
      txRecordId: entry.id,
      advanceAccountId: entry.advanceAccountId,
      expenseItem: null,
      fromPlace: "",
      toPlace: "",
      vehicle: "",
      amount: String(entry.amount),
      entryDate: entry.date,
      categoryName: entry.categoryName,
      note: entry.note,
    })),
  );
  const [busy, setBusy] = useState(false);

  const isTravel = kind === "travel";
  const resolvedObjectId = objectId ?? pickedObjectId;
  const resolvedObjectName =
    objectName ?? objectOptions.find((option) => option.id === resolvedObjectId)?.name ?? "";

  const total = useMemo(
    () => rows.reduce((sum, row) => sum + Math.abs(parseAmount(row.amount)), 0),
    [rows],
  );

  const patchRow = (key: string, patch: Partial<DraftRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows((current) => [
      ...current,
      {
        key: makeKey(),
        txRecordId: null,
        advanceAccountId: null,
        expenseItem: isTravel ? "subsidy" : null,
        fromPlace: "",
        toPlace: "",
        vehicle: "",
        amount: "",
        entryDate: isTravel ? travelEndDate : todayDateLocalYmd(),
        categoryName: null,
        note: null,
      },
    ]);
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const submit = async () => {
    if (busy) return;
    if (!resolvedObjectId) {
      window.alert(t("reimburse.alert.objectRequired"));
      return;
    }
    const payload = rows
      .map((row) => ({
        txRecordId: row.txRecordId,
        advanceAccountId: row.advanceAccountId,
        expenseItem: isTravel ? row.expenseItem : null,
        fromPlace: isTravel ? row.fromPlace : null,
        toPlace: isTravel ? row.toPlace : null,
        vehicle: isTravel ? row.vehicle : null,
        amount: Math.abs(parseAmount(row.amount)),
        entryDate: row.entryDate,
        categoryName: row.categoryName,
        note: row.note,
      }))
      .filter((row) => row.amount > 0);
    if (payload.length === 0) {
      window.alert(t("reimburse.alert.itemsRequired"));
      return;
    }
    const formData = new FormData();
    formData.set("title", title);
    formData.set("note", note);
    formData.set("kind", kind);
    formData.set("counterpartyId", resolvedObjectId);
    formData.set("counterpartyName", resolvedObjectName);
    formData.set("objectType", objectType);
    formData.set("travelStartDate", isTravel ? travelStartDate : "");
    formData.set("travelEndDate", isTravel ? travelEndDate : "");
    formData.set("travelReason", isTravel ? travelReason : "");
    formData.set("attachmentCount", attachmentCount);
    formData.set("items", JSON.stringify(payload));
    setBusy(true);
    try {
      const res = await actions.create(formData);
      if (!res.ok) {
        window.alert(reimbursementErrorMessage(res.error, t));
        return;
      }
      onCreated?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-modal-backdrop z-[70]">
      <div className={`app-modal-panel ${isTravel ? "max-w-4xl" : "max-w-2xl"}`}>
        <div className="modal-header shrink-0">
          <div>
            <div className="text-sm font-semibold text-slate-800">{t("reimburse.create")}</div>
            {resolvedObjectName ? (
              <div className="mt-0.5 text-xs text-slate-500">{resolvedObjectName}</div>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2" disabled={busy}>
            {t("table.close")}
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.form.kindLabel")}</div>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-200">
              {(["travel", "advance"] as ReimbursementKindValue[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  className={`px-3 py-1.5 text-xs font-medium transition ${
                    kind === option ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {option === "travel" ? t("reimburse.form.kindTravel") : t("reimburse.form.kindAdvance")}
                </button>
              ))}
            </div>
          </div>

          {objectId ? null : (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.form.objectLabel")}</label>
              <select
                value={pickedObjectId}
                onChange={(event) => setPickedObjectId(event.target.value)}
                className="form-input h-9 w-full"
              >
                <option value="">{t("reimburse.form.objectPlaceholder")}</option>
                {objectOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.titleLabel")}</label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("reimburse.titlePlaceholder")}
              className="form-input h-9 w-full"
            />
          </div>

          {isTravel ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.form.travelStart")}</label>
                <DateStepper value={travelStartDate} onChange={setTravelStartDate} className="h-9 w-full" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.form.travelEnd")}</label>
                <DateStepper value={travelEndDate} onChange={setTravelEndDate} className="h-9 w-full" />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.form.travelReason")}</label>
                <input
                  type="text"
                  value={travelReason}
                  onChange={(event) => setTravelReason(event.target.value)}
                  placeholder={t("reimburse.form.travelReasonPlaceholder")}
                  className="form-input h-9 w-full"
                />
              </div>
            </div>
          ) : null}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-600">{t("reimburse.form.itemsLabel")}</label>
              <button type="button" onClick={addRow} className="secondary-button h-7 px-2 text-xs" disabled={busy}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("reimburse.form.addRow")}
              </button>
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-slate-500">
                    <th className="px-2 py-1.5 font-medium">{t("reimburse.form.colDate")}</th>
                    <th className="px-2 py-1.5 font-medium">
                      {isTravel ? t("reimburse.form.colExpenseItem") : t("reimburse.colCategory")}
                    </th>
                    {isTravel ? (
                      <>
                        <th className="px-2 py-1.5 font-medium">{t("reimburse.form.colTripFrom")}</th>
                        <th className="px-2 py-1.5 font-medium">{t("reimburse.form.colTripTo")}</th>
                        <th className="px-2 py-1.5 font-medium">{t("reimburse.form.colVehicle")}</th>
                      </>
                    ) : null}
                    <th className="px-2 py-1.5 text-right font-medium">{t("reimburse.colAmount")}</th>
                    <th className="w-8 px-1 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={isTravel ? 7 : 4} className="px-2 py-5 text-center text-slate-400">
                        {t("reimburse.form.noRows")}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.key} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-2 py-1.5 align-middle">
                          <DateStepper
                            value={row.entryDate}
                            onChange={(value) => patchRow(row.key, { entryDate: value })}
                            className="h-8 w-[7.5rem]"
                          />
                        </td>
                        <td className="px-2 py-1.5 align-middle">
                          {isTravel ? (
                            <select
                              value={row.expenseItem ?? ""}
                              onChange={(event) =>
                                patchRow(row.key, {
                                  expenseItem: (event.target.value || null) as ReimbursementExpenseItemValue | null,
                                })
                              }
                              className="form-input h-8 w-full text-xs"
                            >
                              <option value="">{t("reimburse.form.expenseItemNone")}</option>
                              {TRAVEL_EXPENSE_ITEMS.map((item) => (
                                <option key={item} value={item}>
                                  {t(`reimburse.expenseItem.${item}`)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="block truncate text-slate-600" title={row.categoryName ?? undefined}>
                              {row.categoryName ?? "-"}
                            </span>
                          )}
                        </td>
                        {isTravel ? (
                          <>
                            <td className="px-2 py-1.5 align-middle">
                              <input
                                type="text"
                                value={row.fromPlace}
                                onChange={(event) => patchRow(row.key, { fromPlace: event.target.value })}
                                placeholder={t("reimburse.form.fromPlacePlaceholder")}
                                className="form-input h-8 w-full text-xs"
                              />
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <input
                                type="text"
                                value={row.toPlace}
                                onChange={(event) => patchRow(row.key, { toPlace: event.target.value })}
                                placeholder={t("reimburse.form.toPlacePlaceholder")}
                                className="form-input h-8 w-full text-xs"
                              />
                            </td>
                            <td className="px-2 py-1.5 align-middle">
                              <input
                                type="text"
                                value={row.vehicle}
                                onChange={(event) => patchRow(row.key, { vehicle: event.target.value })}
                                placeholder={t("reimburse.form.vehiclePlaceholder")}
                                className="form-input h-8 w-full text-xs"
                              />
                            </td>
                          </>
                        ) : null}
                        <td className="px-2 py-1.5 align-middle">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={row.amount}
                            onChange={(event) => patchRow(row.key, { amount: event.target.value })}
                            placeholder="0.00"
                            className="form-input h-8 w-full text-right text-xs"
                          />
                        </td>
                        <td className="px-1 py-1.5 text-center align-middle">
                          <button
                            type="button"
                            onClick={() => removeRow(row.key)}
                            disabled={busy}
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50"
                            title={t("reimburse.form.removeRow")}
                            aria-label={t("reimburse.form.removeRow")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-slate-600">{t("reimburse.noteLabel")}</label>
              <ClearableNoteField value={note} onValueChange={setNote} className="form-input h-9 w-full" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                {t("reimburse.form.attachmentCount")}
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={attachmentCount}
                onChange={(event) => setAttachmentCount(event.target.value)}
                placeholder={t("reimburse.form.attachmentCountPlaceholder")}
                className="form-input h-9 w-full text-right"
              />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-100 p-3">
          <div className="text-sm text-slate-600">
            <span className="text-xs text-slate-500">{t("reimburse.totalLabel")}: </span>
            <span className="font-semibold tabular-nums text-slate-800">{formatMoneyYuan(total)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="secondary-button h-9 px-3" disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => { void submit(); }}
              className="primary-button h-9 px-3"
              disabled={busy || rows.length === 0}
            >
              {busy ? t("debtShell.saving") : t("reimburse.createConfirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
