/**
 * Investment transaction configuration module.
 *
 * Provides unified type definitions, constants, and helper functions
 * shared by components such as InvestmentFormModal.
 */

import { TRANSACTION_SOURCE_FUND_UNITS_RECONCILE } from "@/lib/transaction-semantics";

// Fund transaction types
export type FundSubtype = "buy" | "redeem" | "dividend_cash" | "dividend_reinvest" | "buy_failed";

// Product types (labels come from the i18n catalog via `investment.product.*`)
export type ProductType =
  | "fund"
  | "money"
  | "wealth"
  | "advisor"
  | "bond"
  | "deposit"
  | "metal"
  | "stock"
  | "property";

/** 账户类型下拉（UI 列表）：投顾组合（advisor）已收口，不再提供新建入口（2026-11-03）。 */
export const PRODUCT_TYPES: readonly ProductType[] = [
  "fund",
  "money",
  "wealth",
  "bond",
  "deposit",
  "metal",
  "stock",
  "property",
];

/**
 * 服务端接受列表：在 UI 列表基础上保留 advisor，保证残留的投顾账户在编辑时
 * 不会被 normalize 静默转成其他类型（仅存量，不再新增）。
 */
export const ACCOUNT_PRODUCT_TYPES_ACCEPTED: readonly ProductType[] = [...PRODUCT_TYPES, "advisor"];

/**
 * Wealth-like product types share the wealth ledger chain
 * (WealthTransaction / WealthProduct, manual nav valuation).
 * 投顾组合（advisor）自上而下按「份额 × 组合净值」记账，与理财同构。
 */
export function isWealthLikeProductType(productType: string | null | undefined): boolean {
  return productType === "wealth" || productType === "advisor";
}

export function supportsCostBasisMethod(productType: string | null | undefined): boolean {
  return productType === "fund" || productType === "money" || productType === "stock";
}

// Transaction types supported by each product type (layout grouping)
export const PRODUCT_SUBTYPES: Record<ProductType, FundSubtype[][]> = {
  fund: [["buy", "redeem", "dividend_cash", "dividend_reinvest"]],
  money: [["buy", "redeem", "dividend_cash", "dividend_reinvest"]],
  wealth: [["buy", "redeem"]],
  advisor: [["buy", "redeem"]],
  bond: [["buy", "redeem"]],
  deposit: [["buy", "redeem"]],
  metal: [["buy", "redeem"]],
  stock: [],
  property: [],
};

/**
 * Parse numeric input (handles comma separators).
 */
export const parseNumber = (s: string): number => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Whether this is a redeem-like transaction.
 */
export const isRedeemLike = (s: FundSubtype): boolean => s === "redeem";

/**
 * Whether this is a buy-like transaction (buy, dividend reinvestment).
 */
export const isBuyLike = (s: FundSubtype): boolean => s === "buy" || s === "dividend_reinvest";

/**
 * Whether this is a dividend transaction.
 */
export const isDividend = (s: FundSubtype): boolean => s === "dividend_cash" || s === "dividend_reinvest";

/**
 * Whether the units field is shown.
 * Cash dividends do not change units, so it is not shown.
 */
export const showUnitsFor = (s: FundSubtype, pt: ProductType): boolean => (pt === "fund" || pt === "money" || pt === "metal") && (isBuyLike(s) || isRedeemLike(s));

/**
 * Whether the fee field is shown.
 * Cash dividends have no fee, so it is not shown.
 */
export const showFeeFor = (s: FundSubtype, pt: ProductType): boolean =>
  (pt === "fund" || pt === "money" || pt === "metal") && (isBuyLike(s) || isRedeemLike(s)) && !isDividend(s);

/**
 * Whether the NAV field is shown.
 * Cash dividends are cash received directly and do not involve NAV.
 */

/**
 * Whether the T+N confirmation days and confirmation date are shown.
 * Cash dividends only have an arrival date; there is no application confirmation concept.
 * Precious metals (gold/silver/… accumulation) trade in real time: the trade price and the
 * quantity are fixed at the moment of purchase, so there is no T+N confirmation step to show.
 */
export const showConfirmFor = (s: FundSubtype, pt?: ProductType): boolean =>
  pt === "metal" ? false : (isBuyLike(s) || isRedeemLike(s)) && !isDividend(s);

/**
 * Whether the arrival date is shown (confirmation date + arrivalDays).
 * Buy-like transactions have an arrival date; redeem-like funds arrive on the redeem
 * confirmation date, so no extra arrivalDate is needed.
 */

/**
 * Whether the account selector area is shown (cash account + fund account).
 * Neither cash dividends nor dividend reinvestment requires selecting a cash account.
 */
export const showAccountSelectorsFor = (s: FundSubtype): boolean => (isBuyLike(s) && s !== "dividend_reinvest") || isRedeemLike(s) || s === "buy_failed";

/**
 * Transaction type display registry — the single source of truth for the whole project.
 *
 * All labels, colors, and text colors for every fundSubtype + source combination
 * are defined here. Pages and components retrieve them via subtypeDisplay(subtype, source).
 */
type SubtypeDisplay = {
  labelKey: string;
  cls: string;           // Label background color class
  textCls?: string;      // Amount text color class (e.g. dividend green)
};

const DISPLAY_MAP: Record<string, SubtypeDisplay> = {
  buy: { labelKey: "fund.subtype.buy", cls: "bg-blue-50 text-blue-600" },
  [`buy|${TRANSACTION_SOURCE_FUND_UNITS_RECONCILE}`]: { labelKey: "fundShell.subtype.unitsReconcile", cls: "bg-violet-50 text-violet-600" },
  "buy|regular_invest": { labelKey: "fundShell.subtype.buyRegularInvest", cls: "bg-blue-50 text-blue-600" },
  "buy|dividend": { labelKey: "fund.subtype.dividend", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
  redeem: { labelKey: "fund.subtype.redeem", cls: "bg-orange-50 text-orange-600" },
  [`redeem|${TRANSACTION_SOURCE_FUND_UNITS_RECONCILE}`]: { labelKey: "fundShell.subtype.unitsReconcile", cls: "bg-violet-50 text-violet-600" },
  dividend_reinvest: { labelKey: "fundShell.subtype.dividendReinvest", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
  dividend_cash: { labelKey: "fundShell.subtype.dividendCash", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
  "buy_failed|regular_invest": { labelKey: "fundShell.subtype.buyFailed", cls: "bg-red-50 text-red-600" },
  "buy_failed|regular_invest_refund": { labelKey: "fundShell.subtype.buyRefund", cls: "bg-amber-50 text-amber-600" },
  buy_failed: { labelKey: "fundShell.subtype.buyFailed", cls: "bg-red-50 text-red-600" }, // fallback
  _default: { labelKey: "fundShell.subtype.unknown", cls: "bg-slate-50 text-slate-600" },
};

export function subtypeDisplay(subtype: string | null | undefined, source?: string | null): SubtypeDisplay {
  if (!subtype) return DISPLAY_MAP._default;
  if (source) {
    const key = `${subtype}|${source}`;
    return DISPLAY_MAP[key] ?? DISPLAY_MAP[subtype] ?? DISPLAY_MAP._default;
  }
  return DISPLAY_MAP[subtype] ?? DISPLAY_MAP._default;
}
