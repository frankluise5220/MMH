/**
 * 涨跌颜色配置
 *
 * red_up_green_down: 红涨绿跌（中国习惯）— 涨(正数)=红, 跌(负数)=绿
 * green_up_red_down: 绿涨红跌（国际习惯）— 涨(正数)=绿, 跌(负数)=红
 */
export type ColorScheme = "red_up_green_down" | "green_up_red_down";

/**
 * 涨跌调色板。
 *
 * 历史上各页面/组件各自实现了一份“正红负绿”三元映射，深浅（600/700）和
 * 中性色（slate-500/600/700/900）略有漂移。统一收敛到这里，组件只选调色板名：
 * - default：标准（涨红 text-red-600 / 跌绿 text-emerald-700 / 中性 slate-600）
 * - soft：浅一档的跌绿（emerald-600）
 * - softMuted / softDark：soft 基础上中性色为 slate-500 / slate-700
 * - strong：深一档（red-700 / emerald-700），中性 slate-900
 * - muted：默认色但中性为 slate-500
 * - strongMuted：strong 色但中性为 slate-500
 */
export const PNL_PALETTES = {
  default: { up: "text-red-600", down: "text-emerald-700", neutral: "text-slate-600" },
  soft: { up: "text-red-600", down: "text-emerald-600", neutral: "text-slate-600" },
  softMuted: { up: "text-red-600", down: "text-emerald-600", neutral: "text-slate-500" },
  softDark: { up: "text-red-600", down: "text-emerald-600", neutral: "text-slate-700" },
  strong: { up: "text-red-700", down: "text-emerald-700", neutral: "text-slate-900" },
  muted: { up: "text-red-600", down: "text-emerald-700", neutral: "text-slate-500" },
  strongMuted: { up: "text-red-700", down: "text-emerald-700", neutral: "text-slate-500" },
} as const;

export type PnlPaletteName = keyof typeof PNL_PALETTES;

/** 根据数值和色系返回颜色 class */
export function pnlColor(n: number, scheme: ColorScheme, palette: PnlPaletteName = "default"): string {
  const p = PNL_PALETTES[palette] ?? PNL_PALETTES.default;
  const positive = scheme === "red_up_green_down" ? p.up : p.down;
  const negative = scheme === "red_up_green_down" ? p.down : p.up;
  if (n > 0) return positive;
  if (n < 0) return negative;
  return p.neutral;
}

/**
 * 以 isRedUp 布尔形式取涨跌颜色（历史组件普遍使用 isRedUp 而非 scheme 字符串）。
 * invert=true 时方向反转（用于负债类金额：正值表示“已还/可用”等利好语义）。
 */
export function pnlClassFromRedUp(
  n: number,
  isRedUp: boolean,
  palette: PnlPaletteName = "default",
  invert = false,
): string {
  const scheme: ColorScheme = isRedUp ? "red_up_green_down" : "green_up_red_down";
  const p = PNL_PALETTES[palette] ?? PNL_PALETTES.default;
  const positive = scheme === "red_up_green_down" ? p.up : p.down;
  const negative = scheme === "red_up_green_down" ? p.down : p.up;
  if (n > 0) return invert ? negative : positive;
  if (n < 0) return invert ? positive : negative;
  return p.neutral;
}

/**
 * 资金正负颜色（正=绿，负=红，零=灰），用于余额/金额等非涨跌场景的展示。
 * 涨跌盈亏请使用 pnlColor(n, scheme)。
 */
export function amountToneClass(value: number): string {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
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
