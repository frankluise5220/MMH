import {
  isCashAccountAllowedForInvestAccount,
  isThirdPartyInstitutionType,
} from "./cash-invest-account-rules";

/** @deprecated 使用 isThirdPartyInstitutionType；保留旧名供既有理财代码引用。 */
export const isThirdPartyWealthInstitutionType = isThirdPartyInstitutionType;

/**
 * @deprecated 使用 isCashAccountAllowedForInvestAccount（中性名）。
 * 保留旧签名（wealth* 键名）仅作兼容委托，实现只存在于新模块。
 */
export function isWealthAccountAllowedForCashAccount(input: {
  cashGroupId: string;
  cashInstitutionId?: string | null;
  wealthGroupId: string;
  wealthInstitutionId?: string | null;
  wealthInstitutionType?: string | null;
}) {
  return isCashAccountAllowedForInvestAccount({
    cashGroupId: input.cashGroupId,
    cashInstitutionId: input.cashInstitutionId,
    investGroupId: input.wealthGroupId,
    investInstitutionId: input.wealthInstitutionId,
    investInstitutionType: input.wealthInstitutionType,
  });
}
