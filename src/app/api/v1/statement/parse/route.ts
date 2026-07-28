import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

type ParsedItemMeta = {
  institutionName?: string;
  ownerName?: string;
  cardNumberMasked?: string;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
  statementAmount?: number;
};

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
  institution?: string;
  postedDate?: string;
  _meta?: ParsedItemMeta;
};

type CategoryOption = {
  id: string;
  name: string;
  type: string;
};

type HistoricalCategorySample = {
  type: string;
  categoryName: string;
  note: string | null;
  counterpartyInstitutionName: string | null;
  paymentChannelName: string | null;
};

const ALIAS_PATTERNS: Array<{ pattern: RegExp; counterparty: string; category?: string; institution?: string }> = [
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
  { pattern: /云闪付/, counterparty: "云闪付", institution: "云闪付", category: "购物" },
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
  if (/食品|生鲜|粮油|零食|食材|水果|蔬菜|肉类|熟食/.test(remark)) return "食品";
  if (/车品|汽车用品|汽配|轮胎|机油|洗车|加油|充电桩|ETC/.test(remark)) return "车品";
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
        category: remarkCategory || category || "购物",
        institution: prefixInstitution || institution || counterparty,
      };
    }
  }
  return { counterparty: "", category: remarkCategory, institution: prefixInstitution };
}

function isPlaceholderText(value?: string) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanOptionalText(value?: string) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? undefined : text;
}

function enrichKnownMerchant(item: ParsedItem): ParsedItem {
  const source = [
    cleanOptionalText(item.institution),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.remark),
    cleanOptionalText(item.rawText),
  ].filter(Boolean).join(" ");
  const matched = aliasMatch(source);
  const matchedInstitution = cleanOptionalText(matched.institution);
  const matchedCounterparty = cleanOptionalText(matched.counterparty);
  const matchedCategory = cleanOptionalText(matched.category);
  const preferMerchantRule = Boolean(
    matchedInstitution &&
    /拼多多|支付宝|微信|京东|淘宝|天猫|美团|云闪付/.test(matchedInstitution),
  );
  return {
    ...item,
    category: preferMerchantRule ? matchedCategory : cleanOptionalText(item.category) || matchedCategory || undefined,
    institution: preferMerchantRule ? matchedInstitution : cleanOptionalText(item.institution) || matchedInstitution || matchedCounterparty || undefined,
    counterparty: preferMerchantRule ? matchedCounterparty : cleanOptionalText(item.counterparty) || matchedCounterparty || undefined,
    remark: cleanOptionalText(item.remark),
  };
}

function categoryKeywords(value: string) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const keywords = new Set<string>([text]);
  if (/水电燃气|电费|水费|燃气|国网|电力/.test(text)) {
    ["水电燃气", "生活缴费", "电费", "水费", "燃气", "国网", "电力"].forEach((item) => keywords.add(item));
  }
  if (/银行费用|信用卡费用|年费|账户管理费|银行卡费|信用卡费|制卡费|手续费/.test(text)) {
    ["银行费用", "信用卡费用", "年费", "账户管理费", "银行卡费", "信用卡费", "制卡费", "手续费"].forEach((item) => keywords.add(item));
  }
  if (/嘟嘟抓饭|抓饭|餐饮|外卖|美食|饭店|餐厅|咖啡|茶饮/.test(text)) {
    ["下馆子", "餐饮", "餐饮美食", "餐饮费", "外卖", "美食", "饭店", "餐厅", "咖啡", "茶饮", "嘟嘟抓饭", "抓饭"].forEach((item) => keywords.add(item));
  }
  if (/食品|生鲜|粮油|零食|食材|水果|蔬菜|肉类|熟食/.test(text)) {
    ["食品", "买菜食材", "餐饮美食", "零食饮料", "生鲜", "粮油", "零食", "食材", "水果", "蔬菜", "肉类", "熟食"].forEach((item) => keywords.add(item));
  }
  if (/快递|寄件|取件|顺丰|圆通|中通|韵达|申通/.test(text)) {
    ["快递物流", "快递", "寄件", "取件", "顺丰", "圆通", "中通", "韵达", "申通"].forEach((item) => keywords.add(item));
  }
  if (/停车场|停车费|停车/.test(text)) {
    ["停车费", "停车场", "停车"].forEach((item) => keywords.add(item));
  }
  if (/车品|汽车|汽配|洗车|停车|加油|轮胎|机油/.test(text)) {
    ["车品", "汽车", "汽配", "洗车", "停车", "加油", "轮胎", "机油"].forEach((item) => keywords.add(item));
  }
  if (/数码|电子|电脑|手机|电器|配件|电工/.test(text)) {
    ["数码", "电子", "电脑", "手机", "电器", "配件", "电工"].forEach((item) => keywords.add(item));
  }
  return [...keywords].filter(Boolean);
}

function normalizeRecognitionText(value?: string | null) {
  return cleanupMerchantName(String(value ?? ""))
    .replace(/\d{4}[-\/.年]\d{1,2}[-\/.月]\d{1,2}(?:日)?/g, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")
    .replace(/付款尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/[￥¥]?\d+(?:,\d{3})*(?:\.\d+)?/g, " ")
    .replace(/人民币|支付宝|微信支付|财付通|拼多多支付|京东支付|云闪付|银联|入账|交易|消费|付款|支付/g, " ")
    .replace(/[()（）【】[\]{}《》<>、,，.;；:：/\\|~!！?？"'“”‘’+\-_=—\s]+/g, " ")
    .trim();
}

function recognitionTokens(value?: string | null) {
  const normalized = normalizeRecognitionText(value);
  if (!normalized) return [];
  const tokens = new Set<string>();
  const parts = normalized.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 0 ? parts : [normalized]) {
    if (part.length >= 2 && !/^\d+$/.test(part)) tokens.add(part);
    if (/[\u4e00-\u9fa5]/.test(part) && part.length >= 4) {
      for (let len = Math.min(8, part.length); len >= 4; len--) {
        for (let i = 0; i <= part.length - len; i++) tokens.add(part.slice(i, i + len));
      }
    }
  }
  return [...tokens].filter((token) => token.length >= 2);
}

function matchHistoricalCategoryName(item: ParsedItem, samples: HistoricalCategorySample[]) {
  const type = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
  if (!type) return undefined;

  const sourceParts = [
    cleanOptionalText(item.remark),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.institution),
    cleanOptionalText(item.rawText),
  ];
  const source = sourceParts.filter(Boolean).join(" ");
  const sourceText = normalizeRecognitionText(source);
  const sourceTokens = new Set(recognitionTokens(source));
  if (!sourceText && sourceTokens.size === 0) return undefined;

  const scores = new Map<string, number>();
  for (const sample of samples) {
    if (sample.type !== type || !sample.categoryName) continue;
    const sampleSource = [sample.note, sample.counterpartyInstitutionName, sample.paymentChannelName].filter(Boolean).join(" ");
    const sampleText = normalizeRecognitionText(sampleSource);
    const sampleTokens = recognitionTokens(sampleSource);
    if (!sampleText && sampleTokens.length === 0) continue;

    let score = 0;
    if (sourceText && sampleText) {
      if (sourceText === sampleText) score += 40;
      else if (sourceText.includes(sampleText) || sampleText.includes(sourceText)) {
        score += Math.min(sourceText.length, sampleText.length) >= 4 ? 18 : 6;
      }
    }
    for (const token of sampleTokens) {
      if (sourceTokens.has(token)) score += Math.min(12, token.length * 2);
      else if (token.length >= 4 && sourceText.includes(token)) score += Math.min(10, token.length);
    }
    if (score < 12) continue;
    scores.set(sample.categoryName, Math.max(scores.get(sample.categoryName) ?? 0, score));
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function matchExistingCategoryName(item: ParsedItem, categories: CategoryOption[], historicalSamples: HistoricalCategorySample[] = []) {
  const type = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
  if (!type) return undefined;
  const scopedCategories = categories.filter((category) => category.type === type);
  if (scopedCategories.length === 0) return undefined;

  const historicalCategoryName = matchHistoricalCategoryName(item, historicalSamples);
  if (historicalCategoryName && scopedCategories.some((category) => category.name === historicalCategoryName)) {
    return historicalCategoryName;
  }

  const candidate = cleanOptionalText(item.category);
  if (candidate) {
    const exact = scopedCategories.find((category) => category.name === candidate);
    if (exact) return exact.name;
  }

  const source = [
    cleanOptionalText(item.category),
    cleanOptionalText(item.remark),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.institution),
    cleanOptionalText(item.rawText),
  ].filter(Boolean).join(" ");
  const keywords = categoryKeywords(source);
  for (const keyword of keywords) {
    const matched = scopedCategories.find((category) => category.name === keyword);
    if (matched) return matched.name;
  }
  for (const keyword of keywords) {
    const matched = scopedCategories.find((category) => category.name.includes(keyword) || keyword.includes(category.name));
    if (matched) return matched.name;
  }
  return undefined;
}

function alignCategoriesToLedger(items: ParsedItem[], categories: CategoryOption[], historicalSamples: HistoricalCategorySample[] = []) {
  if (categories.length === 0) return items;
  return items.map((item) => {
    const matchedCategoryName = matchExistingCategoryName(item, categories, historicalSamples);
    return {
      ...item,
      category: matchedCategoryName,
    };
  });
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
  const match = String(text ?? "").match(/(?:付款|扣款|还款)?尾号[:：]?\s*(\d{2,8})/);
  return match?.[1] ?? "";
}

function paymentTailAccountName(text: string) {
  const tail = extractPaymentTail(text);
  return tail ? `尾号${tail}` : "";
}

function isCreditCardRepaymentLike(text: string) {
  return /银联入账|付款尾号|扣款尾号|还款尾号|自动还款|自动扣款|信用卡还款|还款入账/i.test(text);
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
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
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

function extractStatementAmount(text: string) {
  const labels = [
    "本期应还款金额",
    "本期应还款总额",
    "本期应缴余额",
    "本期应还",
    "本期余额",
    "本期账单金额",
    "New Balance",
    "Total Due",
  ];
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:：]?\\s*(?:人民币|RMB|CNY|￥|¥)?\\s*(-?[\\d,]+(?:\\.\\d+)?)`, "i"));
    const amount = parseLooseNumber(match?.[1]);
    if (amount !== undefined) return amount;
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
  const creditLimit = parseLooseNumber(plain.match(/固定额度(?:\([^)]*\)|（[^）]*）)?\s*[:：]?\s*([\d,]+(?:\.\d+)?)/)?.[1]);
  const periodMatch = plain.match(/(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})\s*[-~至—]\s*(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})/);
  const periodEnd = parseDateParts(periodMatch?.[2] ?? "");
  const directBillingDay = parseLooseNumber(plain.match(/账单日\s*[:：]?\s*(\d{1,2})\s*日?/)?.[1]);
  const dueDate = parseDateParts(plain.match(/(?:到期还款日|最后还款日|还款日)\s*[:：]?\s*(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})/)?.[1]);
  const billingDay = directBillingDay && directBillingDay >= 1 && directBillingDay <= 31 ? directBillingDay : periodEnd?.day;
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
    accountName,
  };
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
  };
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  let inTransactionRows = false;
  let activeAccount = account;
  let activeItemMeta = itemMeta;
  let hasActiveAccountHeader = false;

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
    const isRepaymentTransfer = isCreditCardRepaymentLike(transferText);
    const isCreditIn = /存入|收入|退款|退货|返现|冲正|减免|还款|Payment|Credit/i.test(transferText);
    const type = isRepaymentTransfer || isLikelyTransfer(description) ? "transfer" : isCreditIn ? "income" : amount < 0 ? "income" : "expense";
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
    const isIncome = /收入|工资|报销|退款|返现|返利|到账|奖金|红包/i.test(line);
    const isTransfer = isLikelyTransfer(line);
    const paymentFromAccount = isTransfer ? paymentTailAccountName(line) : "";

    const type = isTransfer ? "transfer" : isIncome ? "income" : "expense";

    items.push({
      rawText: line,
      type,
      date,
      amount: amount || 0,
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

  const isIncome = /收到|收入|工资|入账|退款|返现|到账|红包|奖金|报销/i.test(text);
  const isTransfer = isLikelyTransfer(text);
  const paymentFromAccount = isTransfer ? paymentTailAccountName(text) : "";

  const { counterparty, category, institution } = aliasMatch(text);

  return [{
    rawText: text,
    type: isTransfer ? "transfer" : isIncome ? "income" : "expense",
    date: dateM ? `${dateM[1]}-${dateM[2].padStart(2,"0")}-${dateM[3].padStart(2,"0")}` : undefined,
    amount,
    counterparty: counterparty || undefined,
    institution: institution || undefined,
    category: category || undefined,
    fromAccount: paymentFromAccount || undefined,
    remark: text,
  }];
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const text = ((body?.text ?? "") as string).trim();
    if (!text) {
      return NextResponse.json({ ok: false, error: "缺少 text" }, { status: 400 });
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
      items = items.map(enrichKnownMerchant);
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
      const usableHistoricalSamples: HistoricalCategorySample[] = historicalSamples
        .filter((sample) => Boolean(sample.categoryName))
        .map((sample) => ({
          type: sample.type,
          categoryName: sample.categoryName ?? "",
          note: sample.note,
          counterpartyInstitutionName: sample.counterpartyInstitutionName,
          paymentChannelName: sample.paymentChannelName,
        }));
      items = alignCategoriesToLedger(items, categories, usableHistoricalSamples);
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
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
