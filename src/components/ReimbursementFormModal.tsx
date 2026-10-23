"use client";
/** 整窗外壳（FT 卡片 + 页签 + 固定页脚 + 高度锁定）：差旅费 / 一般费用报销单做成 FT 页签。 */
import { EntryModalShell } from "@/components/EntryModalShell";

import { useMemo, useRef, useState } from "react";
import { Eraser, Link2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatAmountDraft, formatMoneyYuan } from "@/lib/format";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { reimbursementErrorMessage } from "@/lib/reimbursement-error";
import { REIMBURSE_PANEL_STYLE } from "./reimbursement-table-styles";
import {
  MAX_EXPENSE_ROWS,
  ReimbursementDocumentForm,
  SOURCE_SCROLL_MAX_H,
  parseReimbursementAmount,
  travelRowSubtotal,
  type ReimbursementDraftHeader,
  type ReimbursementDraftRow,
} from "./ReimbursementDocumentForm";
import type {
  ReimbursementActionResult,
  ReimbursementCandidateData,
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

/** 明细行 = 共用表单的行模型（`ReimbursementDocumentForm`）+ 新建窗自己的 advance 账户归属。 */
type DraftRow = ReimbursementDraftRow & { advanceAccountId: string | null };

export function ReimbursementFormModal({
  objectId,
  objectName,
  advanceAccountId,
  objectType = "counterparty",
  objectOptions = [],
  entries = [],
  candidates = [],
  batchId,
  batches = [],
  defaultKind = "travel",
  actions,
  onClose,
  onCreated,
}: {
  objectId?: string;
  objectName?: string;
  /** Empty when the workspace is global; then resolved from the picked object. */
  advanceAccountId: string;
  objectType?: "counterparty" | "institution";
  objectOptions?: ReimbursementObjectOption[];
  /** 明细列表带入的交易，创建后成为单据的原始交易明细。 */
  entries?: ReimbursementFormEntry[];
  /** 同对象 advance 账户下尚未被任何单据占用的交易，供「关联原始记录」挑选。 */
  candidates?: ReimbursementCandidateData[];
  batchId?: string;
  /** 可选的归属批次列表；与单据编辑页抬头同一格，便于新建时直接归档。 */
  batches?: { id: string; title: string; advanceAccountId?: string | null }[];
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

  // 新建入口只提供「差旅费 / 一般费用报销单」两类，代付不再作为新建类型；
  // 历史 advance 单据仍可在单据编辑页查看与切换。
  const [kind, setKind] = useState<ReimbursementKindValue>(defaultKind === "advance" ? "general" : defaultKind);
  /**
   * 不做「对象选择器」后的兜底：入口带入的交易仍能反查所属对象。
   * 只取第一笔带入交易的账户归属，不再默认 `objectOptions[0]`——否则没选批次也可能建出一张归属随机的单据。
   */
  const seededObjectId =
    objectOptions.find(
      (option) => entries[0]?.advanceAccountId && option.advanceAccountIds?.includes(entries[0].advanceAccountId),
    )?.id ?? "";
  const [title, setTitle] = useState(() =>
    objectName ? t("reimburse.titleDefault", { name: objectName }) : t("reimburse.form.titleFallback"),
  );
  const [note, setNote] = useState("");
  const [pickedBatchId, setPickedBatchId] = useState(batchId ?? "");
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
      amount: formatAmountDraft(entry.amount),
      // 从明细带进来的交易先落在「市外交通」，需要拆到其他列的再手动挪。
      outsideTransportAmount: formatAmountDraft(entry.amount),
      cityTransportAmount: "0",
      subsidyAmount: "0",
      lodgingAmount: "0",
      days: "",
      entryDate: entry.date,
      categoryName: entry.categoryName,
      note: entry.note,
    })),
  );
  const [busy, setBusy] = useState(false);

  /** 单据级「原始记录」：与明细行解耦——删掉明细行不会解绑交易，和单据编辑页一致。 */
  const [linkedSources, setLinkedSources] = useState<ReimbursementCandidateData[]>(() =>
    entries.map((entry) => ({ ...entry, advanceAccountId: entry.advanceAccountId ?? "" })),
  );
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [pickedLinkIds, setPickedLinkIds] = useState<string[]>([]);

  const isTravel = kind === "travel";
  const isGeneral = kind === "general";
  /**
   * 报销对象由「归属批次」决定：批次上的 advance 账户 → 拥有该账户的对象。
   * 入口已定对象（`objectId`）时优先用它，其次是批次的账户归属，最后是带入交易反查。
   */
  const batchAdvanceAccountId =
    batches.find((batch) => batch.id === pickedBatchId)?.advanceAccountId ?? null;
  const batchObjectId = batchAdvanceAccountId
    ? objectOptions.find((option) => option.advanceAccountIds?.includes(batchAdvanceAccountId))?.id
    : undefined;
  const resolvedObjectId = objectId ?? batchObjectId ?? seededObjectId;
  const resolvedObjectName =
    objectName ?? objectOptions.find((option) => option.id === resolvedObjectId)?.name ?? "";
  const resolvedAdvanceAccountId = advanceAccountId
    || objectOptions.find((option) => option.id === resolvedObjectId)?.advanceAccountIds?.[0]
    || "";

  /** 切页签时搬金额：转差旅落到「市外交通」，转一般报销取四项小计，避免切一下就归零。 */
  const changeKind = (nextKind: ReimbursementKindValue) => {
    if (nextKind === kind) return;
    setRows((current) =>
      current.map((row) => {
        if (nextKind === "travel") {
          const amount = Math.abs(parseReimbursementAmount(row.amount));
          return travelRowSubtotal(row) > 0 || amount === 0
            ? row
            : { ...row, outsideTransportAmount: String(amount) };
        }
        return { ...row, amount: String(travelRowSubtotal(row)) };
      }),
    );
    setKind(nextKind);
  };

  const linkedSourceTotal = useMemo(
    () => linkedSources.reduce((sum, item) => sum + Math.abs(item.amount), 0),
    [linkedSources],
  );

  /** 可关联的候选：同对象 advance 账户下、尚未被本单关联的交易。 */
  const linkCandidates = candidates.filter(
    (candidate) =>
      (!resolvedAdvanceAccountId || candidate.advanceAccountId === resolvedAdvanceAccountId) &&
      !linkedSources.some((item) => item.id === candidate.id),
  );

  /** 明细剩余可填行数：只用于提示「哪些交易不会补行」，不限制能关联几笔。 */
  const remainingRowSlots = Math.max(0, MAX_EXPENSE_ROWS - rows.length);

  /** 关联原始记录：明细未满 6 行时补一行（金额先落「市外交通」），满了只关联不补行。 */
  const addLinkedSources = (ids: string[]) => {
    const picked = candidates.filter((candidate) => ids.includes(candidate.id));
    if (picked.length === 0) return;
    setLinkedSources((current) => [
      ...current,
      ...picked.filter((candidate) => !current.some((item) => item.id === candidate.id)),
    ]);
    setRows((current) => {
      // 明细硬上限 6 行：超出的交易只建立关联，不补行，也不改动已有行的金额。
      const room = Math.max(0, MAX_EXPENSE_ROWS - current.length);
      if (room === 0) return current;
      return [
        ...current,
        ...picked.slice(0, room).map((candidate) => ({
          key: makeKey(),
          txRecordId: candidate.id,
          advanceAccountId: candidate.advanceAccountId || null,
          expenseItem: null,
          fromPlace: "",
          toPlace: "",
          amount: formatAmountDraft(candidate.amount),
          outsideTransportAmount: formatAmountDraft(candidate.amount),
          cityTransportAmount: "0",
          subsidyAmount: "0",
          lodgingAmount: "0",
          days: "",
          entryDate: candidate.date,
          categoryName: candidate.categoryName,
          note: candidate.note,
        })),
      ];
    });
    setPickedLinkIds([]);
    setLinkPickerOpen(false);
  };

  /** 解除关联只解绑交易，已填的明细行保留（金额仍归用户手动维护）。 */
  const unlinkSource = (id: string) => {
    setLinkedSources((current) => current.filter((item) => item.id !== id));
    setRows((current) => current.map((row) => (row.txRecordId === id ? { ...row, txRecordId: null } : row)));
  };

  const patchRow = (key: string, patch: Partial<DraftRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows((current) => {
      if (current.length >= MAX_EXPENSE_ROWS) return current;
      return [
        ...current,
        {
          key: makeKey(),
          txRecordId: null,
          advanceAccountId: null,
          expenseItem: null,
          fromPlace: "",
          toPlace: "",
          amount: "",
          outsideTransportAmount: "0",
          cityTransportAmount: "0",
          subsidyAmount: "0",
          lodgingAmount: "0",
          days: "",
          entryDate: isTravel ? travelEndDate : todayDateLocalYmd(),
          // 一般报销的「事由」直接编辑在 categoryName 上，新建行留空串让输入框可用。
          categoryName: isGeneral ? "" : null,
          note: null,
        },
      ];
    });
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  };
  // 共用表单用「抬头对象 + patch」接口；新建窗的抬头是分开的几个 useState，这里做适配。
  const draftHeader: ReimbursementDraftHeader = {
    batchId: pickedBatchId,
    documentNumber: title,
    travelStartDate,
    travelEndDate,
    travelReason,
    note,
    attachmentCount,
  };
  const patchDraftHeader = (patch: Partial<ReimbursementDraftHeader>) => {
    if (patch.batchId !== undefined) {
      // 换批次就是换 advance 账户（对象由批次决定）：原关联交易已不属于新批次的对象，
      // 留着会让整单校验失败（后端要求所有 transactionIds 都能在目标账户下查到）。
      const nextAdvanceAccountId = batches.find((batch) => batch.id === patch.batchId)?.advanceAccountId ?? null;
      const currentAdvanceAccountId = batches.find((batch) => batch.id === pickedBatchId)?.advanceAccountId ?? null;
      if (nextAdvanceAccountId !== currentAdvanceAccountId) {
        setLinkedSources([]);
        setRows((current) => current.map((row) => (row.txRecordId ? { ...row, txRecordId: null } : row)));
      }
      setPickedBatchId(patch.batchId);
    }
    if (patch.documentNumber !== undefined) setTitle(patch.documentNumber);
    if (patch.travelStartDate !== undefined) setTravelStartDate(patch.travelStartDate);
    if (patch.travelEndDate !== undefined) setTravelEndDate(patch.travelEndDate);
    if (patch.travelReason !== undefined) setTravelReason(patch.travelReason);
    if (patch.note !== undefined) setNote(patch.note);
    if (patch.attachmentCount !== undefined) setAttachmentCount(patch.attachmentCount);
  };


  const submit = async () => {
    if (busy) return;
    // 抬头已不显示「报销对象」：对象与 advance 账户都由「归属批次」决定，缺一项就是还没选批次。
    if (!resolvedObjectId || !resolvedAdvanceAccountId) {
      window.alert(t("reimburse.alert.batchRequired"));
      return;
    }
    const payload = rows
      .map((row) =>
        isTravel
          ? {
              txRecordId: row.txRecordId,
              advanceAccountId: row.advanceAccountId,
              expenseItem: row.expenseItem,
              fromPlace: row.fromPlace,
              toPlace: row.toPlace,
              // 行金额 = 四个分项之和；分项同时单独提交，单据页要按列显示与汇总。
              amount: travelRowSubtotal(row),
              outsideTransportAmount: Math.abs(parseReimbursementAmount(row.outsideTransportAmount)),
              cityTransportAmount: Math.abs(parseReimbursementAmount(row.cityTransportAmount)),
              subsidyAmount: Math.abs(parseReimbursementAmount(row.subsidyAmount)),
              lodgingAmount: Math.abs(parseReimbursementAmount(row.lodgingAmount)),
              days: row.days.trim() ? Math.max(0, Math.floor(parseReimbursementAmount(row.days))) : null,
              entryDate: row.entryDate,
              categoryName: row.categoryName,
              note: row.note,
            }
          : {
              txRecordId: row.txRecordId,
              advanceAccountId: row.advanceAccountId,
              expenseItem: row.expenseItem,
              fromPlace: null,
              toPlace: null,
              amount: Math.abs(parseReimbursementAmount(row.amount)),
              entryDate: row.entryDate,
              categoryName: row.categoryName?.trim() ? row.categoryName.trim() : null,
              note: row.note,
            },
      )
      .filter((row) => row.amount > 0);
    if (payload.length === 0) {
      window.alert(t("reimburse.alert.itemsRequired"));
      return;
    }
    const formData = new FormData();
    formData.set("title", title);
    formData.set("documentNumber", title);
    formData.set("note", note);
    formData.set("kind", kind);
    formData.set("counterpartyId", resolvedObjectId);
    formData.set("counterpartyName", resolvedObjectName);
    formData.set("advanceAccountId", resolvedAdvanceAccountId);
    if (pickedBatchId) formData.set("batchId", pickedBatchId);
    formData.set("objectType", objectType);
    formData.set("travelStartDate", isTravel ? travelStartDate : "");
    formData.set("travelEndDate", isTravel ? travelEndDate : "");
    formData.set("travelReason", isTravel ? travelReason : "");
    formData.set("attachmentCount", attachmentCount);
    formData.set("items", JSON.stringify(payload));
    // Keep the picked advance transactions attached to the document itself
    // (原始交易明细), independently of the editable expense rows.
    const linkedTransactionIds = linkedSources.map((item) => item.id);
    if (linkedTransactionIds.length > 0) formData.set("transactionIds", linkedTransactionIds.join(","));
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

  /** 报销类型做成 FT 页签：差旅费 / 一般费用报销单。切换只换字段与明细列，已填内容保留。 */
  const kindTabs = [
    { id: "travel", label: t("reimburse.form.kindTravel") },
    { id: "general", label: t("reimburse.form.kindGeneral") },
  ];

  return (
    <EntryModalShell
      open
      heightKey="reimburse-form"
      width="3xl"
      heightMode="natural"
      panelStyle={REIMBURSE_PANEL_STYLE}
      title={t("reimburse.create")}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      tabs={kindTabs}
      activeTabId={kind}
      onTabChange={(id) => changeKind(id as ReimbursementKindValue)}
      footer={
        <button type="submit" className="primary-button h-9 px-3" disabled={busy || rows.length === 0}>
          {busy ? t("liabilityShell.saving") : t("reimburse.createConfirm")}
        </button>
      }
    >
      {/* 纸面表单：抬头 / 明细表 / 合计行与单据编辑、审核共用 `ReimbursementDocumentForm`。 */}
      <ReimbursementDocumentForm
        kind={kind}
        header={draftHeader}
        onHeaderChange={patchDraftHeader}
        rows={rows}
        onRowChange={patchRow}
        busy={busy}
        batches={batches}
        titleBlock={
          /* 与编辑 / 审核窗同一处大字：只写单据编号，归属对象在下方抬头格里（不重复）。 */
          <header className="border-b-2 border-slate-700 pb-4 text-center">
            <div className="text-lg font-semibold tracking-wide text-slate-800">
              {draftHeader.documentNumber || t("reimburse.form.titleFallback")}
            </div>
          </header>
        }
        onAddRow={addRow}
        onRemoveRow={removeRow}
      />

      {/* 原始记录：容器、入口按钮、表格与单据编辑 / 审核窗同一套（灰底边框区块 + 右上「添加」）。 */}
      <div className="mt-3 border border-slate-300 bg-slate-50 px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-slate-600">{t("reimburse.editor.sourceInfo")}</div>
          <button
            type="button"
            onClick={() => {
              setPickedLinkIds([]);
              setLinkPickerOpen((current) => !current);
            }}
            className="inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:border-slate-400 hover:text-slate-800"
            disabled={busy}
          >
            <Link2 className="h-3.5 w-3.5" />
            {t("reimburse.source.add")}
          </button>
        </div>
        {linkedSources.length > 0 ? (
          <div className={`overflow-auto border border-slate-300 bg-white ${SOURCE_SCROLL_MAX_H}`}>
            <table className="w-full border-collapse text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-left font-medium">
                    {t("reimburse.source.date")}
                  </th>
                  <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-left font-medium">
                    {t("reimburse.source.category")}
                  </th>
                  <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-right font-medium">
                    {t("reimburse.source.amount")}
                  </th>
                  <th className="sticky top-0 z-10 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-left font-medium">
                    {t("reimburse.source.note")}
                  </th>
                  <th className="sticky top-0 z-10 w-16 border-b border-slate-200 bg-slate-100" />
                </tr>
              </thead>
              <tbody>
                {linkedSources.map((item) => (
                  <tr key={item.id}>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-600">{item.date}</td>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-slate-600">{item.categoryName ?? "-"}</td>
                    <td className="border-b border-r border-slate-100 px-2 py-1.5 text-right font-medium tabular-nums text-slate-700">
                      {formatMoneyYuan(item.amount)}
                    </td>
                    <td className="max-w-[20rem] truncate border-b border-r border-slate-100 px-2 py-1.5 text-slate-500" title={item.note ?? undefined}>
                      {item.note || "-"}
                    </td>
                    <td className="border-b border-slate-100 px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => unlinkSource(item.id)}
                        disabled={busy}
                        className="inline-flex h-6 items-center justify-center rounded-none border border-slate-300 bg-white px-1.5 text-slate-600 hover:border-amber-400 hover:text-amber-700 disabled:opacity-50"
                        title={t("reimburse.source.clear")}
                        aria-label={t("reimburse.source.clear")}
                      >
                        <Eraser className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-semibold text-slate-700">
                  <td className="sticky bottom-0 z-10 border-r border-slate-200 bg-slate-50 px-2 py-1.5" colSpan={2}>
                    {t("reimburse.source.summary", { count: linkedSources.length })}
                  </td>
                  <td className="sticky bottom-0 z-10 border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-right tabular-nums">
                    {formatMoneyYuan(linkedSourceTotal)}
                  </td>
                  <td className="sticky bottom-0 z-10 border-slate-200 bg-slate-50" colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-400">
            {t("reimburse.source.noLinkedTransactions")}
          </div>
        )}
        {linkPickerOpen ? (
          <div className="mt-2 border border-slate-300 bg-white p-2">
            <div className="mb-1 text-xs font-medium text-slate-600">{t("reimburse.source.selectTransaction")}</div>
            {/* 默认 3 行，勾选候选后再放开到 5 行——刚展开时不撑高弹窗。 */}
            {linkCandidates.length > 0 ? (
              <div
                className={`overflow-y-auto border border-slate-300 bg-white transition-[max-height] duration-200 ease-out ${
                  pickedLinkIds.length > 0 ? "max-h-[9.125rem]" : "max-h-[5.5rem]"
                }`}
              >
                {linkCandidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className="flex cursor-pointer items-start gap-2 border-b border-slate-100 px-2 py-1.5 text-xs last:border-b-0 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={pickedLinkIds.includes(candidate.id)}
                      onChange={(event) =>
                        setPickedLinkIds((current) =>
                          event.target.checked
                            ? [...current, candidate.id]
                            : current.filter((id) => id !== candidate.id),
                        )
                      }
                      disabled={busy}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 text-slate-600">
                      {candidate.date} · {candidate.categoryName ?? "-"} ·{" "}
                      <span className="tabular-nums">{formatMoneyYuan(candidate.amount)}</span>
                      {candidate.note ? ` · ${candidate.note}` : ""}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-400">
                {t("reimburse.source.noCandidates")}
              </div>
            )}
            {/* 关联交易数可以多于明细行数：明细满 6 行后只关联，不再补行。 */}
            {linkCandidates.length > remainingRowSlots ? (
              <div className="mt-1 text-xs text-amber-600">{t("reimburse.source.rowLimit")}</div>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPickedLinkIds([]);
                  setLinkPickerOpen(false);
                }}
                className="inline-flex h-7 items-center border border-slate-300 bg-white px-2.5 text-xs text-slate-600 hover:border-slate-400 hover:text-slate-800 disabled:opacity-40"
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => addLinkedSources(pickedLinkIds)}
                className="inline-flex h-7 items-center bg-blue-600 px-2.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy || pickedLinkIds.length === 0}
              >
                {t("reimburse.source.link")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </EntryModalShell>
  );
}
