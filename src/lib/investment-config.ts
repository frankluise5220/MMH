/**
 * 投资交易配置模块
 *
 * 提供统一的类型定义、常量和辅助函数
 * 被 InvestmentFormModal 等组件共享使用
 */

import { addWorkdaysUtc } from "@/lib/date-utils";

// 基金交易类型
export type FundSubtype = "buy" | "redeem" | "dividend_cash" | "switch_out" | "buy_failed";

// 产品类型
export type ProductType = "fund" | "money" | "wealth" | "deposit";

// 产品类型标签
export const PRODUCT_LABELS: Record<ProductType, string> = {
  fund: "开放式基金",
  money: "货币基金",
  wealth: "银行理财",
  deposit: "活期/存款",
};

// 交易类型标签
export const SUBTYPE_LABELS: Record<FundSubtype, string> = {
  buy: "买入",
  redeem: "赎回",
  dividend_cash: "现金红利",
  switch_out: "转换转出",
  buy_failed: "暂停申购",
};

// 每种产品类型支持的交易类型（布局分组）
export const PRODUCT_SUBTYPES: Record<ProductType, FundSubtype[][]> = {
  fund: [["buy", "redeem", "dividend_cash", "switch_out"]],
  money: [["buy", "redeem", "dividend_cash"]],
  wealth: [["buy", "redeem"]],
  deposit: [["buy", "redeem"]],
};

// 存款产品的特殊标签
export const DEPOSIT_LABELS: Partial<Record<FundSubtype, string>> = {
  buy: "存入",
  redeem: "取出",
};

/**
 * 解析数字输入（处理逗号分隔）
 */
export const parseNumber = (s: string): number => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * 工作日加减
 */
export const addDays = addWorkdaysUtc;

/**
 * 是否赎回类交易（赎回、转换转出）
 */
export const isRedeemLike = (s: FundSubtype): boolean => s === "redeem" || s === "switch_out";

/**
 * 是否买入类交易（买入、红利再投资）
 */
export const isBuyLike = (s: FundSubtype): boolean => s === "buy";

/**
 * 是否红利类交易
 */
export const isDividend = (s: FundSubtype): boolean => s === "dividend_cash";

/**
 * 是否显示份额字段
 * 现金红利不涉及份额变动，不显示
 */
export const showUnitsFor = (s: FundSubtype, pt: ProductType): boolean => pt === "fund" && (isBuyLike(s) || isRedeemLike(s));

/**
 * 是否显示手续费字段
 * 现金红利无手续费，不显示
 */
export const showFeeFor = (s: FundSubtype, pt: ProductType): boolean =>
  (pt === "fund" || pt === "money") && (isBuyLike(s) || isRedeemLike(s));

/**
 * 是否显示净值字段
 * 现金红利是直接收到的现金，不涉及净值
 */
export const showNavFor = (s: FundSubtype): boolean => isBuyLike(s) || isRedeemLike(s);

/**
 * 是否显示 T+N 确认天数和确认日期
 * 现金红利只有到账日期，没有申请确认的概念
 */
export const showConfirmFor = (s: FundSubtype): boolean => isBuyLike(s) || isRedeemLike(s);

/**
 * 是否显示账户选择区（现金账户 + 基金账户）
 * 现金红利默认到账到本基金账户，不需要选别的账户
 */
export const showAccountSelectorsFor = (s: FundSubtype): boolean => isBuyLike(s) || isRedeemLike(s) || s === "buy_failed";

/**
 * 获取金额字段标签
 */
export function amountLabel(s: FundSubtype, pt: ProductType): string {
  if (pt === "deposit") return isRedeemLike(s) ? "取出金额" : "存入金额";
  if (isRedeemLike(s)) return "赎回金额";
  if (s === "dividend_cash") return "现金红利金额";
  return "买入金额";
}

/**
 * 交易类型显示信息注册表 — 全项目唯一数据源
 *
 * 所有 fundSubtype + source 组合的标签、颜色、文字色
 * 均由此处定义。页面和组件通过 subtypeDisplay(subtype, source) 获取。
 */
export type SubtypeDisplay = {
  label: string;
  cls: string;           // 标签背景色 class
  textCls?: string;      // 金额文字色 class（如分红绿色）
};

const DISPLAY_MAP: Record<string, SubtypeDisplay> = {
  buy: { label: "买入", cls: "bg-blue-50 text-blue-600" },
  redeem: { label: "赎回", cls: "bg-orange-50 text-orange-600" },
  switch_out: { label: "转出", cls: "bg-orange-50 text-orange-600" },
  dividend_cash: { label: "现金红利", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
  "buy_failed|regular_invest": { label: "定投(暂停申购)", cls: "bg-red-50 text-red-600" },
  "buy_failed|regular_invest_refund": { label: "定投(资金退回)", cls: "bg-amber-50 text-amber-600" },
  buy_failed: { label: "暂停申购", cls: "bg-red-50 text-red-600" }, // fallback
  _default: { label: "投资", cls: "bg-slate-50 text-slate-600" },
};

export function subtypeDisplay(subtype: string | null | undefined, source?: string | null): SubtypeDisplay {
  if (!subtype) return DISPLAY_MAP._default;
  if (subtype === "buy_failed" && source) {
    const key = `buy_failed|${source}`;
    return DISPLAY_MAP[key] ?? DISPLAY_MAP.buy_failed;
  }
  return DISPLAY_MAP[subtype] ?? DISPLAY_MAP._default;
}