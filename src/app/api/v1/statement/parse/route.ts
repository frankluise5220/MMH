import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { normalizeCurrency } from "@/lib/currency";
import {
  SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE,
  matchStatementHeaderProfile,
  type SpdbCreditCardTransactionField,
} from "@/lib/statement/header-catalog";
import {
  inferSignedAmountInflowSign,
  isCreditCardCreditAdjustmentLikeText,
  isCreditCardRepaymentLikeText,
  isExpenseRefundLikeText,
  signedAmountDirection,
  type SignedAmountInflowSign,
} from "@/lib/statement/amount-direction";
import {
  alignStatementIncomeRefunds,
  alignStatementRecognitionToLedger,
  enrichKnownStatementMerchantForImport,
  type StatementHistoricalCategorySample,
} from "@/lib/statement/import-normalization";
import { loadStatementRecognitionRuleSamples } from "@/lib/statement/recognition-rules";

export const runtime = "nodejs";

type ParsedItemMeta = {
  institutionName?: string;
  ownerName?: string;
  cardNumberMasked?: string;
  statementCurrency?: string;
  minimumPayment?: number;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
  statementAmount?: number;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDueDate?: string;
};

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  outflow?: number;
  inflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
  institution?: string;
  postedDate?: string;
  currency?: string;
  _meta?: ParsedItemMeta;
};

const ALIAS_PATTERNS: Array<{ pattern: RegExp; counterparty: string; category?: string; institution?: string }> = [
  { pattern: /江苏云快充|云快充|新能源.*充电|充电桩/, counterparty: "江苏云快充新能源科技有限公司", category: "充电" },
  { pattern: /支付宝[^-]*-?(.*)/, counterparty: "支付宝", institution: "支付宝", category: "购物" },
  { pattern: /财付通[^-]*-?(.*)/, counterparty: "微信支付", institution: "微信", category: "购物" },
  { pattern: /微信支付/, counterparty: "微信支付", institution: "微信", category: "购物" },
  { pattern: /美团外卖/, counterparty: "美团外卖", institution: "美团", category: "餐饮" },
  { pattern: /(?:特约)?美团(?:平台)?商户?|美团/, counterparty: "美团", institution: "美团", category: "餐饮" },
  { pattern: /大众点评/, counterparty: "大众点评", institution: "大众点评", category: "餐饮" },
  { pattern: /饿了么/, counterparty: "饿了么", institution: "饿了么", category: "餐饮" },
  { pattern: /携程/, counterparty: "携程", institution: "携程", category: "旅游" },
  { pattern: /滴滴出行|打车/, counterparty: "滴滴出行", institution: "滴滴出行", category: "交通" },
  { pattern: /地铁|公交/, counterparty: "公共交通", category: "交通" },
  { pattern: /中国铁路|铁路网络|12306|火车票|高铁票|铁路/, counterparty: "中国铁路", institution: "中国铁路", category: "火车高铁" },
  { pattern: /停车场|停车费|停车/, counterparty: "停车场", category: "停车费" },
  { pattern: /移动|联通|电信/, counterparty: "运营商", category: "通讯" },
  { pattern: /拼多多|付费通/, counterparty: "拼多多", institution: "拼多多", category: "购物" },
  { pattern: /(水费|电费|水电费|燃气费|天然气|暖气费|供水|供电|供气|自来水|燃气公司|电力公司)/, counterparty: "水电燃气", category: "生活缴费" },
  { pattern: /(物业|管理费)/, counterparty: "物业", category: "居住" },
  { pattern: /京东(到家)?|网银在线/, counterparty: "京东", institution: "京东", category: "购物" },
  { pattern: /天猫|淘宝/, counterparty: "淘宝/天猫", institution: "淘宝/天猫", category: "购物" },
  { pattern: /盒马/, counterparty: "盒马鲜生", institution: "盒马鲜生", category: "餐饮" },
  { pattern: /(永辉|沃尔玛|家乐福|大润发)/, counterparty: "超市", category: "购物" },
  { pattern: /(顺丰|圆通|中通|韵达|申通|邮政)/, counterparty: "快递", category: "购物" },
  { pattern: /(医保|社保|药店)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(医院|诊所|挂号)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(学费|培训|教育)/, counterparty: "教育", category: "教育" },
  { pattern: /(会员|订阅|自动续费)/, counterparty: "会员", category: "娱乐" },
  { pattern: /(爱奇艺|腾讯视频|优酷|哔哩)/, counterparty: "视频会员", category: "娱乐" },
  { pattern: /嘟嘟抓饭|抓饭/, counterparty: "嘟嘟抓饭", category: "餐饮" },
  { pattern: /食品|生鲜|粮油|零食/, counterparty: "食品", category: "食品" },
  { pattern: /(星巴克|瑞幸|喜茶|奈雪)/, counterparty: "咖啡茶饮", category: "餐饮" },
  { pattern: /(麦当劳|肯德基|汉堡王)/, counterparty: "快餐", category: "餐饮" },
  { pattern: /云闪付/, counterparty: "云闪付", institution: "云闪付" },
];

function cleanupMerchantName(value: string) {
  return value
    .replace(/^[-—\s]+/, "")
    .replace(/[（(]\s*入账日\s*\d{4}[-\/.年]\d{1,2}[-\/.月]\d{1,2}\s*[)）]/g, "")
    .replace(/[（(]\s*特约\s*[)）]/g, "")
    .replace(/^(快捷|平台商户|商户)+[-—\s]*/, "")
    .replace(/^支付[-—\s]+/, "")
    .trim();
}

function extractMerchant(text: string) {
  const split = text.split(/--|－|—/).map((item) => item.trim()).filter(Boolean);
  if (split.length >= 2) return cleanupMerchantName(split.slice(1).join("-"));
  const jd = text.match(/京东支付[-—]?(.+)/);
  if (jd?.[1]) return cleanupMerchantName(jd[1]);
  return "";
}

function extractPaymentPrefix(text: string) {
  return cleanupMerchantName(text.split(/--|－|—/)[0] ?? "");
}

function inferInstitutionFromPrefix(text: string) {
  const prefix = extractPaymentPrefix(text);
  if (/拼多多|付费通/.test(prefix)) return "拼多多";
  if (/支付宝/.test(prefix)) return "支付宝";
  if (/财付通|微信支付|微信/.test(prefix)) return "微信";
  if (/京东|网银在线/.test(prefix)) return "京东";
  if (/美团/.test(prefix)) return "美团";
  if (/云闪付|银联/.test(prefix)) return "云闪付";
  if (/淘宝|天猫/.test(prefix)) return "淘宝/天猫";
  return "";
}

function inferCategoryFromRemark(text: string) {
  const remark = cleanupMerchantName(extractMerchant(text) || text);
  if (!remark) return "";
  if (/国网|国家电网|电力|电费|水费|水电费|燃气费|天然气|暖气费|供水|供电|供气|自来水|燃气公司|电力公司/.test(remark)) return "水电燃气";
  if (/年费|账户管理费|银行卡费|信用卡费|制卡费/.test(remark)) return "银行费用";
  if (/嘟嘟抓饭|抓饭|外卖|餐饮|饭店|餐厅|食堂|小吃|火锅|烧烤|咖啡|茶饮|奶茶|美食/.test(remark)) return "餐饮";
  if (/快递|顺丰|圆通|中通|韵达|申通|邮政|取件|寄件/.test(remark)) return "快递";
  if (/停车场|停车费|停车/.test(remark)) return "停车费";
  if (/中国铁路|铁路网络|12306|火车票|高铁票|铁路/.test(remark)) return "火车高铁";
  if (/江苏云快充|云快充|新能源.*充电|充电桩|充电站/.test(remark)) return "充电";
  if (/食品|生鲜|粮油|零食|食材|水果|蔬菜|肉类|熟食/.test(remark)) return "食品";
  if (/车品|汽车用品|汽配|轮胎|机油|洗车|加油|ETC/.test(remark)) return "车品";
  if (/数码|电子|电脑|手机|通讯器材|电器|配件|电工/.test(remark)) return "数码";
  return "";
}

function aliasMatch(text: string): { counterparty: string; category: string; institution: string } {
  const normalizedText = cleanupMerchantName(text).replace(/特约商户?/g, "").trim();
  const prefixInstitution = inferInstitutionFromPrefix(normalizedText);
  const remarkCategory = inferCategoryFromRemark(normalizedText);
  for (const { pattern, counterparty, category, institution } of ALIAS_PATTERNS) {
    const matchText = pattern.test(normalizedText) ? normalizedText : text;
    if (pattern.test(matchText)) {
      const m = matchText.match(pattern);
      const extra = cleanupMerchantName(extractMerchant(matchText) || (m && m[1] ? m[1].trim() : ""));
      return {
        counterparty: extra || counterparty,
        category: remarkCategory || category || "",
        institution: prefixInstitution || institution || counterparty,
      };
    }
  }
  return { counterparty: "", category: remarkCategory, institution: prefixInstitution };
}

function isNoiseLine(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (isStatementSummaryText(l)) return true;
  if (/^<\/?(?:td|tr|table|tbody|thead|img|a|span|div)\b/i.test(l)) return true;
  if (/^https?:\/\//i.test(l) || /\b(?:href|src)=["']?https?:\/\//i.test(l)) return true;
  if (/^(?:alt|target|style|class|width|height|border)=/i.test(l)) return true;
  if (/^(账户信息|账单信息|交易明细|消费明细|还款明细|积分明细|银行名称|卡号后四位)/i.test(l)) return true;
  if (/^(本期账单日|账单日|还款日|信用额度|取现额度|账单周期)/i.test(l)) return true;
  if (/^(主卡|副卡|Main Card)/i.test(l)) return true;
  if (/^(New Balance|Previous Balance|自动还款|扣款账号|Debit Account)/i.test(l)) return true;
  if (/^(本期应还|本期余额|最低还款|积分|利息|手续费)/i.test(l)) return true;
  if (/^(合计|Summary|Total|小计)/i.test(l)) return true;
  if (/^¥?\s*[\d,]+\.?\d*\s*(¥|元|$|美元)?$/i.test(l) && l.length < 25) return true;
  if (/^[—\-=:|]{3,}$/.test(l)) return true;
  if (/^(交易日期|记账日期|交易说明|金额|类型|备注)/i.test(l)) return true;
  if (/^\d{4}[-\/.年]\d{1,2}[-\/.月]\d{1,2}(?:日)?$/.test(l)) return true;
  if (/^(\d{4})[-\/.]?\s*(\d{1,2})[-\/.]?\s*(\d{1,2})[\s-]*\d{4}$/.test(l)) return true;
  if (/^USD|RMB|外币|美元|港币/i.test(l) && !/\d/.test(l.slice(4))) return true;
  return false;
}

function isStatementSummaryText(text: string): boolean {
  const normalized = stripHtml(text);
  return /(本期应缴余额|上期账单余额|已还金额|本期账单金额|本期调整金额|循环利息|本期应还款总额|本期最低还款额|最低还款额|固定额度|预借现金额度|账单周期|到期还款日|分期未还总金额|账单说明|New Balance|Previous Balance|Payment\s*&\s*Credit|New Activity|Adjustment|Finance Charge|Minimum Payment|Credit Limit|Cash Advance Limit|Statement Cycle|Payment Due Date|Bonus Point Balance|Previous Bonus Point|Statement description)/i.test(normalized);
}

function extractAmount(text: string): number {
  const nums = text.match(/[\d,]+\.?\d*/g) ?? [];
  let best = 0;
  for (const s of nums) {
    const v = parseFloat(s.replace(/,/g, ""));
    if (!Number.isFinite(v) || v <= 0) continue;
    best = v;
  }
  return best;
}

function extractDate(line: string): string | undefined {
  const m = line.match(/\b(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})\b/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  const compact = line.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (!compact) return undefined;
  return `${compact[1]}-${compact[2]}-${compact[3]}`;
}

function normalizeDateTimeCell(value?: string): string | undefined {
  const raw = String(value ?? "").trim().replace(/\s+/g, " ");
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const match = compact ?? raw.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日)?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return undefined;
  const ymd = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  if (!match[4]) return ymd;
  const time = `${match[4].padStart(2, "0")}:${match[5]}${match[6] ? `:${match[6]}` : ""}`;
  return `${ymd} ${time}`;
}

function isLikelyTransfer(text: string): boolean {
  return /转账|还款|转入|转出|汇款|充值|提现|银联入账|付款尾号|扣款尾号|还款尾号|自动扣款/i.test(text);
}

function extractPaymentTail(text: string) {
  const source = String(text ?? "");
  const explicitTail = source.match(/(?:(付款|扣款|还款))?尾号[:：]?\s*(\d{2,8})/);
  if (explicitTail) {
    if (explicitTail[1]) return explicitTail[2];
    const matchIndex = explicitTail.index ?? 0;
    const prefix = source.slice(Math.max(0, matchIndex - 12), matchIndex);
    if (!/信用卡|贷记卡|卡号|末四位|后四位/.test(prefix)) return explicitTail[2];
  }

  const sourceTail = source.match(/(?:银联(?:入账|转账|代扣|支付)?|云闪付|自动(?:扣款|还款)|付款|扣款|还款|转账|代扣)[^\d]{0,18}(\d{4})(?![\d.])/);
  if (sourceTail) return sourceTail[1];

  const leadingTail = source.match(/(?:^|[^\d])(\d{4})(?![\d.])[^\d]{0,18}(?:银联(?:入账|转账|代扣|支付)?|云闪付|自动(?:扣款|还款)|付款|扣款|还款|转账|代扣)/);
  return leadingTail?.[1] ?? "";
}

function paymentTailAccountName(text: string) {
  const tail = extractPaymentTail(text);
  if (!tail) return "";
  return /银联入账|银联转账|银联代扣|银联支付|云闪付/i.test(text) ? `银联入账尾号${tail}` : `尾号${tail}`;
}

function isCreditCardRepaymentLike(text: string) {
  return isCreditCardRepaymentLikeText(text);
}

function isExpenseRefundLike(text: string) {
  return isExpenseRefundLikeText(text);
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&yen;/gi, "¥")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToLooseText(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<a\b[\s\S]*?<\/a>/gi, "\n")
    .replace(/<img\b[^>]*>/gi, "\n")
    .replace(/<\/(?:td|th|tr|p|div|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function extractTableCells(rowHtml: string) {
  return [...rowHtml.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
    .map((match) => stripHtml(match[1]));
}

function parseMoney(value: string) {
  const normalized = value
    .replace(/,/g, "")
    .replace(/&yen;|[￥¥]/gi, "")
    .replace(/\/?\s*\b(?:RMB|CNY|USD|HKD)\b/gi, "")
    .replace(/[（(]\s*(?:支出|存入|收入|转入|转出)\s*[）)]/g, "")
    .replace(/人民币|美元|港币|元/g, "")
    .trim();
  if (normalizeDateTimeCell(normalized)) return null;
  const bracket = normalized.match(/^\((\d+(?:\.\d{1,2})?)\)$/);
  const signed = bracket ? `-${bracket[1]}` : normalized.match(/^[+-]?\d+(?:\.\d{1,2})?$/)?.[0];
  if (!signed) return null;
  const amount = Number(signed);
  return Number.isFinite(amount) ? amount : null;
}

function isDateLikeCell(value?: string) {
  return Boolean(normalizeDateTimeCell(value));
}

function findAmountCell(cells: string[]) {
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i]?.trim() ?? "";
    if (!cell || isDateLikeCell(cell)) continue;
    if (/^\d{4}$/.test(cell)) continue;
    const amount = parseMoney(cell);
    if (amount !== null && amount !== 0) return { index: i, amount, raw: cell };
  }
  return null;
}

function findDescriptionCell(cells: string[], usedIndexes: Set<number>) {
  const candidates = cells
    .map((cell, index) => ({ index, text: cleanupMerchantName(cell.trim()) }))
    .filter(({ index, text }) =>
      text &&
      !usedIndexes.has(index) &&
      !isDateLikeCell(text) &&
      parseMoney(text) === null &&
      !/^(交易日期|记账日期|入账日期|交易日|记账日|摘要|交易摘要|交易说明|金额|人民币金额|交易金额)$/i.test(text)
    );
  return candidates.sort((a, b) => b.text.length - a.text.length)[0]?.text ?? "";
}

function parseLooseNumber(value?: string) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const valueNumber = Number(match[0]);
  return Number.isFinite(valueNumber) ? valueNumber : undefined;
}

function isStatementAmountNoiseContext(value: string) {
  return /(积分|Bonus\s*Points?|Reward\s*Points?|Points?\b|Rewards?\b)/i.test(value);
}

function extractMoneyAfterLabels(
  text: string,
  labels: string[],
  options?: { rejectContext?: (context: string) => boolean },
) {
  const normalized = stripHtml(text);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}((?:\\s|[A-Za-z/()（）&-]){0,80})(?:人民币|RMB|CNY|￥|¥)?\\s*(-?[\\d,]+(?:\\.\\d+)?)`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      const suffix = normalized.slice(pattern.lastIndex, pattern.lastIndex + 12).match(/^[ \t\u00a0]*(?:积分|Bonus\s*Points?|Reward\s*Points?|Points?\b|Rewards?\b)/i)?.[0] ?? "";
      const context = `${label}${match[1] ?? ""}${match[2] ?? ""}${suffix}`;
      if (options?.rejectContext?.(context)) continue;
      const amount = parseLooseNumber(match[2]);
      if (amount !== undefined) return amount;
    }
  }
  return undefined;
}

function extractDateAfterLabels(text: string, labels: string[]) {
  const normalized = stripHtml(text);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = normalized.match(new RegExp(`${escaped}(?:\\s|[A-Za-z/()（）&-]){0,80}(\\d{4}[年\\/\\-.]\\d{1,2}[月\\/\\-.]\\d{1,2})`, "i"));
    const parts = parseDateParts(match?.[1] ?? "");
    if (parts) return parts;
  }
  return null;
}

function extractStatementAmount(text: string) {
  return extractMoneyAfterLabels(text, [
    "本期应还款金额",
    "本期应还款总额",
    "本期应还款",
    "本期应缴余额",
    "本期应还",
    "本期余额",
    "本期账单金额",
    "New Balance",
    "Total Due",
  ], { rejectContext: isStatementAmountNoiseContext });
}

function extractCreditLimit(text: string) {
  const normalized = stripHtml(text);
  const labels = [
    "总授信额度",
    "总信用额度",
    "信用额度",
    "固定额度",
    "Credit Limit",
  ];

  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "gi");
    while (pattern.exec(normalized) !== null) {
      const afterLabel = normalized
        .slice(pattern.lastIndex, pattern.lastIndex + 240)
        .split(/本\s*期\s*交\s*易\s*汇\s*总|本\s*期\s*交\s*易\s*明\s*细|交易明细|工银i豆/i)[0] ?? "";
      const candidates = [...afterLabel.matchAll(/-?[\d,]+(?:\.\d+)?(?:\s*\/\s*(?:RMB|CNY|USD|HKD))?/gi)]
        .map((item) => parseMoney(item[0]) ?? parseLooseNumber(item[0]))
        .filter((amount): amount is number => amount !== undefined && amount >= 1000);
      if (candidates.length > 0) return candidates[0];
    }
  }

  return undefined;
}

function parseDateParts(value?: string) {
  const match = String(value ?? "").match(/(\d{4})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    ymd: `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`,
  };
}

type StatementDateParts = NonNullable<ReturnType<typeof parseDateParts>>;

function ymdFromParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDaysToYmd(ymd: string | undefined, days: number) {
  if (!ymd) return undefined;
  const parts = parseDateParts(ymd);
  if (!parts) return undefined;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function dateSerial(parts: StatementDateParts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function extractStatementPeriod(text: string) {
  const plain = stripHtml(text);
  const match = plain.match(/(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})日?\s*[-~至—]\s*(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})日?/);
  const start = parseDateParts(match?.[1] ?? "");
  const end = parseDateParts(match?.[2] ?? "");
  return start && end ? { start, end } : null;
}

function normalizeStatementMonthDayCell(value?: string, period?: ReturnType<typeof extractStatementPeriod>) {
  const fullDate = normalizeDateTimeCell(value);
  if (fullDate) return fullDate;

  const match = String(value ?? "").trim().replace(/\s+/g, "").match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
  if (!match) return undefined;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!period) return undefined;

  const startSerial = dateSerial(period.start);
  const endSerial = dateSerial(period.end);
  const candidateYears = Array.from(new Set([
    period.start.year,
    period.end.year,
    period.start.year - 1,
    period.end.year + 1,
  ]));

  for (const year of candidateYears) {
    const ymd = ymdFromParts(year, month, day);
    if (!ymd) continue;
    const serial = Date.UTC(year, month - 1, day);
    if (serial >= startSerial && serial <= endSerial) return ymd;
  }

  return ymdFromParts(period.end.year, month, day);
}

const BANK_NAMES = [
  "兴业银行",
  "浦发银行",
  "平安银行",
  "邮储银行",
  "中国邮政储蓄银行",
  "江苏农信",
  "江苏农村商业银行",
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

function detectBankName(text: string) {
  const normalized = text.replace(/\s+/g, "");
  const found = BANK_NAMES.find((name) => normalized.includes(name));
  if (found === "中国邮政储蓄银行") return "邮储银行";
  return found ?? "";
}

function extractStatementAccountHeader(rowText: string, fallbackInstitutionName?: string) {
  const normalized = rowText.replace(/\s+/g, " ").trim();
  if (!/(?:主卡|副卡|Main Card|Supplementary Card|合计)/i.test(normalized)) return null;

  const match = normalized.match(/([\u4e00-\u9fa5A-Za-z0-9·\s]{2,48}?卡)\s*[（(](\d{4})[）)]/);
  if (!match) return null;

  const cardTitle = match[1].replace(/\s+/g, "").trim();
  const cardNumberMasked = match[2];
  const institutionName = detectBankName(cardTitle) || String(fallbackInstitutionName ?? "").trim();
  return {
    accountName: `${cardTitle}（${cardNumberMasked}）`,
    institutionName: institutionName || undefined,
    cardNumberMasked,
  };
}

function isDebitOrRepaymentAccountContext(value: string) {
  return /扣款账号|扣款账户|还款账号|还款账户|自动还款|代扣|借记卡|储蓄卡|Debit\s*Account|Debit\s*Card|Payment\s*Account/i.test(value);
}

function extractCreditCardLast4(text: string, fallbackInstitutionName?: string) {
  const sourceText = /<[^>]+>/.test(text) ? htmlToLooseText(text) : stripHtml(text);
  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    const header = extractStatementAccountHeader(line, fallbackInstitutionName);
    if (header?.cardNumberMasked) return header.cardNumberMasked;
  }

  for (const line of lines) {
    if (isDebitOrRepaymentAccountContext(line)) continue;
    if (!/信用卡|贷记卡|主卡|副卡|Credit\s*Card|Card\s*No/i.test(line)) continue;
    const match = line.match(/(?:\*{2,}|x{2,}|X{2,}|[（(])?\s*(\d{4})\s*[）)]?/);
    if (match) return match[1];
  }

  for (const line of lines) {
    if (isDebitOrRepaymentAccountContext(line)) continue;
    const match = line.match(/(?:卡号末四位|卡号后四位|末四位|卡号)[^\d]{0,12}(?:\*{2,}|x{2,}|X{2,})?(\d{4})/);
    if (match) return match[1];
  }

  return "";
}

function extractCreditCardMeta(text: string): ParsedItemMeta & { accountName?: string } {
  const plain = stripHtml(text);
  const institutionName = detectBankName(plain);
  const ownerName = plain.match(/尊敬的\s*([\u4e00-\u9fa5·]{2,8})\s*(?:先生|女士|小姐)?\s*您好/)?.[1]?.trim();
  const cardNumberMasked = extractCreditCardLast4(text, institutionName);
  const creditLimit = extractCreditLimit(plain);
  const periodMatch = plain.match(/(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})日?\s*[-~至—]\s*(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})日?/);
  const periodStart = parseDateParts(periodMatch?.[1] ?? "");
  const periodEnd = parseDateParts(periodMatch?.[2] ?? "");
  const directBillingDay = parseLooseNumber(plain.match(/账单日\s*[:：]?\s*(\d{1,2})\s*日?/)?.[1]);
  const dueDate = extractDateAfterLabels(plain, ["到期还款日", "最后还款日", "还款日", "Payment Due Date", "Due Date"]);
  const billingDay = directBillingDay && directBillingDay >= 1 && directBillingDay <= 31 ? directBillingDay : periodStart?.day ?? periodEnd?.day;
  const repaymentDay = dueDate?.day;
  const statementAmount = extractStatementAmount(plain);
  const accountCore = institutionName ? `${institutionName}信用卡${cardNumberMasked ? `(${cardNumberMasked})` : ""}` : undefined;
  const accountName = ownerName && accountCore ? `${ownerName}的${accountCore}` : accountCore;

  return {
    institutionName: institutionName || undefined,
    ownerName: ownerName || undefined,
    cardNumberMasked: cardNumberMasked || undefined,
    creditLimit,
    billingDay,
    repaymentDay,
    statementAmount,
    statementPeriodStart: periodStart?.ymd,
    statementPeriodEnd: periodEnd?.ymd,
    statementDueDate: dueDate?.ymd,
    accountName,
  };
}

function compactStatementText(value: string) {
  return stripHtml(value).replace(/\s+/g, "");
}

function isBankOfCommunicationsCreditCardStatement(text: string) {
  const compact = compactStatementText(text);
  return /(交通银行|BankofCommunications|BOCOM|pccc)/i.test(compact);
}

type BocomTransactionHeaderIndexes = {
  transactionDate: number;
  postingDate: number;
  cardLast4: number;
  description: number;
  transactionAmount: number;
  postingAmount: number;
};

function normalizeTableHeaderCell(value: string) {
  return value.replace(/\s+/g, "").replace(/[：:]/g, "").trim();
}

function findBocomTransactionHeaderIndexes(cells: string[]): BocomTransactionHeaderIndexes | null {
  const headers = cells.map(normalizeTableHeaderCell);
  const find = (pattern: RegExp) => headers.findIndex((header) => pattern.test(header));
  const indexes = {
    transactionDate: find(/交易日期|TransactionDate/i),
    postingDate: find(/记账日期|PostingDate/i),
    cardLast4: find(/卡末四位|卡号末四位|CardNumber.*Last4digits|Last4digits/i),
    description: find(/交易说明|DescriptionofTransaction/i),
    transactionAmount: find(/交易金额|TransactionCurr\/?Amt/i),
    postingAmount: find(/入账金额|PaymentCurr\/?Amt/i),
  };

  return Object.values(indexes).every((index) => index >= 0) ? indexes : null;
}

function inferBocomSignedAmountInflowSign(text: string, period: ReturnType<typeof extractStatementPeriod>) {
  const samples: Array<{ amount: number | null; text: string }> = [];
  let inTransactionSection = false;
  let headerIndexes: BocomTransactionHeaderIndexes | null = null;

  for (const row of text.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const rowText = stripHtml(row);
    const compactRowText = rowText.replace(/\s+/g, "");
    const cells = extractTableCells(row).map((cell) => cell.trim()).filter(Boolean);

    if (/消费[、，,]?取现[、，,]?其他费用明细/i.test(compactRowText)) {
      inTransactionSection = true;
      headerIndexes = null;
      continue;
    }

    const detectedHeader = findBocomTransactionHeaderIndexes(cells);
    if (detectedHeader && (inTransactionSection || /交易日期|TransactionDate/i.test(rowText))) {
      inTransactionSection = true;
      headerIndexes = detectedHeader;
      continue;
    }

    if (!inTransactionSection || !headerIndexes) continue;
    if (/(账单说明|温馨提示|风险提示|积分明细|还款明细|分期|版权所有|客户服务热线)/i.test(rowText)) break;

    const maxHeaderIndex = Math.max(...Object.values(headerIndexes));
    if (cells.length <= maxHeaderIndex) continue;

    const date = normalizeStatementMonthDayCell(cells[headerIndexes.transactionDate], period);
    const description = cleanupMerchantName(cells[headerIndexes.description] ?? "");
    const postingAmount = parseMoney(cells[headerIndexes.postingAmount] ?? "");
    const transactionAmount = parseMoney(cells[headerIndexes.transactionAmount] ?? "");
    const amount = postingAmount ?? transactionAmount;
    const amountRaw = cells[headerIndexes.postingAmount] || cells[headerIndexes.transactionAmount] || "";
    if (!date || !description || amount === null || amount === 0) continue;
    if (isStatementSummaryText(description)) continue;

    samples.push({ amount, text: `${description} ${amountRaw} ${rowText}` });
  }

  return inferSignedAmountInflowSign(samples);
}

function parseBankOfCommunicationsCreditCardStatement(text: string): ParsedItem[] {
  if (!/<tr[\s>]/i.test(text) || !isBankOfCommunicationsCreditCardStatement(text)) return [];

  const meta = extractCreditCardMeta(text);
  const period = extractStatementPeriod(text);
  const institutionName = meta.institutionName || "交通银行";
  const baseMeta: ParsedItemMeta = {
    institutionName,
    ownerName: meta.ownerName,
    cardNumberMasked: meta.cardNumberMasked,
    creditLimit: meta.creditLimit,
    billingDay: meta.billingDay,
    repaymentDay: meta.repaymentDay,
    statementAmount: meta.statementAmount,
    statementPeriodStart: meta.statementPeriodStart,
    statementPeriodEnd: meta.statementPeriodEnd,
    statementDueDate: meta.statementDueDate,
  };

  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  let inTransactionSection = false;
  let headerIndexes: BocomTransactionHeaderIndexes | null = null;
  const signedAmountInflowSign = inferBocomSignedAmountInflowSign(text, period);

  for (const row of text.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const rowText = stripHtml(row);
    const compactRowText = rowText.replace(/\s+/g, "");
    const cells = extractTableCells(row).map((cell) => cell.trim()).filter(Boolean);

    if (/消费[、，,]?取现[、，,]?其他费用明细/i.test(compactRowText)) {
      inTransactionSection = true;
      headerIndexes = null;
      continue;
    }

    const detectedHeader = findBocomTransactionHeaderIndexes(cells);
    if (detectedHeader && (inTransactionSection || /交易日期|TransactionDate/i.test(rowText))) {
      inTransactionSection = true;
      headerIndexes = detectedHeader;
      continue;
    }

    if (!inTransactionSection || !headerIndexes) continue;
    if (/(账单说明|温馨提示|风险提示|积分明细|还款明细|分期|版权所有|客户服务热线)/i.test(rowText)) break;

    const maxHeaderIndex = Math.max(...Object.values(headerIndexes));
    if (cells.length <= maxHeaderIndex) continue;

    const date = normalizeStatementMonthDayCell(cells[headerIndexes.transactionDate], period);
    const postDate = normalizeStatementMonthDayCell(cells[headerIndexes.postingDate], period) || date;
    const description = cleanupMerchantName(cells[headerIndexes.description] ?? "");
    const rowCardNumberMasked = cells[headerIndexes.cardLast4]?.match(/\d{4}/)?.[0] ?? "";
    const postingAmount = parseMoney(cells[headerIndexes.postingAmount] ?? "");
    const transactionAmount = parseMoney(cells[headerIndexes.transactionAmount] ?? "");
    const amount = postingAmount ?? transactionAmount;
    const amountRaw = cells[headerIndexes.postingAmount] || cells[headerIndexes.transactionAmount] || "";

    if (!date || !description || amount === null || amount === 0) continue;
    if (isStatementSummaryText(description)) continue;

    const absAmount = Math.abs(amount);
    const { counterparty, category, institution } = aliasMatch(description);
    const transferText = `${description} ${amountRaw}`;
    const { type, isRepaymentTransfer, isExpenseRefund } = classifyCreditCardSignedAmount({
      description,
      transferText,
      amount,
      signedAmountInflowSign,
    });
    const paymentFromAccount = type === "transfer" ? paymentTailAccountName(transferText) : "";
    const cardAccount = rowCardNumberMasked ? `${institutionName}信用卡(${rowCardNumberMasked})` : meta.accountName;
    const key = `${date}|${postDate ?? ""}|${rowCardNumberMasked}|${description}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      rawText: `${date} ${description} ${amountRaw}`.trim(),
      type,
      date,
      amount: absAmount,
      inflow: type === "income" || isExpenseRefund || isRepaymentTransfer ? absAmount : undefined,
      outflow: type === "expense" && !isExpenseRefund ? absAmount : undefined,
      account: cardAccount,
      fromAccount: paymentFromAccount || undefined,
      toAccount: type === "transfer" ? cardAccount : undefined,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
      remark: postDate && postDate !== date ? `${description}（入账日 ${postDate}）` : description,
      postedDate: postDate,
      _meta: {
        ...baseMeta,
        cardNumberMasked: rowCardNumberMasked || baseMeta.cardNumberMasked,
      },
    });
  }

  return items;
}

type SpdbTransactionHeaderIndexes = Record<SpdbCreditCardTransactionField, number>;

function splitDelimitedStatementCells(line: string) {
  const raw = line.includes("\t")
    ? line.split("\t")
    : line.split(/\s{2,}/);
  return raw.map((cell) => cell.trim()).filter(Boolean);
}

type SpdbTransactionTableMatch = {
  lines: string[];
  headerLineIndex: number;
  headerIndexes: SpdbTransactionHeaderIndexes;
};

function findSpdbTransactionHeaderIndexes(cells: string[]): SpdbTransactionHeaderIndexes | null {
  return matchStatementHeaderProfile(cells, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
}

function normalizeDelimitedStatementLines(text: string) {
  const sourceText = /<[^>]+>/.test(text) ? htmlToLooseText(text) : decodeHtmlEntities(text);
  return sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractSpdbCardLast4(value: string) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, "");
  return normalized.match(/^(?:[*xX]{0,12})?(\d{4})$/)?.[1] ?? "";
}

function isSpdbCurrencyCell(value: string) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
  return /^(?:人民币|RMB|CNY|美元|USD|港币|HKD|日元|JPY|欧元|EUR|英镑|GBP)$/.test(normalized);
}

function isSpdbOriginalAmountCell(value: string) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
  return /^[+-]?\d+(?:,\d{3})*(?:\.\d{1,2})?\((?:RMB|CNY|USD|HKD|JPY|EUR|GBP)\)$/.test(normalized);
}

function isValidSpdbTransactionSampleRow(cells: string[], headerIndexes: SpdbTransactionHeaderIndexes) {
  const maxHeaderIndex = Math.max(...Object.values(headerIndexes));
  if (cells.length <= maxHeaderIndex) return false;

  const date = normalizeDateTimeCell(cells[headerIndexes.transactionDate]);
  const postDate = normalizeDateTimeCell(cells[headerIndexes.postingDate]);
  const description = cleanupMerchantName(cells[headerIndexes.description] ?? "");
  const rowCardNumberMasked = extractSpdbCardLast4(cells[headerIndexes.cardLast4] ?? "");
  const cardType = normalizeTableHeaderCell(cells[headerIndexes.cardType] ?? "");
  const currency = cells[headerIndexes.currency] ?? "";
  const amount = parseMoney(cells[headerIndexes.amount] ?? "");
  const originalAmount = cells[headerIndexes.originalAmount] ?? "";

  if (!date || !postDate || !description || amount === null || amount === 0) return false;
  if (isStatementSummaryText(description) || isNoiseLine(description)) return false;
  if (!rowCardNumberMasked) return false;
  if (!/^(?:主卡|附属卡|附卡|副卡)$/.test(cardType)) return false;
  if (!isSpdbCurrencyCell(currency)) return false;
  if (!isSpdbOriginalAmountCell(originalAmount)) return false;
  return true;
}

function findSpdbCreditCardTransactionTable(text: string, requireSampleValidation = true): SpdbTransactionTableMatch | null {
  const lines = normalizeDelimitedStatementLines(text);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const headerIndexes = findSpdbTransactionHeaderIndexes(splitDelimitedStatementCells(lines[lineIndex]));
    if (!headerIndexes) continue;

    if (!requireSampleValidation) {
      return { lines, headerLineIndex: lineIndex, headerIndexes };
    }

    let checkedRows = 0;
    let validRows = 0;
    for (const rowLine of lines.slice(lineIndex + 1)) {
      const cells = splitDelimitedStatementCells(rowLine);
      if (findSpdbTransactionHeaderIndexes(cells)) break;
      if (cells.length <= Math.max(...Object.values(headerIndexes))) continue;
      checkedRows += 1;
      if (isValidSpdbTransactionSampleRow(cells, headerIndexes)) validRows += 1;
      if (checkedRows >= 12 || validRows >= SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.minValidSampleRows) break;
    }

    if (validRows >= SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.minValidSampleRows) {
      return { lines, headerLineIndex: lineIndex, headerIndexes };
    }
  }
  return null;
}

function hasSpdbCreditCardTransactionHeader(text: string) {
  return Boolean(findSpdbCreditCardTransactionTable(text, false));
}

function isSpdbCreditCardTransactionReport(text: string) {
  return Boolean(findSpdbCreditCardTransactionTable(text));
}

function creditAdjustmentAccountName(text: string) {
  const maskedTail = text.match(/\*{2,}(\d{4})(?!\d)/);
  if (maskedTail?.[1]) return `尾号${maskedTail[1]}`;
  return paymentTailAccountName(text);
}

function isCreditCardCreditAdjustment(text: string) {
  return isCreditCardCreditAdjustmentLikeText(text);
}

function isCreditCardCreditInLike(text: string) {
  return /存入|收入|贷记|退款|退货|返现|刷卡金|抵扣|冲抵|减免|优惠|Payment|Credit/i.test(text) ||
    isCreditCardCreditAdjustment(text);
}

function classifyCreditCardSignedAmount({
  description,
  transferText,
  amount,
  signedAmountInflowSign,
}: {
  description: string;
  transferText: string;
  amount: number;
  signedAmountInflowSign: SignedAmountInflowSign | null;
}) {
  const isRepaymentTransfer = isCreditCardRepaymentLike(transferText);
  const isExpenseRefund = isExpenseRefundLike(transferText);
  const signedDirection = signedAmountDirection(amount, signedAmountInflowSign);
  const isSignedInflow = signedDirection === "in";
  const isCreditIn = isCreditCardCreditInLike(transferText);
  const type: ParsedItem["type"] =
    isRepaymentTransfer || isLikelyTransfer(description)
      ? "transfer"
      : isExpenseRefund
        ? "expense"
        : isCreditIn || isSignedInflow
          ? "income"
          : "expense";

  return {
    type,
    isRepaymentTransfer,
    isExpenseRefund,
    isInflow: type === "income" || isExpenseRefund || isRepaymentTransfer,
  };
}

function inferSpdbSignedAmountInflowSign(table: SpdbTransactionTableMatch) {
  const { lines, headerIndexes } = table;
  const samples: Array<{ amount: number | null; text: string }> = [];

  for (const line of lines.slice(table.headerLineIndex + 1)) {
    const cells = splitDelimitedStatementCells(line);
    if (cells.length === 0) continue;
    if (findSpdbTransactionHeaderIndexes(cells)) break;

    const maxHeaderIndex = Math.max(...Object.values(headerIndexes));
    if (cells.length <= maxHeaderIndex) continue;

    const date = normalizeDateTimeCell(cells[headerIndexes.transactionDate]);
    const description = cleanupMerchantName(cells[headerIndexes.description] ?? "");
    const amountRaw = cells[headerIndexes.amount] ?? "";
    const amount = parseMoney(amountRaw);
    if (!date || !description || amount === null || amount === 0) continue;
    if (isStatementSummaryText(description) || isNoiseLine(description)) continue;

    samples.push({ amount, text: `${description} ${amountRaw} ${line}` });
  }

  return inferSignedAmountInflowSign(samples);
}

function parseSpdbCreditCardTransactionReport(text: string): ParsedItem[] {
  const table = findSpdbCreditCardTransactionTable(text);
  if (!table) return [];

  const institutionName = SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.institutionName;
  const { lines, headerIndexes } = table;
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  const signedAmountInflowSign = inferSpdbSignedAmountInflowSign(table);

  for (const line of lines.slice(table.headerLineIndex + 1)) {
    const cells = splitDelimitedStatementCells(line);
    if (cells.length === 0) continue;

    if (findSpdbTransactionHeaderIndexes(cells)) break;

    const maxHeaderIndex = Math.max(...Object.values(headerIndexes));
    if (cells.length <= maxHeaderIndex) continue;

    const date = normalizeDateTimeCell(cells[headerIndexes.transactionDate]);
    const postDate = normalizeDateTimeCell(cells[headerIndexes.postingDate]) || date;
    const description = cleanupMerchantName(cells[headerIndexes.description] ?? "");
    const rowCardNumberMasked = extractSpdbCardLast4(cells[headerIndexes.cardLast4] ?? "");
    const amountRaw = cells[headerIndexes.amount] ?? "";
    const amount = parseMoney(amountRaw);
    if (!date || !description || amount === null || amount === 0) continue;
    if (isStatementSummaryText(description) || isNoiseLine(description)) continue;

    const absAmount = Math.abs(amount);
    const transferText = `${description} ${amountRaw}`;
    const { type, isRepaymentTransfer, isInflow } = classifyCreditCardSignedAmount({
      description,
      transferText,
      amount,
      signedAmountInflowSign,
    });
    const { counterparty, category, institution } = aliasMatch(description);
    const cardAccount = rowCardNumberMasked ? `${institutionName}信用卡(${rowCardNumberMasked})` : `${institutionName}信用卡`;
    const key = `${date}|${postDate ?? ""}|${rowCardNumberMasked}|${description}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      rawText: `${date} ${description} ${amountRaw}`.trim(),
      type,
      date,
      amount: absAmount,
      inflow: isInflow ? absAmount : undefined,
      outflow: !isInflow ? absAmount : undefined,
      account: cardAccount,
      fromAccount: isRepaymentTransfer ? creditAdjustmentAccountName(transferText) || undefined : undefined,
      toAccount: isRepaymentTransfer ? cardAccount : undefined,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
      remark: postDate && postDate !== date ? `${description}（入账日 ${postDate}）` : description,
      postedDate: postDate,
      _meta: {
        institutionName,
        cardNumberMasked: rowCardNumberMasked || undefined,
      },
    });
  }

  return items;
}

type IcbcPaymentSummary = {
  cardNumberMasked?: string;
  currency?: string;
  statementAmount?: number;
  minimumPayment?: number;
  creditLimit?: number;
};

type StatementAmountWithCurrency = {
  amount: number;
  currency?: string;
  direction?: "in" | "out";
  raw: string;
};

type IcbcTransactionHeaderIndexes = {
  cardLast4: number;
  transactionDate: number;
  postingDate: number;
  transactionType: number;
  description: number;
  transactionAmount: number;
  postingAmount: number;
};

function stripStatementMarkup(value: string) {
  return String(value ?? "").replace(/\*\*/g, "").trim();
}

function normalizeStatementCurrency(value?: string | null) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return undefined;
  if (/^(人民币|RMB|CNY)$/.test(raw)) return "CNY";
  if (/^(美元|USD)$/.test(raw)) return "USD";
  if (/^(港币|港元|HKD)$/.test(raw)) return "HKD";
  if (/^(日元|JPY)$/.test(raw)) return "JPY";
  if (/^(欧元|EUR)$/.test(raw)) return "EUR";
  if (/^(英镑|GBP)$/.test(raw)) return "GBP";
  return normalizeCurrency(raw);
}

function extractStatementCurrency(value: string) {
  const raw = String(value ?? "");
  const slashCurrency = raw.match(/\/\s*(RMB|CNY|USD|HKD|JPY|EUR|GBP)\b/i)?.[1];
  if (slashCurrency) return normalizeStatementCurrency(slashCurrency);
  const textCurrency = raw.match(/人民币|美元|港币|港元|日元|欧元|英镑/i)?.[0];
  return normalizeStatementCurrency(textCurrency);
}

function parseStatementAmountWithCurrency(value: string): StatementAmountWithCurrency | null {
  const raw = String(value ?? "").trim();
  const amount = parseMoney(raw);
  if (amount === null) return null;
  return {
    amount,
    currency: extractStatementCurrency(raw),
    direction: icbcPostingDirection(raw) ?? undefined,
    raw,
  };
}

function parseIcbcCurrencyAmounts(value: string) {
  return [...value.matchAll(/-?[\d,]+(?:\.\d+)?\s*\/\s*(?:RMB|CNY|USD|HKD|JPY|EUR|GBP)\b(?:\s*[（(][^）)]*[）)])?/gi)]
    .map((match) => parseStatementAmountWithCurrency(match[0]))
    .filter((amount): amount is StatementAmountWithCurrency => amount !== null);
}

function parseIcbcPaymentSummaryAmounts(value: string) {
  const currencyAmounts = parseIcbcCurrencyAmounts(value);
  if (currencyAmounts.length >= 3) return currencyAmounts;

  return splitDelimitedStatementCells(value)
    .map(stripStatementMarkup)
    .filter((cell) => {
      const compact = cell.replace(/\s+/g, "");
      if (!compact) return false;
      if (/^\d{4}(?:[（(].*?[）)])?$/.test(compact)) return false;
      if (/(卡号|后四位|末四位|贷记卡|币种|本位币|应还款额|最低还款额|信用额度|合计)/.test(compact)) return false;
      return true;
    })
    .map((cell) => parseStatementAmountWithCurrency(cell))
    .filter((amount): amount is StatementAmountWithCurrency => amount !== null);
}

function isIcbcCreditCardStatement(text: string) {
  const compact = compactStatementText(text);
  return /(中国工商银行|工商银行|ICBC|工银|牡丹贷记卡)/i.test(compact) &&
    /(卡号后四位|交易金额\/币种|记账金额\/币种|需还款明细|本期交易汇总)/i.test(compact);
}

function extractIcbcPaymentSummary(text: string): IcbcPaymentSummary {
  const lines = normalizeDelimitedStatementLines(text).map(stripStatementMarkup);
  const paymentSection = lines.join("\n").match(/需\s*还\s*款\s*明\s*细[\s\S]*?(?=本\s*期\s*交\s*易\s*汇\s*总|本\s*期\s*交\s*易\s*明\s*细|人民币.*交\s*易\s*明\s*细|工\s*银\s*i\s*豆|$)/i)?.[0];
  if (paymentSection) {
    const cardNumberMasked = paymentSection.match(/(?:^|\D)(\d{4})(?=\D)/)?.[1];
    const amounts = parseIcbcPaymentSummaryAmounts(paymentSection);
    if (cardNumberMasked && amounts.length >= 3) {
      return {
        cardNumberMasked,
        currency: amounts[0].currency ?? amounts[2].currency,
        statementAmount: Math.abs(amounts[0].amount),
        minimumPayment: Math.abs(amounts[1].amount),
        creditLimit: amounts[2].amount > 0 ? amounts[2].amount : undefined,
      };
    }
  }

  let inPaymentSummary = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const compactLine = line.replace(/\s+/g, "");
    if (/需还款明细/.test(compactLine)) {
      inPaymentSummary = true;
      continue;
    }
    if (inPaymentSummary && /(本期交易汇总|本期交易明细|交易明细|工银i豆)/.test(compactLine)) {
      inPaymentSummary = false;
      continue;
    }

    const cardNumberMasked = line.match(/^(\d{4})/)?.[1];
    if (!cardNumberMasked || /合计|---/.test(compactLine)) continue;
    if (!inPaymentSummary && !/贷记卡/.test(compactLine)) continue;

    const windowLines = [line];
    for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 8); nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const compactNextLine = nextLine.replace(/\s+/g, "");
      if (/(合计|本期交易汇总|本期交易明细|交易明细|工银i豆)/.test(compactNextLine)) break;
      windowLines.push(nextLine);
      if (parseIcbcPaymentSummaryAmounts(windowLines.join("\t")).length >= 3) break;
    }

    const amounts = parseIcbcPaymentSummaryAmounts(windowLines.join("\t"));
    if (amounts.length >= 3) {
      return {
        cardNumberMasked,
        currency: amounts[0].currency ?? amounts[2].currency,
        statementAmount: Math.abs(amounts[0].amount),
        minimumPayment: Math.abs(amounts[1].amount),
        creditLimit: amounts[2].amount > 0 ? amounts[2].amount : undefined,
      };
    }
  }
  return {};
}

function extractIcbcCreditCardMeta(text: string): ParsedItemMeta & { accountName?: string } {
  const plain = stripHtml(text);
  const period = extractStatementPeriod(plain);
  const paymentSummary = extractIcbcPaymentSummary(text);
  const cardNumberMasked = paymentSummary.cardNumberMasked || extractCreditCardLast4(text, "工商银行");
  const directDueDate = extractDateAfterLabels(plain, ["到期还款日", "最后还款日", "还款日", "Payment Due Date", "Due Date"]);
  const derivedDueDate = directDueDate?.ymd ?? addDaysToYmd(period?.end.ymd, 25);
  const dueParts = parseDateParts(derivedDueDate);
  const accountName = cardNumberMasked ? `工商银行信用卡(${cardNumberMasked})` : "工商银行信用卡";
  const genericCreditLimit = extractCreditLimit(plain);
  const creditLimit = paymentSummary.creditLimit ?? (
    genericCreditLimit && genericCreditLimit >= 1000 && String(Math.trunc(genericCreditLimit)) !== cardNumberMasked
      ? genericCreditLimit
      : undefined
  );

  return {
    institutionName: "工商银行",
    cardNumberMasked: cardNumberMasked || undefined,
    statementCurrency: paymentSummary.currency,
    minimumPayment: paymentSummary.minimumPayment,
    creditLimit,
    billingDay: period?.end.day,
    repaymentDay: directDueDate?.day ?? dueParts?.day,
    statementAmount: paymentSummary.statementAmount ?? extractStatementAmount(plain),
    statementPeriodStart: period?.start.ymd,
    statementPeriodEnd: period?.end.ymd,
    statementDueDate: derivedDueDate,
    accountName,
  };
}

function findIcbcTransactionHeaderIndexes(cells: string[]): IcbcTransactionHeaderIndexes | null {
  const headers = cells.map(normalizeTableHeaderCell);
  const find = (pattern: RegExp) => headers.findIndex((header) => pattern.test(header));
  const indexes = {
    cardLast4: find(/卡号后四位|卡号末四位/),
    transactionDate: find(/交易日|交易日期/),
    postingDate: find(/记账日|记账日期|入账日|入账日期/),
    transactionType: find(/交易类型|类型/),
    description: find(/商户名称\/?城市|商户名称|交易说明|交易描述|摘要/),
    transactionAmount: find(/交易金额\/?币种|交易金额/),
    postingAmount: find(/记账金额\/?币种|入账金额\/?币种|人民币金额|记账金额/),
  };

  return Object.values(indexes).every((index) => index >= 0) ? indexes : null;
}

function icbcPostingDirection(text: string): "in" | "out" | null {
  if (/[（(]\s*(?:支出|转出)\s*[）)]/.test(text) || /(?:消费|取现|支出)/.test(text)) return "out";
  if (/[（(]\s*(?:存入|收入|转入)\s*[）)]/.test(text) || /(?:存入|退款|退货|还款|银联入账|收入)/.test(text)) return "in";
  return null;
}

function parseIcbcCreditCardStatement(text: string): ParsedItem[] {
  if (!isIcbcCreditCardStatement(text)) return [];

  const meta = extractIcbcCreditCardMeta(text);
  const period = extractStatementPeriod(text);
  const lines = normalizeDelimitedStatementLines(text).map(stripStatementMarkup);
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  let headerIndexes: IcbcTransactionHeaderIndexes | null = null;

  const baseMeta: ParsedItemMeta = {
    institutionName: meta.institutionName,
    ownerName: meta.ownerName,
    cardNumberMasked: meta.cardNumberMasked,
    statementCurrency: meta.statementCurrency,
    minimumPayment: meta.minimumPayment,
    creditLimit: meta.creditLimit,
    billingDay: meta.billingDay,
    repaymentDay: meta.repaymentDay,
    statementAmount: meta.statementAmount,
    statementPeriodStart: meta.statementPeriodStart,
    statementPeriodEnd: meta.statementPeriodEnd,
    statementDueDate: meta.statementDueDate,
  };

  for (const line of lines) {
    const compactLine = line.replace(/\s+/g, "");
    if (/(工银i豆|账单说明|温馨提示|备注[:：]|版权所有|客户服务热线)/i.test(compactLine)) break;

    const cells = splitDelimitedStatementCells(line).map(stripStatementMarkup).filter(Boolean);
    const detectedHeader = findIcbcTransactionHeaderIndexes(cells);
    if (detectedHeader) {
      headerIndexes = detectedHeader;
      continue;
    }

    if (!headerIndexes) continue;
    const maxHeaderIndex = Math.max(...Object.values(headerIndexes));
    if (cells.length <= maxHeaderIndex) continue;

    const rowCardNumberMasked = cells[headerIndexes.cardLast4]?.match(/\d{4}/)?.[0] ?? "";
    const date = normalizeStatementMonthDayCell(cells[headerIndexes.transactionDate], period);
    const postDate = normalizeStatementMonthDayCell(cells[headerIndexes.postingDate], period) || date;
    const transactionType = cleanupMerchantName(cells[headerIndexes.transactionType] ?? "");
    const description = cleanupMerchantName(cells[headerIndexes.description] ?? "");
    const postingAmountRaw = cells[headerIndexes.postingAmount] ?? "";
    const transactionAmountRaw = cells[headerIndexes.transactionAmount] ?? "";
    const postingAmount = parseStatementAmountWithCurrency(postingAmountRaw);
    const transactionAmount = parseStatementAmountWithCurrency(transactionAmountRaw);
    const amountInfo = postingAmount ?? transactionAmount;
    const amount = amountInfo?.amount ?? null;
    const currency = amountInfo?.currency ?? baseMeta.statementCurrency;
    if (!rowCardNumberMasked || !date || !description || amount === null || amount === 0) continue;
    if (isStatementSummaryText(description) || isNoiseLine(description)) continue;

    const absAmount = Math.abs(amount);
    const transferText = `${transactionType} ${description} ${postingAmountRaw || transactionAmountRaw}`;
    const explicitDirection = amountInfo?.direction ?? icbcPostingDirection(transferText);
    const isRepaymentTransfer = isCreditCardRepaymentLike(transferText);
    const isExpenseRefund = isExpenseRefundLike(transferText) || /退款|退货|撤销|冲正/.test(transactionType);
    const type: ParsedItem["type"] = isRepaymentTransfer
      ? "transfer"
      : isExpenseRefund
        ? "expense"
        : explicitDirection === "in"
          ? "income"
          : "expense";
    const isInflow = type === "income" || isExpenseRefund || isRepaymentTransfer;
    const { counterparty, category, institution } = aliasMatch(description);
    const cardAccount = `${meta.institutionName || "工商银行"}信用卡(${rowCardNumberMasked})`;
    const key = `${date}|${postDate ?? ""}|${rowCardNumberMasked}|${transactionType}|${description}|${amount}|${currency ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      rawText: `${date} ${transactionType} ${description} ${postingAmountRaw || transactionAmountRaw}`.trim(),
      type,
      date,
      amount: absAmount,
      inflow: isInflow ? absAmount : undefined,
      outflow: !isInflow ? absAmount : undefined,
      currency,
      account: cardAccount,
      fromAccount: isRepaymentTransfer ? paymentTailAccountName(transferText) || undefined : undefined,
      toAccount: isRepaymentTransfer ? cardAccount : undefined,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
      remark: postDate && postDate !== date ? `${description}（入账日 ${postDate}）` : description,
      postedDate: postDate,
      _meta: {
        ...baseMeta,
        cardNumberMasked: rowCardNumberMasked || baseMeta.cardNumberMasked,
        statementCurrency: currency ?? baseMeta.statementCurrency,
      },
    });
  }

  return items;
}

type CreditCardStatementTemplate = {
  name: string;
  matches: (text: string) => boolean;
  parse: (text: string) => ParsedItem[];
};

const CREDIT_CARD_STATEMENT_TEMPLATES: CreditCardStatementTemplate[] = [
  {
    name: "icbc",
    matches: isIcbcCreditCardStatement,
    parse: parseIcbcCreditCardStatement,
  },
  {
    name: "spdb-transaction-report",
    matches: isSpdbCreditCardTransactionReport,
    parse: parseSpdbCreditCardTransactionReport,
  },
  {
    name: "bank-of-communications",
    matches: isBankOfCommunicationsCreditCardStatement,
    parse: parseBankOfCommunicationsCreditCardStatement,
  },
];

function parseKnownBankCreditCardStatement(text: string): ParsedItem[] {
  for (const template of CREDIT_CARD_STATEMENT_TEMPLATES) {
    if (!template.matches(text)) continue;
    const items = template.parse(text);
    if (items.length > 0) return items;
  }
  return [];
}

function inferCreditCardHtmlSignedAmountInflowSign(text: string) {
  const samples: Array<{ amount: number | null; text: string }> = [];
  let inTransactionRows = false;

  for (const row of text.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const rowText = stripHtml(row);
    if (/(交易日期|交易日|Trans Date)/i.test(rowText) && /(交易摘要|交易说明|交易描述|摘要|Trans Description|金额|Amount)/i.test(rowText)) {
      inTransactionRows = true;
      continue;
    }
    if (!inTransactionRows) continue;
    if (/(分期说明|账单说明|温馨提示|最新活动信息|版权所有)/i.test(rowText)) break;
    if (isStatementSummaryText(rowText)) continue;

    const cells = extractTableCells(row).filter(Boolean);
    if (cells.length < 3) continue;

    const dateIndexes = cells
      .map((cell, index) => ({ index, date: normalizeDateTimeCell(cell) }))
      .filter((item): item is { index: number; date: string } => Boolean(item.date));
    const amountCell = findAmountCell(cells);
    const usedIndexes = new Set<number>(dateIndexes.map((item) => item.index));
    if (amountCell) usedIndexes.add(amountCell.index);
    cells.forEach((cell, index) => {
      if (/^\d{4}$/.test(cell.trim())) usedIndexes.add(index);
    });
    const description = findDescriptionCell(cells, usedIndexes);
    if (!dateIndexes[0]?.date || !description || !amountCell || amountCell.amount === 0) continue;
    if (isStatementSummaryText(description)) continue;

    samples.push({ amount: amountCell.amount, text: `${description} ${amountCell.raw} ${rowText}` });
  }

  return inferSignedAmountInflowSign(samples);
}

function parseCreditCardHtmlStatement(text: string): ParsedItem[] {
  if (!/<tr[\s>]/i.test(text) || !/(交易日期|交易日|记账日期|记账日|入账日期|Trans Date|Post Date|交易摘要|交易说明|交易描述|摘要|Trans Description|人民币金额|交易金额|入账金额|Amount)/i.test(text)) {
    return [];
  }

  const meta = extractCreditCardMeta(text);
  const account = meta.accountName;
  const itemMeta: ParsedItemMeta = {
    institutionName: meta.institutionName,
    ownerName: meta.ownerName,
    cardNumberMasked: meta.cardNumberMasked,
    creditLimit: meta.creditLimit,
    billingDay: meta.billingDay,
    repaymentDay: meta.repaymentDay,
    statementAmount: meta.statementAmount,
    statementPeriodStart: meta.statementPeriodStart,
    statementPeriodEnd: meta.statementPeriodEnd,
    statementDueDate: meta.statementDueDate,
  };
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  let inTransactionRows = false;
  let activeAccount = account;
  let activeItemMeta = itemMeta;
  let hasActiveAccountHeader = false;
  const signedAmountInflowSign = inferCreditCardHtmlSignedAmountInflowSign(text);

  for (const row of text.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const rowText = stripHtml(row);
    if (/(交易日期|交易日|Trans Date)/i.test(rowText) && /(交易摘要|交易说明|交易描述|摘要|Trans Description|金额|Amount)/i.test(rowText)) {
      inTransactionRows = true;
      continue;
    }
    if (!inTransactionRows) continue;
    if (/(分期说明|账单说明|温馨提示|最新活动信息|版权所有)/i.test(rowText)) break;
    if (isStatementSummaryText(rowText)) continue;

    const accountHeader = extractStatementAccountHeader(rowText, meta.institutionName);
    if (accountHeader) {
      activeAccount = accountHeader.accountName;
      activeItemMeta = {
        ...itemMeta,
        institutionName: accountHeader.institutionName || itemMeta.institutionName,
        cardNumberMasked: accountHeader.cardNumberMasked,
      };
      hasActiveAccountHeader = true;
      continue;
    }

    const cells = extractTableCells(row).filter(Boolean);
    if (cells.length < 3) continue;

    const dateIndexes = cells
      .map((cell, index) => ({ index, date: normalizeDateTimeCell(cell) }))
      .filter((item): item is { index: number; date: string } => Boolean(item.date));
    const amountCell = findAmountCell(cells);
    const date = dateIndexes[0]?.date;
    const postDate = dateIndexes[1]?.date;
    const rowCardNumberMasked = !hasActiveAccountHeader && !isDebitOrRepaymentAccountContext(rowText)
      ? cells.find((cell) => /^\d{4}$/.test(cell.trim()))?.trim()
      : "";
    const usedIndexes = new Set<number>(dateIndexes.map((item) => item.index));
    if (amountCell) usedIndexes.add(amountCell.index);
    cells.forEach((cell, index) => {
      if (/^\d{4}$/.test(cell.trim())) usedIndexes.add(index);
    });
    const description = findDescriptionCell(cells, usedIndexes);
    if (!date || !description) continue;
    if (isStatementSummaryText(description)) continue;

    if (!amountCell || amountCell.amount === 0) continue;
    const amount = amountCell.amount;

    const absAmount = Math.abs(amount);
    const { counterparty, category, institution } = aliasMatch(description);
    const transferText = `${description} ${amountCell.raw}`;
    const { type, isRepaymentTransfer, isExpenseRefund } = classifyCreditCardSignedAmount({
      description,
      transferText,
      amount,
      signedAmountInflowSign,
    });
    const paymentFromAccount = type === "transfer" ? paymentTailAccountName(transferText) : "";
    const cardAccount = hasActiveAccountHeader
      ? activeAccount
      : rowCardNumberMasked && meta.institutionName
        ? `${meta.institutionName}信用卡(${rowCardNumberMasked})`
        : account;
    const key = `${date}|${postDate ?? ""}|${description}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      rawText: `${date} ${description} ${amountCell.raw}`,
      type,
      date,
      amount: absAmount,
      inflow: type === "income" || isExpenseRefund || isRepaymentTransfer ? absAmount : undefined,
      outflow: type === "expense" && !isExpenseRefund ? absAmount : undefined,
      account: cardAccount,
      fromAccount: paymentFromAccount || undefined,
      toAccount: type === "transfer" ? cardAccount : undefined,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
      remark: postDate && postDate !== date ? `${description}（入账日 ${postDate}）` : description,
      postedDate: postDate,
      _meta: Object.values(activeItemMeta).some((value) => value !== undefined) || rowCardNumberMasked ? {
        ...activeItemMeta,
        cardNumberMasked: rowCardNumberMasked || activeItemMeta.cardNumberMasked,
      } : undefined,
    });
  }

  return items;
}

function parseStructuredStatement(text: string): ParsedItem[] {
  const bankTemplateItems = parseKnownBankCreditCardStatement(text);
  if (bankTemplateItems.length > 0) return bankTemplateItems;
  if (hasSpdbCreditCardTransactionHeader(text)) return [];

  const htmlItems = parseCreditCardHtmlStatement(text);
  if (htmlItems.length > 0) return htmlItems;

  const sourceText = /<[^>]+>/.test(text) ? htmlToLooseText(text) : text;
  const lines = sourceText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: ParsedItem[] = [];

  for (const line of lines) {
    if (isNoiseLine(line)) continue;

    const date = extractDate(line);
    const amount = extractAmount(line);
    if (!date) continue;
    if (amount === 0) continue;

    const { counterparty, category, institution } = aliasMatch(line);
    const isRepaymentTransfer = isCreditCardRepaymentLike(line);
    const isExpenseRefund = isExpenseRefundLike(line);
    const isIncome = !isExpenseRefund && /收入|工资|报销|退款|返现|返利|到账|奖金|红包/i.test(line);
    const isTransfer = isRepaymentTransfer || isLikelyTransfer(line);
    const paymentFromAccount = isTransfer ? paymentTailAccountName(line) : "";

    const type = isTransfer ? "transfer" : isIncome ? "income" : "expense";

    items.push({
      rawText: line,
      type,
      date,
      amount: amount || 0,
      inflow: type === "income" || isExpenseRefund || isRepaymentTransfer ? amount || 0 : undefined,
      outflow: type === "expense" && !isExpenseRefund ? amount || 0 : undefined,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
      fromAccount: paymentFromAccount || undefined,
      remark: line,
    });
  }

  return items;
}

function parseNaturalLanguage(text: string): ParsedItem[] {
  const dateM = text.match(/(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/);
  const amountM = text.match(/-?[\d,]+\.?\d*/);
  const amount = amountM ? Math.abs(parseFloat(amountM[0].replace(/,/g,""))) : 0;

  const isExpenseRefund = isExpenseRefundLike(text);
  const isIncome = !isExpenseRefund && /收到|收入|工资|入账|退款|返现|到账|红包|奖金|报销/i.test(text);
  const isTransfer = isLikelyTransfer(text);
  const paymentFromAccount = isTransfer ? paymentTailAccountName(text) : "";

  const { counterparty, category, institution } = aliasMatch(text);

  return [{
    rawText: text,
    type: isTransfer ? "transfer" : isIncome ? "income" : "expense",
    date: dateM ? `${dateM[1]}-${dateM[2].padStart(2,"0")}-${dateM[3].padStart(2,"0")}` : undefined,
    amount,
    inflow: isIncome || isExpenseRefund ? amount : undefined,
    outflow: !isIncome && !isExpenseRefund && !isTransfer ? amount : undefined,
    counterparty: counterparty || undefined,
    institution: institution || undefined,
    category: category || undefined,
    fromAccount: paymentFromAccount || undefined,
    remark: text,
  }];
}

function normalizeExplicitStatementFlowDirections(items: ParsedItem[]) {
  return items.map((item) => {
    const source = [item.rawText, item.remark].map((value) => String(value ?? "")).join(" ");
    const amount = Math.abs(Number(item.amount ?? item.inflow ?? item.outflow ?? 0)) || 0;
    if (!amount || item.type === "investment") return item;

    const hasExplicitOutflow = /[（(]\s*(?:支出|转出)\s*[）)]/.test(source) || /(?:^|\s)(?:消费|取现)(?:\s|$)/.test(source);
    const hasExplicitInflow = /[（(]\s*(?:存入|收入|转入)\s*[）)]/.test(source);
    const isRepaymentTransfer = isCreditCardRepaymentLike(source);
    const isRefund = isExpenseRefundLike(source) || /(?:^|\s)(?:退款|退货|撤销|冲正)(?:\s|$)/.test(source);

    if (item.type === "transfer" || isRepaymentTransfer) {
      return {
        ...item,
        type: "transfer" as const,
        amount,
        inflow: hasExplicitOutflow ? undefined : amount,
        outflow: hasExplicitOutflow ? amount : undefined,
      };
    }
    if (isRefund) {
      return { ...item, type: "expense" as const, amount, inflow: amount, outflow: undefined };
    }
    if (hasExplicitOutflow) {
      return { ...item, type: "expense" as const, amount, inflow: undefined, outflow: amount };
    }
    if (hasExplicitInflow) {
      return { ...item, type: "income" as const, amount, inflow: amount, outflow: undefined };
    }
    return item;
  });
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const text = ((body?.text ?? "") as string).trim();
    if (!text) {
      return NextResponse.json({ ok: false, code: "MISSING_TEXT", error: "缺少 text" }, { status: 400 });
    }

    const charCount = text.length;
    const isShortText = charCount <= 50;
    const isLongText = charCount > 100;

    let items: ParsedItem[] = [];
    let parseMethod = "";

    if (isLongText) {
      items = parseStructuredStatement(text);
      parseMethod = "structured";
    } else if (isShortText) {
      items = parseNaturalLanguage(text);
      parseMethod = "natural";
    } else {
      items = parseStructuredStatement(text);
      parseMethod = "auto";
    }

    if (items.length === 0) {
      items = [{ rawText: text, type: "expense", amount: 0 }];
      parseMethod = "unparsed";
    } else {
      items = normalizeExplicitStatementFlowDirections(items);
      items = alignStatementIncomeRefunds(items.map(enrichKnownStatementMerchantForImport));
      const categories = await prisma.category.findMany({
        where: {
          OR: [{ householdId }, { householdId: null }],
        },
        select: { id: true, name: true, type: true },
      });
      const historicalSamples = await prisma.txRecord.findMany({
        where: {
          householdId,
          deletedAt: null,
          type: { in: ["income", "expense"] },
          categoryName: { not: null },
          AND: [
            {
              OR: [
                { source: "manual" },
                { source: null },
              ],
            },
            {
              OR: [
                { note: { not: null } },
                { counterpartyInstitutionName: { not: null } },
                { paymentChannelName: { not: null } },
              ],
            },
          ],
        },
        select: {
          type: true,
          categoryName: true,
          note: true,
          counterpartyInstitutionName: true,
          paymentChannelName: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 5000,
      });
      const usableHistoricalSamples: StatementHistoricalCategorySample[] = historicalSamples
        .filter((sample) => Boolean(sample.categoryName))
        .map((sample) => ({
          type: sample.type,
          categoryName: sample.categoryName ?? "",
          counterpartyInstitutionName: sample.counterpartyInstitutionName,
          paymentChannelName: sample.paymentChannelName,
          source: "history",
          note: sample.note,
        }));
      const recognitionSamples = await loadStatementRecognitionRuleSamples(prisma, householdId);
      items = alignStatementRecognitionToLedger(items, categories, [
        ...recognitionSamples,
        ...usableHistoricalSamples,
      ]);
    }

    return NextResponse.json({
      ok: true,
      items,
      meta: {
        charCount,
        parseMethod,
        itemCount: items.length,
        hasDates: items.filter(i => i.date).length,
        hasAmounts: items.filter(i => i.amount > 0).length,
        hasCounterparties: items.filter(i => i.counterparty).length,
      },
    });
  } catch (e) {
    console.error("[parse] error:", e);
    return NextResponse.json({ ok: false, code: "PARSE_FAILED", error: String(e) }, { status: 500 });
  }
}
