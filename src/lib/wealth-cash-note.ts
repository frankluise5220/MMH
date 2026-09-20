import { FundSubtype } from "@prisma/client";

function formatUnits(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * 理财动作文案。
 *
 * 债券有自己的文案组（`buildBondCashFlowNote`，在 bond-transactions.ts），
 * 不再借用这里的 isBond 分支——债券已经不走理财链路。
 */
export function wealthActionLabel(action: FundSubtype | string | null | undefined) {
  if (action === FundSubtype.redeem || action === FundSubtype.switch_out) return "理财赎回";
  if (action === FundSubtype.dividend_cash) return "理财分红";
  if (action === FundSubtype.write_off) return "理财核销";
  return "理财买入";
}

export function buildWealthCashFlowNote(input: {
  action: FundSubtype | string | null | undefined;
  productName?: string | null;
  units?: number | null;
  userNote?: string | null;
}) {
  const parts = [wealthActionLabel(input.action)];
  const productName = input.productName?.trim();
  const unitsText = formatUnits(input.units);
  if (productName) parts.push(productName);
  if (unitsText) parts.push(`份额 ${unitsText}`);

  const summary = parts.join(" ");
  const userNote = input.userNote?.trim();
  return userNote ? `${summary}；${userNote}` : summary;
}
