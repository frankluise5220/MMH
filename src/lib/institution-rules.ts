export const INCOME_EXPENSE_INSTITUTION_TYPES = ["bank", "payment"] as const;

const incomeExpenseInstitutionTypeSet = new Set<string>(INCOME_EXPENSE_INSTITUTION_TYPES);

/**
 * 个人 / 往来对象类机构：往来人员、往来组织、家庭成员。
 *
 * 它们只作为账户所有人、结算对象存在，不是任何投资产品的发行方，
 * 因此产品主数据（理财产品库等）的「所属机构」下拉必须排除，写入侧也要拒绝
 * （2026-11-02 用户裁定：理财产品所属机构不能出现这三类）。
 */
export const PERSONAL_INSTITUTION_TYPES = ["person", "organization", "family_member"] as const;

const personalInstitutionTypeSet = new Set<string>(PERSONAL_INSTITUTION_TYPES);

export function isPersonalInstitutionType(type: string | null | undefined) {
  return personalInstitutionTypeSet.has(String(type ?? "").trim());
}

function isIncomeExpenseInstitutionType(type: string | null | undefined) {
  return incomeExpenseInstitutionTypeSet.has(String(type ?? "").trim());
}

export function filterIncomeExpenseInstitutions<T extends { type?: string | null }>(items: T[]) {
  return items.filter((item) => isIncomeExpenseInstitutionType(item.type));
}
