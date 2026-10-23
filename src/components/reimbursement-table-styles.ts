/**
 * 报销单表格样式。
 *
 * 「新建报销单」(`ReimbursementFormModal`) 与「报销单编辑」(`ReimbursementEditor`)
 * 是同一张单据的两个入口，用户看到的是同一张表：格与格之间只有横竖网格线，
 * 控件贴满格子、没有自己的圆角白框。样式只在这里定义一次，两边都从这里取，
 * 避免再次出现「新建一套、编辑一套」。
 */

/** 明细单元格：透明、直角、贴满格子，聚焦时才在格子内描出蓝边。 */
export const CELL_INPUT =
  "h-8 w-full rounded-none border border-transparent bg-transparent px-1.5 py-0 text-xs text-slate-700 outline-none transition focus:border-blue-400 focus:bg-white";

/** 明细里的日期格：DateStepper 内部固定带 `form-input`，只能用 important 覆盖。 */
export const CELL_DATE_INPUT =
  "!h-8 !w-full !min-w-0 !rounded-none !border-transparent !bg-transparent !px-1.5 !py-0 !text-xs focus:!border-blue-400 focus:!shadow-none disabled:!bg-transparent";

/** 抬头/审核格：字段名列 + 竖线 + 编辑列；聚焦描边只落在编辑列，不圈左侧字段名。 */
export const HEADER_CELL = "flex min-h-8 items-stretch border-b border-r border-slate-300 transition";

/** 抬头格里固定宽度的字段名列，不换行，右侧一条竖线。 */
export const HEADER_LABEL =
  "flex w-24 shrink-0 items-center whitespace-nowrap border-r border-slate-300 px-2 text-slate-500";

/** 抬头格的编辑列：撑满剩余宽度，控件自己不再画框；蓝框只圈这一列。 */
export const HEADER_EDIT =
  "flex min-w-0 flex-1 items-stretch outline-none transition focus-within:bg-white focus-within:ring-1 focus-within:ring-inset focus-within:ring-blue-500";

/** 抬头格里的文本/下拉控件。 */
export const HEADER_FIELD =
  "h-full w-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-2 py-0 text-xs font-medium text-slate-800 outline-none disabled:cursor-not-allowed";

/**
 * 抬头格里的日期控件。
 *
 * 右侧留出 1.75rem：`DateStepper` 的日历按钮是绝对定位（`compact` 时 `right-0.5 w-6`），
 * 之前只留 `px-1.5`，日期文本会被图标压住（出差起止两格尤其明显）。
 */
export const HEADER_DATE =
  "!h-full !w-full !min-w-0 !rounded-none !border-0 !bg-transparent !pl-1.5 !pr-7 !py-0 !text-xs font-medium text-slate-800 focus:!shadow-none disabled:!bg-transparent disabled:!text-slate-800";

/**
 * 明细表列宽（rem）。新建弹窗与单据编辑页是同一张纸表单，列宽只在这里定义一次：
 * 日期、金额、小计、操作列定宽，其余列（描述、各分项、备注）平分剩余宽度。
 */
export const COL_DATE_WIDTH = "8rem";
export const COL_AMOUNT_WIDTH = "7rem";
export const COL_TOTAL_WIDTH = "6rem";
export const COL_ACTION_WIDTH = "2.5rem";

/** 明细表通用列数：差旅 10 列、一般报销 6 列（含操作列）。 */
export const TRAVEL_COLUMN_COUNT = 10;
export const GENERAL_COLUMN_COUNT = 6;

/**
 * 合计行下方「大写金额 / 附件张数」的分栏位置：落在表格真实列边界上，
 * 竖线才能与上方连通。差旅落在「住宿」之后，一般报销落在「小计」之后。
 */
export const TRAVEL_TOTALS_SPLIT = 6;
export const GENERAL_TOTALS_SPLIT = 4;

/**
 * 报销单整窗尺寸：新建弹窗、单据编辑页、审核页共用一套（三处不再各写一套）。
 *
 * - 宽度：80rem，窄屏退到 92vw（与 `EntryModalShell` 的 3xl 档一致）
 * - 高度：**跟内容走**——窗口底边贴着卡片（新建窗的按钮行）收尾，内容少时不撑高、
 *   不留空白；封顶为视口 − 上下留白，超出在窗口内部滚动
 * - 上沿固定：由 `EntryModalShell` 统一锚定（顶边首次打开时定下，之后只动下沿），
 *   这里**不要**再传 `backdropClassName` 自己改遮罩对齐，否则会把窗口再顶一次
 * - 不写 `minHeight`：短页签（一般报销）不需要为了「看着大」而撑出空白
 */
export const REIMBURSE_PANEL_STYLE = {
  width: "min(80rem, 92vw)",
  minWidth: "min(720px, calc(100vw - 2rem))",
  maxWidth: "calc(100vw - 2rem)",
};
