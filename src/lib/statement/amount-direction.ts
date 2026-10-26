export type SignedAmountInflowSign = "positive" | "negative";
type MoneyDirection = "in" | "out";

const TOKEN_SEPARATOR = "[\\s/\\\\|,.;:(){}\\-_+\\u3000\\uff0c\\u3001\\uff1b\\uff1a\\uff08\\uff09\\u3010\\u3011]";
const STANDALONE_REPAYMENT_RE = new RegExp(
  `(?:^|${TOKEN_SEPARATOR})\\u8fd8\\u6b3e(?:$|${TOKEN_SEPARATOR})`,
  "i",
);
const STANDALONE_PAYMENT_RE = /^\s*payment\s*$/i;
const EXPLICIT_REPAYMENT_RE =
  /\u94f6\u8054\u5165\u8d26|\u94f6\u8054\u8f6c\u8d26|\u4ed8\u6b3e\u5c3e\u53f7|\u6263\u6b3e\u5c3e\u53f7|\u8fd8\u6b3e\u5c3e\u53f7|\u81ea\u52a8\u8fd8\u6b3e|\u81ea\u52a8\u6263\u6b3e|\u4fe1\u7528\u5361\u8fd8\u6b3e|\u8fd8\u6b3e\u5165\u8d26|\u8fd8\u6b3e\u6210\u529f|\u6210\u529f\u8fd8\u6b3e|\u5df2\u8fd8\u6b3e|repayment|autopay|auto\s*pay|automatic\s+payment|payment\s+(?:received|posted|made|credited)|payment\s*[-\u2013\u2014]\s*thank\s+you|thank\s+you(?:\s+for)?(?:\s+your)?\s+payment/i;

export function isCreditCardRepaymentLikeText(text: string) {
  const normalized = String(text ?? "");
  return EXPLICIT_REPAYMENT_RE.test(normalized) ||
    STANDALONE_REPAYMENT_RE.test(normalized) ||
    STANDALONE_PAYMENT_RE.test(normalized);
}

export function isExpenseRefundLikeText(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (isCreditCardRepaymentLikeText(normalized)) return false;
  return /\u9000\u6b3e|\u9000\u8d27|\u9000\u56de|\u6d88\u8d39\u64a4\u9500|\u4ea4\u6613\u64a4\u9500|\u51b2\u6b63|\u64a4\u9500|Refund|Return|Reversal/i.test(normalized);
}

export function isCreditCardCreditAdjustmentLikeText(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (isCreditCardRepaymentLikeText(normalized)) return false;
  return /\u5237\u5361\u91d1|\u62b5\u6263|\u51b2\u62b5|\u51cf\u514d|\u4f18\u60e0|\u8fd4\u73b0|\u9000\u6b3e|\u9000\u8d27|\u9000\u56de|\u64a4\u9500|\u51b2\u6b63|\u5206\u671f\u8f6c\u5206\u671f\u4ed8\u6b3e|Credit|Refund|Return|Reversal/i.test(normalized);
}

function isDefiniteCreditCardInflowText(text: string) {
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

type SignedAmountBalanceSample = {
  amount: number | null | undefined;
  /** 该行交易后的账户余额（余额列）；非流水余额列（额度/可用余额）会被差额校验过滤掉 */
  balance: number | null | undefined;
};

/**
 * 用「余额」列的相邻行差额反推「金额正负号 → 收支方向」的写法约定。
 *
 * 借记卡流水通常 正数=收入、负数=支出；信用卡流水通常 正数=支出、负数=还款入账。
 * 只靠关键词（还款/退款/入账）判断时，没有这些字样的借记卡流水会被套用信用卡口径而整体反向
 * （招商银行借记卡流水即如此：正数=转入/工资/汇入，负数=快捷支付/转账汇款/基金申购）。
 * 余额差额是流水事实，与文案无关，故优先于关键词推断。
 *
 * 只统计 |余额差额| ≈ |金额| 的相邻行对（升序按下一行匹配，降序按本行匹配），
 * 因此「余额」列若不是逐笔流水余额，差额对不上金额时不会投票。
 */
export function inferBalanceBasedInflowSign(
  samples: readonly SignedAmountBalanceSample[],
): SignedAmountInflowSign | null {
  let positiveInflowVotes = 0;
  let negativeInflowVotes = 0;
  const tolerance = 0.011;
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const current = samples[index];
    const next = samples[index + 1];
    const currentBalance = Number(current?.balance ?? NaN);
    const nextBalance = Number(next?.balance ?? NaN);
    if (!Number.isFinite(currentBalance) || !Number.isFinite(nextBalance)) continue;
    const rawDelta = nextBalance - currentBalance;
    if (Math.abs(rawDelta) < 0.005) continue;
    const currentAmount = Number(current?.amount ?? 0);
    const nextAmount = Number(next?.amount ?? 0);
    const matchesNextRow = Number.isFinite(nextAmount) && nextAmount !== 0
      && Math.abs(Math.abs(nextAmount) - Math.abs(rawDelta)) <= tolerance;
    const matchesCurrentRow = Number.isFinite(currentAmount) && currentAmount !== 0
      && Math.abs(Math.abs(currentAmount) - Math.abs(rawDelta)) <= tolerance;
    if (!matchesNextRow && !matchesCurrentRow) continue;
    // 升序：下一行金额即余额差额；降序（最新在前）：本行金额对应本次余额变化。
    const pairedAmount = matchesNextRow ? nextAmount : currentAmount;
    const pairedDelta = matchesNextRow ? rawDelta : -rawDelta;
    if (pairedAmount === 0 || pairedDelta === 0) continue;
    if ((pairedAmount > 0) === (pairedDelta > 0)) positiveInflowVotes += 1;
    else negativeInflowVotes += 1;
  }
  if (positiveInflowVotes + negativeInflowVotes < 2) return null;
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
