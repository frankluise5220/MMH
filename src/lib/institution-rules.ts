import { INSTITUTION_TYPE_VALUES } from "@/lib/account-kinds";

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

/** 收支对向方下拉里排在最前的两类（最常见，纯排序偏好，不是白名单）。 */
const INCOME_EXPENSE_INSTITUTION_PREFERRED = ["bank", "payment"] as const;

/**
 * 收支流水「对向方」标注可选的机构类型（12 类里去掉往来对象三类）。
 *
 * 2026-11-18 用户裁定放开（此前只有 `bank`、`payment`）：对向方是流水上的**可选标注**
 * （`TxRecord.counterpartyInstitutionId` / `counterpartyInstitutionName`），不参与任何
 * 资金、资产或报表口径，因此没理由比落账账户机构更严——落账账户机构本就不校验类型。
 *
 * 仍然排除 `person`、`organization`、`family_member`：这三类由收支弹窗的「往来对象」
 * 字段（`Counterparty`）承担，两处都能选就会出现同一笔流水两套对象口径。
 *
 * 类型清单从 `INSTITUTION_TYPE_VALUES` 派生（唯一来源），新增机构类型自动跟着放开。
 */
export const INCOME_EXPENSE_INSTITUTION_TYPES: readonly string[] = [
  ...INCOME_EXPENSE_INSTITUTION_PREFERRED,
  ...INSTITUTION_TYPE_VALUES.filter(
    (value) =>
      !personalInstitutionTypeSet.has(value) &&
      !(INCOME_EXPENSE_INSTITUTION_PREFERRED as readonly string[]).includes(value),
  ),
];

const incomeExpenseInstitutionTypeSet = new Set<string>(INCOME_EXPENSE_INSTITUTION_TYPES);

function isIncomeExpenseInstitutionType(type: string | null | undefined) {
  return incomeExpenseInstitutionTypeSet.has(String(type ?? "").trim());
}

export function filterIncomeExpenseInstitutions<T extends { type?: string | null }>(items: T[]) {
  return items.filter((item) => isIncomeExpenseInstitutionType(item.type));
}
