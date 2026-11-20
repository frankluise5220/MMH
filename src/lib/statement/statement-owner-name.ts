/**
 * 账单里的持卡人（账户所有人）识别。
 *
 * 各行的写法差异很大，但都落在三类上：
 * - 称呼式：「尊敬的 付斌 先生，您好」「尊敬的付斌先生：」；
 * - 抬头式：「付斌 先生」单独占一行；
 * - 标注式：「持卡人：付斌」「户名：付斌」。
 *
 * 识别结果用于拼账户名（「付斌的农商银行信用卡(2058)」），所以宁可不认，
 * 也不能把「尊敬的客户」当成姓名 —— 那会让整张账单落到一个叫「客户」的账户上。
 */

/** 「尊敬的客户」「尊敬的先生/女士」这类不是姓名，不能当所有人。 */
const STATEMENT_OWNER_NAME_BLOCKLIST = new Set([
  "客户",
  "用户",
  "您",
  "尊敬的",
  "亲爱的",
  "持卡人",
  "本人",
  "会员",
  "先生",
  "女士",
  "小姐",
]);

export function normalizeStatementOwnerName(raw: string | undefined) {
  const compact = String(raw ?? "").replace(/\s+/g, "").replace(/^尊敬(?:的)?/, "");
  if (!compact) return "";
  // 「付斌先生」被贪婪吃进称谓时剥掉；「尊敬的先生」剥完是空，按拒绝处理。
  const name = compact.replace(/(?:先生|女士|小姐)$/, "");
  if (!name || STATEMENT_OWNER_NAME_BLOCKLIST.has(name) || STATEMENT_OWNER_NAME_BLOCKLIST.has(compact)) return "";
  return /^[\u4e00-\u9fa5·]{2,6}$/.test(name) ? name : "";
}

/**
 * 从账单正文里认出持卡人姓名，认不出返回空串。
 * 称谓后面允许直接跟标点 / 您好 / 空白 / 结尾，不能强制要求「您好」两个字。
 */
export function extractStatementOwnerName(plain: string) {
  const text = String(plain ?? "");
  const salutation = text.match(
    /尊敬(?:的)?\s*([\u4e00-\u9fa5·]{2,10}?)\s*(?:(?:先生|女士|小姐)\s*)?(?:[，,：:、]|您好|你好|\s|$)/,
  )?.[1];
  const fromSalutation = normalizeStatementOwnerName(salutation);
  if (fromSalutation) return fromSalutation;

  // 「付斌 先生」只在信件头部找，避免正文里出现的「张三 先生」被当成持卡人。
  const head = text.replace(/\s+/g, " ").trim().slice(0, 600);
  const titled = head.match(
    /(?:^|[\s，,：:；;])([\u4e00-\u9fa5·]{2,6})\s*(?:先生|女士|小姐)(?=$|[\s，,：:；;。！!？?、])/,
  )?.[1];
  const fromTitled = normalizeStatementOwnerName(titled);
  if (fromTitled) return fromTitled;

  const labeled = text.match(/(?:持卡人|卡片所有人|账户所有人|户名)\s*[:：]\s*([\u4e00-\u9fa5·]{2,6})/)?.[1];
  return normalizeStatementOwnerName(labeled);
}
