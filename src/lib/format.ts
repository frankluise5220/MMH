/**
 * Public formatting utility functions.
 *
 * Display-layer rule: all amount formatting must go through this module;
 * do not redefine it in pages/components.
 * Single data source → single formatting.
 *
 * Naming conventions:
 * - Display-layer types use a Display suffix (e.g. PositionDisplayRow)
 * - Display-layer variables use a display prefix in ambiguous contexts
 * - Edit-dialog props use a current/initial prefix to indicate origin (e.g. currentAmount)
 * - useState inside edit dialogs needs no prefix (scope is already clear)
 */

export function roundDisplayNumber(amount: number, fractionDigits = 2): number {
  if (!Number.isFinite(amount)) return amount;
  const factor = 10 ** fractionDigits;
  const sign = amount < 0 ? -1 : 1;
  const roundedAbs = Math.round((Math.abs(amount) + Number.EPSILON) * factor) / factor;
  const rounded = roundedAbs === 0 ? 0 : sign * roundedAbs;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function isDisplayZeroMoney(amount: number, fractionDigits = 2): boolean {
  return roundDisplayNumber(amount, fractionDigits) === 0;
}

/** Format a signed amount with 2 decimal places using the zh-CN locale (no ¥ prefix). */
export function formatMoney(amount: number): string {
  const rounded = roundDisplayNumber(amount, 2);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}${abs.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format an amount with a ¥ prefix and 2 decimal places. */
export function formatMoneyYuan(amount: number): string {
  return `¥${formatMoney(amount)}`;
}

const RMB_DIGITS = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const RMB_UNITS = ["", "拾", "佰", "仟"];
const RMB_SECTION_UNITS = ["", "万", "亿", "万亿"];

/** 一节的四位数字（0–9999）转大写，节内零合并成一个「零」。 */
function rmbSectionUpper(section: number): string {
  let text = "";
  let pendingZero = false;
  for (let unitIndex = 0; section > 0; unitIndex += 1) {
    const digit = section % 10;
    if (digit === 0) {
      if (text.length > 0) pendingZero = true;
    } else {
      text = `${RMB_DIGITS[digit]}${RMB_UNITS[unitIndex]}${pendingZero ? "零" : ""}${text}`;
      pendingZero = false;
    }
    section = Math.floor(section / 10);
  }
  return text;
}

/** 整数元转大写，按「万亿 / 亿 / 万 / 元」分节，节与节之间按需补一个「零」。 */
function rmbIntegerUpper(yuan: number): string {
  if (yuan <= 0) return "";
  const sections: number[] = [];
  let rest = yuan;
  while (rest > 0) {
    sections.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let text = "";
  let pendingZero = false;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section === 0) {
      if (text.length > 0) pendingZero = true;
      continue;
    }
    if (text.length > 0 && (pendingZero || section < 1000) && !text.endsWith("零")) {
      text += "零";
    }
    text += `${rmbSectionUpper(section)}${RMB_SECTION_UNITS[index] ?? ""}`;
    pendingZero = false;
  }
  return text;
}

/**
 * 人民币金额大写（单据抬头 / 合计行用）：`1234.5` → `壹仟贰佰叁拾肆元伍角整`。
 * 非有限数值返回 "-"；0 输出 `零元整`；负数前置「负」。
 */
export function formatRmbUpper(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(Number(amount))) return "-";
  const rounded = roundDisplayNumber(Number(amount), 2);
  const sign = rounded < 0 ? "负" : "";
  const totalFen = Math.round(Math.abs(rounded) * 100);
  if (totalFen === 0) return "零元整";
  const yuan = Math.floor(totalFen / 100);
  const jiao = Math.floor((totalFen % 100) / 10);
  const fen = totalFen % 10;
  const jiaoText = jiao === 0 ? "" : `${RMB_DIGITS[jiao]}角`;
  const fenText = fen === 0 ? "" : `${RMB_DIGITS[fen]}分`;
  let decimalText: string;
  if (!jiaoText && !fenText) decimalText = "整";
  else if (!jiaoText) decimalText = `零${fenText}`;
  else decimalText = fenText ? `${jiaoText}${fenText}` : `${jiaoText}整`;
  return `${sign}${rmbIntegerUpper(yuan) || "零"}元${decimalText}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  JPY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  HKD: "HK$",
};

/** Format an amount in the given currency; unknown currencies display a currency-code prefix. */
export function formatCurrencyMoney(amount: number, currency = "CNY"): string {
  const code = String(currency || "CNY").trim().toUpperCase() || "CNY";
  const prefix = CURRENCY_SYMBOLS[code] ?? `${code} `;
  const digits = code === "JPY" ? 0 : 2;
  const rounded = roundDisplayNumber(amount, digits);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}${prefix}${abs.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Format an amount accepting string | number input (e.g. Prisma Decimal); non-finite numbers return "-". */
/**
 * Format a money value for an amount **input draft** (form state), not for
 * display: fixed decimal places, no thousands separators (`5000` → `"5000.00"`).
 *
 * Amount inputs are only normalized on blur (see `CalcInput`), so every value
 * that is prefilled from data (edit dialog, auto-filled installment / principal,
 * copy-from-previous) must go through this helper — otherwise the field shows
 * `5000` instead of `5000.00`. Empty / non-finite input returns "" so the field
 * stays empty.
 */
export function formatAmountDraft(value: unknown, fractionDigits = 2): string {
  if (value == null || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return "";
  return roundDisplayNumber(n, fractionDigits).toFixed(fractionDigits);
}

export function formatMoneyLoose(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? formatMoney(n) : "-";
}

/**
 * Format an amount with a trailing currency-code suffix (e.g. "1,234.56 CNY").
 * Used for stock/securities tables and dialogs that show both amount and
 * currency; invalid input returns "-".
 */
export function formatMoneyWithCurrencyCode(value: number | null | undefined, currency = "CNY"): string {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const code = String(currency || "CNY");
  return `${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

/**
 * Format a rate/percentage: signed, fixed decimal digits, "%" suffix;
 * non-finite numbers return "-".
 * For example 0.0435 → "+4.35%", -0.01 → "-1.00%".
 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "-";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}
