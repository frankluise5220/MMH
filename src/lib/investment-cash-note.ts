/**
 * 投资业务（基金 / 股票）手动交易的自动备注。
 *
 * 用户口径（2026-10-19）：
 * - 资金侧（现金 / 银行卡那笔流水）自动写「基金买入 代码 名称」；
 * - 业务侧（基金 / 股票的那一行）自动写「资金来源 账户名」；
 * - 用户自己填了备注时，两侧一律保留用户备注，不再生成上述文案。
 *
 * 业务侧备注上一次可能已被系统写成「资金来源 账户名」。编辑时按「与当时资金
 * 账户名完全一致」来判定它仍是系统文案，可以随资金账户变化重算；用户改过的
 * 备注永远不会被这套判定吞掉。
 */
export const INVESTMENT_SOURCE_NOTE_LABEL = "资金来源";

export function buildInvestmentSourceNote(cashAccountName: string | null | undefined) {
  const name = String(cashAccountName ?? "").trim();
  return name ? `${INVESTMENT_SOURCE_NOTE_LABEL} ${name}` : "";
}

export function isAutoInvestmentSourceNote(
  note: string | null | undefined,
  cashAccountName: string | null | undefined,
) {
  const value = String(note ?? "").trim();
  if (!value) return false;
  const auto = buildInvestmentSourceNote(cashAccountName);
  return !!auto && value === auto;
}

/**
 * 旧版基金表单在备注为空时会用「基金名称」顶替备注（`memo || fundName`）。
 * 这种备注不是用户写的，编辑时应允许被自动文案替换，否则一行历史数据永远停在「只有基金名称」。
 */
export function isLegacyFundNameNote(
  note: string | null | undefined,
  fundName: string | null | undefined,
) {
  const value = String(note ?? "").trim();
  const name = String(fundName ?? "").trim();
  return !!value && !!name && value === name;
}

/** 「代码 名称」，名称缺失或与代码相同时只保留一份，避免出现「000001 000001」。 */
export function investmentTargetText(
  code: string | null | undefined,
  name: string | null | undefined,
) {
  const trimmedCode = String(code ?? "").trim();
  const trimmedName = String(name ?? "").trim();
  if (trimmedCode && trimmedName && trimmedName !== trimmedCode) return `${trimmedCode} ${trimmedName}`;
  return trimmedName || trimmedCode;
}

export function isFundBuyLikeSubtype(subtype: string | null | undefined) {
  return !subtype || subtype === "buy" || subtype === "switch_in" || subtype === "regular_invest";
}

export function fundActionLabel(subtype: string | null | undefined) {
  if (subtype === "redeem" || subtype === "switch_out") return "基金赎回";
  if (subtype === "dividend_cash") return "基金分红";
  if (subtype === "dividend_reinvest") return "分红再投";
  if (subtype === "buy_failed") return "买入退回";
  return "基金买入";
}

export function buildFundCashFlowNote(input: {
  subtype?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
}) {
  const label = fundActionLabel(input.subtype);
  const target = investmentTargetText(input.fundCode, input.fundName);
  return target ? `${label} ${target}` : label;
}
