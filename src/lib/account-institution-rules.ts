export const STOCK_ACCOUNT_INSTITUTION_ERROR = "股票账户必须选择证券公司机构";

export function isStockInvestmentAccount(kind: string | null | undefined, investProductType: string | null | undefined) {
  return kind === "investment" && investProductType === "stock";
}

export function isStockAccountInstitutionType(type: string | null | undefined) {
  return type === "brokerage";
}
