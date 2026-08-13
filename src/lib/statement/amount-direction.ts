export type SignedAmountInflowSign = "positive" | "negative";
export type MoneyDirection = "in" | "out";

export function isCreditCardRepaymentLikeText(text: string) {
  return /银联入账|银联转账|付款尾号|扣款尾号|还款尾号|自动还款|自动扣款|信用卡还款|还款入账|还款|repayment|payment|autopay/i.test(String(text ?? ""));
}

export function isExpenseRefundLikeText(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (isCreditCardRepaymentLikeText(normalized)) return false;
  return /退款|退货|退回|消费撤销|交易撤销|冲正|撤销|Refund|Return|Reversal/i.test(normalized);
}

export function isCreditCardCreditAdjustmentLikeText(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (isCreditCardRepaymentLikeText(normalized)) return false;
  return /刷卡金|抵扣|冲抵|减免|优惠|返现|退款|退货|退回|撤销|冲正|分期转分期付款|Credit|Refund|Return|Reversal/i.test(normalized);
}

export function isDefiniteCreditCardInflowText(text: string) {
  return isCreditCardRepaymentLikeText(text) ||
    isExpenseRefundLikeText(text) ||
    isCreditCardCreditAdjustmentLikeText(text);
}

export function inferSignedAmountInflowSign(
  samples: Array<{ amount: number | null | undefined; text: string; definiteInflow?: boolean }>,
): SignedAmountInflowSign | null {
  let positiveInflowVotes = 0;
  let negativeInflowVotes = 0;
  for (const sample of samples) {
    const amount = Number(sample.amount ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const definiteInflow = sample.definiteInflow ?? isDefiniteCreditCardInflowText(sample.text);
    if (!definiteInflow) continue;
    if (amount > 0) positiveInflowVotes += 1;
    if (amount < 0) negativeInflowVotes += 1;
  }
  if (positiveInflowVotes === negativeInflowVotes) return null;
  return positiveInflowVotes > negativeInflowVotes ? "positive" : "negative";
}

export function signedAmountDirection(
  amount: number | null | undefined,
  inflowSign: SignedAmountInflowSign | null,
  fallbackInflowSign: SignedAmountInflowSign = "negative",
): MoneyDirection | null {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value) || value === 0) return null;
  const sign = inflowSign ?? fallbackInflowSign;
  if (sign === "positive") return value > 0 ? "in" : "out";
  return value < 0 ? "in" : "out";
}
