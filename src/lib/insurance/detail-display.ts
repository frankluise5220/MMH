type InsuranceDetailLike = {
  readonly source?: string | null;
  readonly fundName?: string | null;
  readonly fundSubtype?: string | null;
  readonly note?: string | null;
  readonly categoryName?: string | null;
};

function isInsuranceRedeemLike(fundSubtype: string | null | undefined) {
  return fundSubtype === "redeem" || fundSubtype === "switch_out";
}

export function getInsuranceDetailCategoryName(entry: InsuranceDetailLike) {
  if (entry.source !== "insurance") {
    return (entry.categoryName ?? "").trim();
  }
  return isInsuranceRedeemLike(entry.fundSubtype) ? "保险回款" : "保险支出";
}

export function getInsuranceDetailNote(entry: InsuranceDetailLike) {
  const rawNote = (entry.note ?? "").trim();
  if (entry.source !== "insurance") {
    return rawNote;
  }
  const actionLabel = isInsuranceRedeemLike(entry.fundSubtype) ? "保险赎回" : "保险缴费";
  const taskPrefix = rawNote.includes("计划任务") ? "计划任务：" : "";
  const productName = (entry.fundName ?? "").trim();
  return productName ? `${taskPrefix}${actionLabel}：${productName}` : `${taskPrefix}${actionLabel}`;
}
