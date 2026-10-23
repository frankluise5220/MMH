"use client";

import { formatRmbUpper } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { CalcInput } from "./CalcInput";
import { CELL_INPUT } from "./reimbursement-table-styles";

/**
 * 单据「合计金额」行的下一行：左边大写金额、右边附件张数。
 *
 * 新建、编辑、审核三处共用这一份布局。为了让分栏竖线与上方的表格竖线
 * **连成一条**，这一行不再用一个跨列单元格 + 2/3 flex（那样竖线会悬在
 * 表格中间），而是按表格真实的列边界拆成两个跨列单元格：分界落在
 * `splitColumn` 之后，正好接上方的列线；右侧边线与表格外框同一条。
 *
 * 差旅表的分界放在补助列之后（≈2/3），一般报销表放在小计列之后（≈2/3），
 * 宽度比例由列宽决定，因此不需要再写死百分比。
 */

/** 大写金额格：内容不换行，超出部分省略，鼠标悬停看全文。 */
const CELL_BODY = "flex min-w-0 items-center gap-2 px-2 py-1 text-xs";

export function ReimbursementTotalsRow({
  columnCount,
  splitColumn,
  total,
  attachmentCount,
  onAttachmentCountChange,
  editable = false,
}: {
  /** 这一行要跨越的总列数（等于表格列数）。 */
  columnCount: number;
  /** 分栏位置：前 `splitColumn` 列给大写金额，其余列给附件张数。 */
  splitColumn: number;
  total: number;
  attachmentCount: string;
  onAttachmentCountChange?: (value: string) => void;
  editable?: boolean;
}) {
  const { t } = useI18n();
  const upper = formatRmbUpper(total);
  const attachmentColumns = Math.max(1, columnCount - splitColumn);

  return (
    <tr className="bg-white">
      {/* 大写金额：右边界就是表格上方的某条列线，竖线因此连贯。 */}
      <td colSpan={splitColumn} className="border-t border-r border-slate-300 p-0 align-middle">
        <div className={CELL_BODY}>
          <span className="shrink-0 text-slate-500">{t("reimburse.totalUpper")}</span>
          <span className="min-w-0 truncate font-medium tracking-wide text-slate-800" title={upper}>
            {upper}
          </span>
        </div>
      </td>
      {/* 附件张数：占剩余列，右侧边线与表格外框连续。 */}
      <td colSpan={attachmentColumns} className="border-t border-r border-slate-300 p-0 align-middle">
        <div className={CELL_BODY}>
          <span className="shrink-0 text-slate-500">{t("reimburse.form.attachmentCount")}</span>
          <div className="min-w-0 flex-1">
            {editable && onAttachmentCountChange ? (
              <CalcInput
                bare
                value={attachmentCount}
                onChange={onAttachmentCountChange}
                precision={0}
                hideCalculator
                inputClassName={`${CELL_INPUT} text-right font-sans tabular-nums`}
                className="h-8 w-full"
              />
            ) : (
              <span className="block text-right font-medium tabular-nums text-slate-800">
                {attachmentCount || "-"}
              </span>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
