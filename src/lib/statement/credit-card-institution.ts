/**
 * 账单里的发卡行识别。
 *
 * 三处入口（通用/专有 HTML 模板解析、AI 导入、导入账户名匹配）必须给出同一个
 * 机构名，否则同一张卡会因为账单换了个写法而反复新建账户：
 * - 农商体系：全国上百家行社（XX农村商业银行 / XX农商银行 / XX农村信用社 /
 *   江苏农信 …）在账本里一律记作「农商银行」。
 * - 「信用卡 / 贷记卡」不是机构名：账单常只写「XX银行信用卡」，把「信用卡」
 *   当机构名会拼出「信用卡信用卡」。
 */

/** 账本里农商体系的统一机构名。 */
export const RURAL_BANK_CANONICAL_NAME = "农商银行";

// 只收「农村商业银行 / 农商银行 / 农村信用社 / 江苏农信」这几类明确写法。
// 单独的「农商」不算：账本里可能存在「江苏农商联合银行」这类独立法人，
// 把它并进「农商银行」反而会让既有账户对不上。
const RURAL_BANK_NAME_RE = /农村商业银行|农商银行|农村合作银行|农村信用社|农信社|农商行|农信/;

/** 文本是否属于农商体系（农村商业银行 / 农商银行 / 农村信用社 / 江苏农信 …）。 */
export function isRuralBankName(value: string | null | undefined) {
  return RURAL_BANK_NAME_RE.test(String(value ?? "").replace(/\s+/g, ""));
}

/**
 * 白名单只用来给出「正式全称」：账单里常写简称（招行/工行），
 * 白名单外的银行交给 alias 阶段与农商归一处理。
 * 「江苏农信 / 江苏农村商业银行」刻意不在表里 —— 它们走农商归一。
 */
const BANK_NAMES = [
  "兴业银行",
  "浦发银行",
  "平安银行",
  "邮储银行",
  "中国邮政储蓄银行",
  "江苏银行",
  "工商银行",
  "农业银行",
  "中国银行",
  "建设银行",
  "交通银行",
  "招商银行",
  "中信银行",
  "民生银行",
  "光大银行",
  "广发银行",
  "华夏银行",
];

/** 从账单文本里认出机构名，认不出返回空串。 */
export function detectStatementBankName(text: string) {
  const normalized = String(text ?? "").replace(/\s+/g, "");
  // 农商体系必须排在白名单之前判定：「江苏农村商业银行」「江苏农信」一旦先命中
  // 机构名，就会带着省名进账本，和既有「农商银行」账户对不上。
  if (RURAL_BANK_NAME_RE.test(normalized)) return RURAL_BANK_CANONICAL_NAME;
  const found = BANK_NAMES.find((name) => normalized.includes(name));
  if (found === "中国邮政储蓄银行") return "邮储银行";
  if (found) return found;
  // 有些账单只写「平安信用卡」「中信信用卡」，通篇没有「银行」二字；把
  // 「信用卡/贷记卡」当「银行」再比一次，否则整张账单的机构名都是空的。
  const aliasText = normalized.replace(/(?:银行)?信用卡|贷记卡/g, "银行");
  // 「江苏农商信用卡」这类写法只有把「信用卡」换成「银行」后才露出「农商银行」。
  if (RURAL_BANK_NAME_RE.test(aliasText)) return RURAL_BANK_CANONICAL_NAME;
  const aliasFound = BANK_NAMES.find((name) => aliasText.includes(name));
  if (aliasFound === "中国邮政储蓄银行") return "邮储银行";
  if (aliasFound) return aliasFound;
  return "";
}
