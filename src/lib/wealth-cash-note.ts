import { FundSubtype } from "@prisma/client";

function formatUnits(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * 理财动作文案。城投债（WealthProduct.productType="bond"）走独立文案组，
 * 调用方有产品上下文时传 isBond；没有时回退理财通用文案。
 */
export function wealthActionLabel(
  action: FundSubtype | string | null | undefined,
  isBond?: boolean,
) {
  if (action === FundSubtype.redeem || action === FundSubtype.switch_out) return isBond ? "城投债赎回" : "理财赎回";
  if (action === FundSubtype.dividend_cash) return isBond ? "城投债利息" : "理财分红";
  if (action === FundSubtype.write_off) return isBond ? "城投债核销" : "理财核销";
  return isBond ? "城投债买入" : "理财买入";
}

export function buildWealthCashFlowNote(input: {
  action: FundSubtype | string | null | undefined;
  productName?: string | null;
  units?: number | null;
  userNote?: string | null;
  isBond?: boolean;
}) {
  const parts = [wealthActionLabel(input.action, input.isBond)];
  const productName = input.productName?.trim();
  const unitsText = formatUnits(input.units);
  if (productName) parts.push(productName);
  if (unitsText) parts.push(`份额 ${unitsText}`);

  const summary = parts.join(" ");
  const userNote = input.userNote?.trim();
  return userNote ? `${summary}；${userNote}` : summary;
}
