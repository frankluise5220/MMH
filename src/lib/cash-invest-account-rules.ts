/**
 * 现金账户 ↔ 投资类账户（债券、理财、基金等）的通用规则。
 *
 * 这些规则与具体品种无关，因此用中性命名；各品种模块直接引用本文件，
 * 不再互相引用对方的规则文件。
 */

const THIRD_PARTY_INSTITUTION_TYPES = new Set(["payment", "ewallet"]);

/** 第三方机构类型（支付 / 电子钱包）。 */
export function isThirdPartyInstitutionType(type: string | null | undefined) {
  return THIRD_PARTY_INSTITUTION_TYPES.has(String(type ?? "").trim());
}

/**
 * 现金账户能否作为某投资类账户的资金来源：
 * 必须在同一账户组，且机构相同（或投资账户属于第三方机构）。
 */
export function isCashAccountAllowedForInvestAccount(input: {
  cashGroupId: string;
  cashInstitutionId?: string | null;
  investGroupId: string;
  investInstitutionId?: string | null;
  investInstitutionType?: string | null;
}) {
  if (input.cashGroupId !== input.investGroupId) return false;
  if (input.cashInstitutionId && input.cashInstitutionId === input.investInstitutionId) return true;
  return isThirdPartyInstitutionType(input.investInstitutionType);
}
