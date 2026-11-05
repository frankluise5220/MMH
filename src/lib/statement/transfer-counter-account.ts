import { parseImportPaymentCardAccount, parseSettlementAccountName } from "@/lib/account-import-match";

/** 原文对向账户列已经是「账户」口径（往来款 / 银行卡 / 账户尾号）时，不能改写成「X的往来款」。 */
const ACCOUNT_LIKE_SUFFIX_RE = /(?:往来款|应收款|应付款|普通应收款|普通应付款|往来帐|往来账|信用卡|贷记卡|储蓄卡|借记卡|一卡通|银行卡|账户|帐户|账号|帐号)\s*$/;

/**
 * 把「收支大类」改成转账时，按原文「对向账户 / 对方账户 / 交易对象」列建议对向账户名。
 *
 * 非转账行不参与导入，原文对向账户列里的人和账户本来会被丢掉（`rawCounterAccount` 保真），
 * 用户改成转账后必须能据此回填，否则状态只会停在「缺对向账户」。
 *
 * 口径与往来款一致：
 * - 原文已是「X的往来款 / X的应收款」→ 原样使用；
 * - 原文看起来是账户（「招商银行储蓄卡(9447)」「支付宝余额宝」里的卡号账户）→ 原样使用；
 * - 其余（人名 / 商户名）→「<交易对象>的往来款」。
 */
export function suggestTransferCounterAccountName(raw?: string | null): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (ACCOUNT_LIKE_SUFFIX_RE.test(text)) return text;
  if (parseSettlementAccountName(text)) return text;
  if (parseImportPaymentCardAccount(text)) return text;
  return `${text}的往来款`;
}
