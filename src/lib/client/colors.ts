/**
 * 涨跌颜色配置
 *
 * red_up_green_down: 红涨绿跌（中国习惯）— 涨(正数)=红, 跌(负数)=绿
 * green_up_red_down: 绿涨红跌（国际习惯）— 涨(正数)=绿, 跌(负数)=红
 */
export type ColorScheme = "red_up_green_down" | "green_up_red_down";

const schemes: Record<ColorScheme, { up: string; down: string; neutral: string }> = {
  red_up_green_down: {
    up: "text-red-600",
    down: "text-emerald-700",
    neutral: "text-slate-600",
  },
  green_up_red_down: {
    up: "text-emerald-700",
    down: "text-red-600",
    neutral: "text-slate-600",
  },
};

/** 根据数值和色系返回颜色 class */
export function pnlColor(n: number, scheme: ColorScheme): string {
  const s = schemes[scheme] ?? schemes.red_up_green_down;
  if (n > 0) return s.up;
  if (n < 0) return s.down;
  return s.neutral;
}

export type ImportPreviewAmountKind = "income" | "expense" | "transfer" | "investment" | string;
export type ImportPreviewFlowItem = {
  type?: ImportPreviewAmountKind | null;
  amount?: number | null;
  inflow?: number | null;
  outflow?: number | null;
  transferDirection?: string | null;
};

/**
 * 账单导入预览展示的是资金方向，不是分类好坏。
 * 收入=流入，支出=流出；在红涨绿跌设置下，支出应显示为绿色。
 */
export function importPreviewAmountColor(type: ImportPreviewAmountKind, scheme: ColorScheme): string {
  if (type === "income") return pnlColor(1, scheme);
  if (type === "expense") return pnlColor(-1, scheme);
  return pnlColor(0, scheme);
}

function positiveAmount(value: unknown) {
  const amount = Math.abs(Number(value ?? 0));
  return Number.isFinite(amount) ? amount : 0;
}

export function importPreviewFlowAmountKind(item: ImportPreviewFlowItem): ImportPreviewAmountKind {
  const inflow = positiveAmount(item.inflow);
  const outflow = positiveAmount(item.outflow);
  if (inflow > 0 && outflow <= 0) return "income";
  if (outflow > 0 && inflow <= 0) return "expense";
  if (item.transferDirection === "in") return "income";
  if (item.transferDirection === "out") return "expense";
  return item.type ?? "";
}

export function importPreviewFlowAmountColor(item: ImportPreviewFlowItem, scheme: ColorScheme): string {
  return importPreviewAmountColor(importPreviewFlowAmountKind(item), scheme);
}

export function importPreviewFlowAmountText(item: ImportPreviewFlowItem): string {
  const inflow = positiveAmount(item.inflow);
  const outflow = positiveAmount(item.outflow);
  const amount = inflow > 0 && outflow <= 0
    ? inflow
    : outflow > 0 && inflow <= 0
      ? outflow
      : positiveAmount(item.amount);
  const isExpenseRefund = item.type === "expense" && inflow > 0 && outflow <= 0;
  return `${isExpenseRefund ? "+" : ""}${amount.toFixed(2)}`;
}

export function importPreviewFlowAmountTextFor(item: ImportPreviewFlowItem, direction: "inflow" | "outflow"): string {
  const directAmount = positiveAmount(direction === "inflow" ? item.inflow : item.outflow);
  if (directAmount > 0) return directAmount.toFixed(2);

  const kind = importPreviewFlowAmountKind(item);
  if ((direction === "inflow" && kind === "income") || (direction === "outflow" && kind === "expense")) {
    return positiveAmount(item.amount).toFixed(2);
  }
  return "-";
}

export function importPreviewFlowAmountColorFor(
  item: ImportPreviewFlowItem,
  direction: "inflow" | "outflow",
  scheme: ColorScheme,
): string {
  return importPreviewFlowAmountTextFor(item, direction) === "-"
    ? "text-slate-400"
    : importPreviewAmountColor(direction === "inflow" ? "income" : "expense", scheme);
}

/** 从 cookie 中读取色系偏好 */
export function getColorSchemeFromCookie(cookieHeader: string | null): ColorScheme {
  if (!cookieHeader) return "red_up_green_down";
  const match = cookieHeader.match(/colorScheme=([^;]+)/);
  if (match && (match[1] === "red_up_green_down" || match[1] === "green_up_red_down")) {
    return match[1] as ColorScheme;
  }
  return "red_up_green_down";
}
