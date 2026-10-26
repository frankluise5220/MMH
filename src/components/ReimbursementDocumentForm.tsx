"use client";

import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { formatMoneyYuan } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { CalcInput, evaluateCalcInputExpression } from "./CalcInput";
import { ClearableNoteField } from "./ClearableNoteField";
import { DateStepper } from "./DateStepper";
import { ReimbursementTotalsRow } from "./ReimbursementTotalsRow";
import {
  CELL_DATE_INPUT,
  CELL_INPUT,
  COL_ACTION_WIDTH,
  COL_AMOUNT_WIDTH,
  COL_DATE_WIDTH,
  COL_TOTAL_WIDTH,
  GENERAL_COLUMN_COUNT,
  GENERAL_TOTALS_SPLIT,
  HEADER_CELL,
  HEADER_DATE,
  HEADER_EDIT,
  HEADER_FIELD,
  HEADER_LABEL,
  TRAVEL_COLUMN_COUNT,
  TRAVEL_TOTALS_SPLIT,
} from "./reimbursement-table-styles";
import type {
  ReimbursementExpenseItemValue,
  ReimbursementKindValue,
} from "@/lib/server/sidebar-actions/reimbursement-actions";

/**
 * 报销单**纸面表单**：新建（`ReimbursementFormModal`）与编辑/审核（`ReimbursementEditor`）
 * 共用这一个组件 —— 抬头网格、明细表、合计行、大写金额/附件张数都在这里，
 * 两边只负责自己的状态与保存动作，不再各写一套 JSX。
 *
 * 数据模型刻意统一成「输入态字符串 + 元」：
 *  - `ReimbursementDraftRow` 一行对应纸面上的一行明细，`key` 是行标识
 *    （新建用自增 key，编辑用服务端 `item.id`）；
 *  - 金额字段保留用户正在输入的字符串（`CalcInput` 失焦才格式化），
 *    汇总时才解析成数字，避免输入过程中被四舍五入。
 *
 * 差异全部通过 props 表达：`readOnly`（已报销 / 审核态）、`onAddRow` / `onRemoveRow`
 * （有回调才有对应按钮）、`hideNote`（详情窗隐藏备注格）、`titleBlock`（单据编号大字）、
 * `extraSections`（审核区、批次备注等）。
 */

/** 费用明细最多 6 行（纸质单据的行数上限），更多交易走「关联原始交易」。 */
export const MAX_EXPENSE_ROWS = 6;

/** 关联原始交易默认露出 5 行，超出在表内滚动。 */
export const SOURCE_SCROLL_MAX_H = "max-h-[10.875rem]";

export type ReimbursementDraftRow = {
  /** 行标识：新建窗是本地自增 key，编辑窗是明细记录 id。 */
  key: string;
  txRecordId: string | null;
  expenseItem: ReimbursementExpenseItemValue | null;
  categoryName: string | null;
  entryDate: string;
  fromPlace: string;
  toPlace: string;
  days: string;
  amount: string;
  /** 差旅分项（元，保留输入态字符串）：市外交通 / 市内交通 / 补贴 / 住宿。 */
  outsideTransportAmount: string;
  cityTransportAmount: string;
  subsidyAmount: string;
  lodgingAmount: string;
  note: string | null;
};

export type ReimbursementDraftHeader = {
  batchId: string;
  documentNumber: string;
  travelStartDate: string;
  travelEndDate: string;
  travelReason: string;
  note: string;
  attachmentCount: string;
};

export function parseReimbursementAmount(value: string) {
  // 与 `CalcInput` 的求值口径一致：格子里允许写 100+50 这类表达式，
  // 汇总与提交（后端拿到的也是同一结果）不能出现「表上写 150、合计算 100」。
  const parsed = evaluateCalcInputExpression(value, 0);
  return Number.isFinite(parsed ?? NaN) ? (parsed as number) : 0;
}

/** 差旅一行的金额 = 四个分项之和。 */
export function travelRowSubtotal(row: ReimbursementDraftRow) {
  return (
    Math.abs(parseReimbursementAmount(row.outsideTransportAmount)) +
    Math.abs(parseReimbursementAmount(row.cityTransportAmount)) +
    Math.abs(parseReimbursementAmount(row.subsidyAmount)) +
    Math.abs(parseReimbursementAmount(row.lodgingAmount))
  );
}

/** 一行在小计列上显示的金额（元）。 */
function rowSubtotal(row: ReimbursementDraftRow, kind: ReimbursementKindValue) {
  return kind === "travel"
    ? travelRowSubtotal(row)
    : Math.abs(parseReimbursementAmount(row.amount));
}

/** 明细金额合计（元）。 */
function rowsTotal(rows: ReimbursementDraftRow[], kind: ReimbursementKindValue) {
  return rows.reduce((sum, row) => sum + rowSubtotal(row, kind), 0);
}

export function ReimbursementDocumentForm({
  kind,
  header,
  onHeaderChange,
  rows,
  onRowChange,
  readOnly = false,
  busy = false,
  batches,
  settledDate,
  titleBlock,
  extraSections,
  hideNote = false,
  onAddRow,
  onRemoveRow,
}: {
  kind: ReimbursementKindValue;
  header: ReimbursementDraftHeader;
  onHeaderChange: (patch: Partial<ReimbursementDraftHeader>) => void;
  rows: ReimbursementDraftRow[];
  onRowChange: (key: string, patch: Partial<ReimbursementDraftRow>) => void;
  /** 整表只读（已报销 / 审核态），只影响控件，不影响汇总与显示。 */
  readOnly?: boolean;
  /** 加行 / 删行按钮的禁用状态（提交中）。 */
  busy?: boolean;
  batches: { id: string; title: string }[];
  /** 抬头「到账日期」的展示值；新建单据尚未到账，显示 "-"。 */
  settledDate?: string | null;
  /** 纸面标题（单据编号大字）。 */
  titleBlock?: ReactNode;
  /** 明细表下方的追加区（审核区、批次备注等）。 */
  extraSections?: ReactNode;
  /** 详情窗不显示「备注」格（备注只在新建时填写）。 */
  hideNote?: boolean;
  onAddRow?: () => void;
  onRemoveRow?: (key: string) => void;
}) {
  const { t } = useI18n();
  const isTravel = kind === "travel";
  const showActionColumn = Boolean(onRemoveRow) && !readOnly;
  const total = rowsTotal(rows, kind);
  const travelColumnTotals = rows.reduce(
    (totals, row) => ({
      outsideTransport: totals.outsideTransport + Math.abs(parseReimbursementAmount(row.outsideTransportAmount)),
      cityTransport: totals.cityTransport + Math.abs(parseReimbursementAmount(row.cityTransportAmount)),
      subsidy: totals.subsidy + Math.abs(parseReimbursementAmount(row.subsidyAmount)),
      lodging: totals.lodging + Math.abs(parseReimbursementAmount(row.lodgingAmount)),
    }),
    { outsideTransport: 0, cityTransport: 0, subsidy: 0, lodging: 0 },
  );
  const bodyColumnCount =
    (isTravel ? TRAVEL_COLUMN_COUNT : GENERAL_COLUMN_COUNT) - (showActionColumn ? 0 : 1);

  const amountCell = (row: ReimbursementDraftRow, field: keyof ReimbursementDraftRow) =>
    readOnly ? (
      <span className="block px-1.5 py-1.5 text-right tabular-nums text-slate-700">
        {formatMoneyYuan(Math.abs(parseReimbursementAmount(String(row[field] ?? ""))))}
      </span>
    ) : (
      <CalcInput
        bare
        value={String(row[field] ?? "")}
        onChange={(value) => onRowChange(row.key, { [field]: value } as Partial<ReimbursementDraftRow>)}
        precision={2}
        hideCalculator
        inputClassName={`${CELL_INPUT} text-right font-sans tabular-nums`}
        className="h-8 w-full"
      />
    );

  return (
    <>
      {titleBlock}

      {/* 抬头：归属批次 / 单据类型 / 单据编号 / 到账日期 / 差旅区间与事由 / 备注。
          新建与编辑共用同一格序、同一格宽，切换单据时不会「跳一格」。
          报销对象不再单独成行——它已经落在所属批次上，抬头由「归属批次」表达。 */}
      <section className={`mt-3 grid grid-cols-12 border-l border-t border-slate-300 text-xs ${readOnly ? "bg-slate-50/70" : ""}`}>
        <div className={`${HEADER_CELL} col-span-12 sm:col-span-3`}>
          <span className={HEADER_LABEL}>{t("reimburse.batch.belongsTo")}</span>
          <div className={HEADER_EDIT}>
            <select
              value={header.batchId}
              onChange={(event) => onHeaderChange({ batchId: event.target.value })}
              disabled={readOnly}
              className={`${HEADER_FIELD} disabled:appearance-none`}
            >
              <option value="">{t("reimburse.batch.none")}</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={`${HEADER_CELL} col-span-12 sm:col-span-3`}>
          <span className={HEADER_LABEL}>{t("reimburse.document.type")}</span>
          <div className={HEADER_EDIT}>
            {/* 类型由上方页签锁定（新建时选定，之后不可改），这里只是纸面上的同一信息。 */}
            <span className="min-w-0 flex-1 truncate px-2 py-1.5 font-medium text-slate-800">
              {t(isTravel ? "reimburse.form.kindTravel" : "reimburse.form.kindGeneral")}
            </span>
          </div>
        </div>

        <div className={`${HEADER_CELL} col-span-12 sm:col-span-3`}>
          <span className={HEADER_LABEL}>{t("reimburse.document.number")}</span>
          <div className={HEADER_EDIT}>
            <input
              type="text"
              value={header.documentNumber}
              onChange={(event) => onHeaderChange({ documentNumber: event.target.value })}
              disabled={readOnly}
              placeholder={t("reimburse.titlePlaceholder")}
              className={HEADER_FIELD}
            />
          </div>
        </div>

        {/* 到账日期：由报销/打款动作写入，纸面上只读展示；未到账显示 "-"。 */}
        <div className={`${HEADER_CELL} col-span-12 sm:col-span-3`}>
          <span className={HEADER_LABEL}>{t("reimburse.reimburseDate")}</span>
          <div className="flex min-w-0 flex-1 items-center justify-end px-2">
            <span className="truncate font-medium tabular-nums text-slate-800">{settledDate || "-"}</span>
          </div>
        </div>

        {isTravel ? (
          <>
            {/* 出差起止：右边界压在首行「单据类型」文字的右竖线上。
                那条线的位置是「3 列结束 + 字段名列 96px」，不是整 4 列——列宽随窗口变化
                （1248px 时 104px/列），用 `col-span` 只在某个宽度下偶然对上，窗口一变就差几像素，
                所以这里用 `calc(25% + 6rem)` 直接按那条线定位，事由格用 `flex-1` 接上。
                两个日期各自 `flex-1` 平分。 */}
            <div className="col-span-12 flex flex-col sm:flex-row">
              <div className={`${HEADER_CELL} w-full shrink-0 sm:w-[calc(25%_+_6rem)]`}>
                <span className={HEADER_LABEL}>{t("reimburse.form.travelDateRange")}</span>
                <div className={`${HEADER_EDIT} gap-1`}>
                  {/* `[&>div]:w-full`：`DateStepper` 根节点是 `relative min-w-0`（宽度跟内容走），
                      不加这一句日期框会缩在格子里、右边与格线留空档。 */}
                  <div className="flex min-w-0 flex-1 items-center [&>div]:w-full">
                    <DateStepper
                      value={header.travelStartDate}
                      onChange={(value) => onHeaderChange({ travelStartDate: value })}
                      disabled={readOnly}
                      compact
                      className={HEADER_DATE}
                    />
                  </div>
                  <span className="flex shrink-0 items-center px-0.5 text-slate-400">~</span>
                  <div className="flex min-w-0 flex-1 items-center [&>div]:w-full">
                    <DateStepper
                      value={header.travelEndDate}
                      onChange={(value) => onHeaderChange({ travelEndDate: value })}
                      disabled={readOnly}
                      compact
                      className={HEADER_DATE}
                    />
                  </div>
                </div>
              </div>
              <div className={`${HEADER_CELL} w-full min-w-0 sm:flex-1`}>
                <span className={HEADER_LABEL}>{t("reimburse.form.travelReason")}</span>
                <div className={HEADER_EDIT}>
                  <input
                    type="text"
                    value={header.travelReason}
                    onChange={(event) => onHeaderChange({ travelReason: event.target.value })}
                    disabled={readOnly}
                    placeholder={t("reimburse.form.travelReasonPlaceholder")}
                    className={HEADER_FIELD}
                  />
                </div>
              </div>
            </div>
          </>
        ) : null}

        {/* 备注：抬头最后一行；详情窗不显示（`hideNote`），新建时仍可填。 */}
        {hideNote ? null : (
          <div className={`${HEADER_CELL} col-span-12`}>
            <span className={HEADER_LABEL}>{t("reimburse.noteLabel")}</span>
            <div className={HEADER_EDIT}>
              <ClearableNoteField
                value={header.note}
                onValueChange={(value) => onHeaderChange({ note: value })}
                disabled={readOnly}
                className={HEADER_FIELD}
              />
            </div>
          </div>
        )}
      </section>

      {/* 明细表：Excel 单元格式，格与格之间只有网格线，控件贴满格子。 */}
      <div className="mt-5">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-medium text-slate-600">{t("reimburse.form.itemsLabel")}</label>
          <span className="text-xs tabular-nums text-slate-400">
            {rows.length}/{MAX_EXPENSE_ROWS}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse border border-slate-300 text-xs">
            <thead>
              <tr className="bg-slate-100 text-left text-slate-600">
                <th
                  className="border-b border-r border-slate-300 px-2 py-1.5 font-medium"
                  style={{ width: COL_DATE_WIDTH }}
                >
                  {t("reimburse.colDate")}
                </th>
                {isTravel ? (
                  <>
                    <th className="border-b border-r border-slate-300 px-2 py-1.5 font-medium">
                      {t("reimburse.travel.routeVehicle")}
                    </th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">
                      {t("reimburse.travel.outsideTransport")}
                    </th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">
                      {t("reimburse.travel.cityTransport")}
                    </th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">
                      {t("reimburse.travel.days")}
                    </th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">
                      {t("reimburse.travel.allowance")}
                    </th>
                    <th className="border-b border-r border-slate-300 px-1 py-1.5 text-right font-medium">
                      {t("reimburse.expenseItem.lodging")}
                    </th>
                  </>
                ) : (
                  <>
                    <th className="border-b border-r border-slate-300 px-2 py-1.5 font-medium">
                      {kind === "general" ? t("reimburse.form.generalReason") : t("reimburse.colCategory")}
                    </th>
                    <th
                      className="border-b border-r border-slate-300 px-2 py-1.5 text-right font-medium"
                      style={{ width: COL_AMOUNT_WIDTH }}
                    >
                      {t("reimburse.colAmount")}
                    </th>
                  </>
                )}
                <th
                  className="border-b border-r border-slate-300 px-2 py-1.5 text-right font-medium"
                  style={{ width: COL_TOTAL_WIDTH }}
                >
                  {t("reimburse.editor.subtotal")}
                </th>
                <th className="border-b border-r border-slate-300 px-2 py-1.5 font-medium">
                  {t("reimburse.colNote")}
                </th>
                {showActionColumn ? (
                  <th
                    className="border-b border-r border-slate-300 px-1 py-1.5 text-center"
                    style={{ width: COL_ACTION_WIDTH }}
                  >
                    {onAddRow ? (
                      <button
                        type="button"
                        onClick={onAddRow}
                        disabled={busy || rows.length >= MAX_EXPENSE_ROWS}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-none border border-slate-300 bg-white text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-300 disabled:hover:text-slate-600"
                        title={t("reimburse.form.addRow")}
                        aria-label={t("reimburse.form.addRow")}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={bodyColumnCount} className="px-2 py-5 text-center text-slate-400">
                    {t("reimburse.form.noRows")}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.key} className="hover:bg-blue-50/40">
                    <td className="border-b border-r border-slate-200 p-0 align-middle">
                      {readOnly ? (
                        <span className="block truncate px-2 py-1.5 tabular-nums text-slate-600">{row.entryDate || "-"}</span>
                      ) : (
                        <DateStepper
                          value={row.entryDate}
                          onChange={(value) => onRowChange(row.key, { entryDate: value })}
                          className={CELL_DATE_INPUT}
                          compact
                        />
                      )}
                    </td>

                    {isTravel ? (
                      <>
                        {/* 起止地点一格两小格（起点 / 终点），纸表单的行内写法。 */}
                        <td className="border-b border-r border-slate-200 p-0 align-middle">
                          {readOnly ? (
                            <div
                              className="truncate px-2 py-1.5 text-slate-600"
                              title={[row.fromPlace, row.toPlace].filter(Boolean).join(" -> ")}
                            >
                              {[row.fromPlace, row.toPlace].filter(Boolean).join(" -> ") || "-"}
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-px">
                              <input
                                type="text"
                                value={row.fromPlace}
                                onChange={(event) => onRowChange(row.key, { fromPlace: event.target.value })}
                                placeholder={t("reimburse.travel.fromPlace")}
                                className={CELL_INPUT}
                              />
                              <input
                                type="text"
                                value={row.toPlace}
                                onChange={(event) => onRowChange(row.key, { toPlace: event.target.value })}
                                placeholder={t("reimburse.travel.toPlace")}
                                className={CELL_INPUT}
                              />
                            </div>
                          )}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0 align-middle text-right">
                          {amountCell(row, "outsideTransportAmount")}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0 align-middle text-right">
                          {amountCell(row, "cityTransportAmount")}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0 align-middle">
                          {readOnly ? (
                            <span className="block px-1.5 py-1.5 text-right tabular-nums text-slate-700">{row.days || "-"}</span>
                          ) : (
                            <CalcInput
                              bare
                              value={row.days}
                              onChange={(value) => onRowChange(row.key, { days: value })}
                              precision={0}
                              hideCalculator
                              inputClassName={`${CELL_INPUT} text-right font-sans tabular-nums`}
                              className="h-8 w-full"
                            />
                          )}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0 align-middle text-right">
                          {amountCell(row, "subsidyAmount")}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0 align-middle text-right">
                          {amountCell(row, "lodgingAmount")}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="border-b border-r border-slate-200 p-0 align-middle">
                          {!readOnly && kind === "general" ? (
                            <input
                              type="text"
                              value={row.categoryName ?? ""}
                              onChange={(event) => onRowChange(row.key, { categoryName: event.target.value })}
                              placeholder={t("reimburse.form.generalReasonPlaceholder")}
                              className={CELL_INPUT}
                            />
                          ) : (
                            <span className="block truncate px-2 py-1.5 text-slate-600">
                              {row.expenseItem ? t(`reimburse.expenseItem.${row.expenseItem}`) : row.categoryName || "-"}
                            </span>
                          )}
                        </td>
                        <td className="border-b border-r border-slate-200 p-0 align-middle text-right">
                          {amountCell(row, "amount")}
                        </td>
                      </>
                    )}

                    <td className="border-b border-r border-slate-200 px-1.5 py-1.5 text-right font-medium tabular-nums text-slate-700">
                      {formatMoneyYuan(rowSubtotal(row, kind))}
                    </td>
                    <td className="border-b border-r border-slate-200 p-0 align-middle text-slate-500">
                      {readOnly ? (
                        <span className="block truncate px-2 py-1.5">{row.note || "-"}</span>
                      ) : (
                        <input
                          type="text"
                          value={row.note ?? ""}
                          onChange={(event) => onRowChange(row.key, { note: event.target.value })}
                          placeholder={t("reimburse.colNote")}
                          className={CELL_INPUT}
                        />
                      )}
                    </td>

                    {showActionColumn ? (
                      <td className="border-b border-slate-200 px-1 py-1 text-center align-middle">
                        <button
                          type="button"
                          onClick={() => onRemoveRow?.(row.key)}
                          disabled={busy}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-none border border-slate-300 bg-white text-slate-500 hover:border-rose-400 hover:text-rose-600 disabled:opacity-40"
                          title={t("reimburse.form.removeRow")}
                          aria-label={t("reimburse.form.removeRow")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              {isTravel ? (
                <tr className="bg-slate-100 font-semibold">
                  <td colSpan={2} className="border-t border-r border-slate-300 px-2 py-1.5 text-slate-600">
                    {t("reimburse.totalLabel")}
                  </td>
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(travelColumnTotals.outsideTransport)}
                  </td>
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(travelColumnTotals.cityTransport)}
                  </td>
                  <td className="border-t border-r border-slate-300" />
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(travelColumnTotals.subsidy)}
                  </td>
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(travelColumnTotals.lodging)}
                  </td>
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(total)}
                  </td>
                  <td className="border-t border-r border-slate-300" />
                  {showActionColumn ? <td className="border-t border-slate-300" /> : null}
                </tr>
              ) : (
                <tr className="bg-slate-100 font-semibold">
                  <td colSpan={2} className="border-t border-r border-slate-300 px-2 py-1.5 text-slate-600">
                    {t("reimburse.totalLabel")}
                  </td>
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(total)}
                  </td>
                  <td className="border-t border-r border-slate-300 px-1.5 py-1.5 text-right tabular-nums text-slate-800">
                    {formatMoneyYuan(total)}
                  </td>
                  <td className="border-t border-r border-slate-300" />
                  {showActionColumn ? <td className="border-t border-slate-300" /> : null}
                </tr>
              )}
              {/* 合计金额下方：大写金额居左、附件张数居右，分栏落在真实列边界上。 */}
              <ReimbursementTotalsRow
                columnCount={bodyColumnCount}
                splitColumn={isTravel ? TRAVEL_TOTALS_SPLIT : GENERAL_TOTALS_SPLIT}
                total={total}
                attachmentCount={header.attachmentCount}
                onAttachmentCountChange={
                  readOnly ? undefined : (value) => onHeaderChange({ attachmentCount: value })
                }
                editable={!readOnly}
              />
            </tfoot>
          </table>
        </div>
      </div>

      {extraSections}
    </>
  );
}
