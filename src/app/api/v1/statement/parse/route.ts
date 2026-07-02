import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ParsedItemMeta = {
  institutionName?: string;
  ownerName?: string;
  cardNumberMasked?: string;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
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
  { pattern: /停车/, counterparty: "停车场", category: "交通" },
  { pattern: /移动|联通|电信/, counterparty: "运营商", category: "通讯" },
  { pattern: /(水|电|燃气|天然气|暖气)/, counterparty: "水电燃气", category: "生活缴费" },
  { pattern: /(物业|管理费)/, counterparty: "物业", category: "居住" },
  { pattern: /京东(到家)?|网银在线/, counterparty: "京东", institution: "京东", category: "购物" },
  { pattern: /天猫|淘宝/, counterparty: "淘宝/天猫", institution: "淘宝/天猫", category: "购物" },
  { pattern: /拼多多|付费通/, counterparty: "拼多多", institution: "拼多多", category: "购物" },
  { pattern: /盒马/, counterparty: "盒马鲜生", institution: "盒马鲜生", category: "餐饮" },
  { pattern: /(永辉|沃尔玛|家乐福|大润发)/, counterparty: "超市", category: "购物" },
  { pattern: /(顺丰|圆通|中通|韵达|申通|邮政)/, counterparty: "快递", category: "购物" },
  { pattern: /(医保|社保|药店)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(医院|诊所|挂号)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(学费|培训|教育)/, counterparty: "教育", category: "教育" },
  { pattern: /(会员|订阅|自动续费)/, counterparty: "会员", category: "娱乐" },
  { pattern: /(爱奇艺|腾讯视频|优酷|哔哩)/, counterparty: "视频会员", category: "娱乐" },
  { pattern: /(星巴克|瑞幸|喜茶|奈雪)/, counterparty: "咖啡茶饮", category: "餐饮" },
  { pattern: /(麦当劳|肯德基|汉堡王)/, counterparty: "快餐", category: "餐饮" },
  { pattern: /云闪付/, counterparty: "云闪付", institution: "云闪付", category: "购物" },
];

function cleanupMerchantName(value: string) {
  return value
    .replace(/^[-—\s]+/, "")
    .replace(/[（(]\s*入账日\s*\d{4}[-\/.年]\d{1,2}[-\/.月]\d{1,2}\s*[)）]/g, "")
    .replace(/[（(]\s*特约\s*[)）]/g, "")
    .replace(/^(快捷|支付|平台商户|商户)+[-—\s]*/, "")
    .trim();
}

function extractMerchant(text: string) {
  const split = text.split(/--|－|—/).map((item) => item.trim()).filter(Boolean);
  if (split.length >= 2) return cleanupMerchantName(split.slice(1).join("-"));
  const jd = text.match(/京东支付[-—]?(.+)/);
  if (jd?.[1]) return cleanupMerchantName(jd[1]);
  return "";
}

function aliasMatch(text: string): { counterparty: string; category: string; institution: string } {
  const normalizedText = cleanupMerchantName(text).replace(/特约商户?/g, "").trim();
  for (const { pattern, counterparty, category, institution } of ALIAS_PATTERNS) {
    const matchText = pattern.test(normalizedText) ? normalizedText : text;
    if (pattern.test(matchText)) {
      const m = matchText.match(pattern);
      const extra = cleanupMerchantName(extractMerchant(matchText) || (m && m[1] ? m[1].trim() : ""));
      return {
        counterparty: extra || counterparty,
        category: category ?? "购物",
        institution: institution ?? counterparty,
      };
    }
  }
  return { counterparty: "", category: "", institution: "" };
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
  return {
    ...item,
    category: cleanOptionalText(item.category) || matched.category || undefined,
    institution: cleanOptionalText(item.institution) || matched.institution || matched.counterparty || undefined,
    counterparty: cleanOptionalText(item.counterparty) || matched.counterparty || undefined,
    remark: cleanOptionalText(item.remark),
  };
}

function isNoiseLine(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (isStatementSummaryText(l)) return true;
  if (/^(账户信息|账单信息|交易明细|消费明细|还款明细|积分明细|银行名称|卡号后四位)/i.test(l)) return true;
  if (/^(本期账单日|账单日|还款日|信用额度|取现额度|账单周期)/i.test(l)) return true;
  if (/^(主卡|副卡|Main Card)/i.test(l)) return true;
  if (/^(New Balance|Previous Balance|自动还款|扣款账号|Debit Account)/i.test(l)) return true;
  if (/^(本期应还|本期余额|最低还款|积分|利息|手续费)/i.test(l)) return true;
  if (/^(合计|Summary|Total|小计)/i.test(l)) return true;
  if (/^¥?\s*[\d,]+\.?\d*\s*(¥|元|$|美元)?$/i.test(l) && l.length < 25) return true;
  if (/^[—\-=:|]{3,}$/.test(l)) return true;
  if (/^(交易日期|记账日期|交易说明|金额|类型|备注)/i.test(l)) return true;
  if (/^(\d{4})[-\/.]?\s*(\d{1,2})[-\/.]?\s*(\d{1,2})[\s-]*\d{4}/.test(l)) return true;
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
  if (!m) return undefined;
  return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
}

function normalizeDateTimeCell(value?: string): string | undefined {
  const raw = String(value ?? "").trim().replace(/\s+/g, " ");
  const match = raw.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日)?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return undefined;
  const ymd = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  if (!match[4]) return ymd;
  const time = `${match[4].padStart(2, "0")}:${match[5]}${match[6] ? `:${match[6]}` : ""}`;
  return `${ymd} ${time}`;
}

function isLikelyTransfer(text: string): boolean {
  return /转账|还款|还款|转入|转出|汇款|充值|提现/i.test(text);
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
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

function extractTableCells(rowHtml: string) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => stripHtml(match[1]));
}

function parseMoney(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseLooseNumber(value?: string) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const valueNumber = Number(match[0]);
  return Number.isFinite(valueNumber) ? valueNumber : undefined;
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

function extractCreditCardMeta(text: string): ParsedItemMeta & { accountName?: string } {
  const plain = stripHtml(text);
  const institutionName = detectBankName(plain);
  const ownerName = plain.match(/尊敬的\s*([\u4e00-\u9fa5·]{2,8})\s*(?:先生|女士|小姐)?\s*您好/)?.[1]?.trim();
  const cardNumberMasked = plain.match(/卡号末四位\s*(\d{4})/)?.[1] ?? extractImportLikeLast4(plain);
  const creditLimit = parseLooseNumber(plain.match(/固定额度(?:\([^)]*\)|（[^）]*）)?\s*[:：]?\s*([\d,]+(?:\.\d+)?)/)?.[1]);
  const periodMatch = plain.match(/(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})\s*[-~至—]\s*(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})/);
  const periodEnd = parseDateParts(periodMatch?.[2] ?? "");
  const directBillingDay = parseLooseNumber(plain.match(/账单日\s*[:：]?\s*(\d{1,2})\s*日?/)?.[1]);
  const dueDate = parseDateParts(plain.match(/(?:到期还款日|最后还款日|还款日)\s*[:：]?\s*(\d{4}[年\/\-.]\d{1,2}[月\/\-.]\d{1,2})/)?.[1]);
  const billingDay = directBillingDay && directBillingDay >= 1 && directBillingDay <= 31 ? directBillingDay : periodEnd?.day;
  const repaymentDay = dueDate?.day;
  const accountCore = institutionName ? `${institutionName}信用卡${cardNumberMasked ? `(${cardNumberMasked})` : ""}` : undefined;
  const accountName = ownerName && accountCore ? `${ownerName}的${accountCore}` : accountCore;

  return {
    institutionName: institutionName || undefined,
    ownerName: ownerName || undefined,
    cardNumberMasked: cardNumberMasked || undefined,
    creditLimit,
    billingDay,
    repaymentDay,
    accountName,
  };
}

function extractImportLikeLast4(value: string) {
  const matches = Array.from(value.matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1][0] : "";
}

function parseCreditCardHtmlStatement(text: string): ParsedItem[] {
  if (!/<tr[\s>]/i.test(text) || !/(交易日期|Trans Date|交易摘要|Trans Description|人民币金额|Amount\(RMB\))/i.test(text)) {
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
  };
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  let inTransactionRows = false;

  for (const row of text.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const rowText = stripHtml(row);
    if (/(交易日期|Trans Date)/i.test(rowText) && /(交易摘要|Trans Description)/i.test(rowText)) {
      inTransactionRows = true;
      continue;
    }
    if (!inTransactionRows) continue;
    if (/(分期说明|账单说明|温馨提示|最新活动信息|版权所有)/i.test(rowText)) break;
    if (isStatementSummaryText(rowText)) continue;

    const cells = extractTableCells(row);
    if (cells.length < 5) continue;

    const transDate = cells[0]?.trim();
    const postedDate = cells[1]?.trim();
    const description = cells[2]?.trim();
    const amountCell = cells[4]?.trim() || cells[3]?.trim();
    const date = normalizeDateTimeCell(transDate);
    if (!date || !description) continue;
    if (isStatementSummaryText(description)) continue;

    const amount = parseMoney(amountCell);
    if (amount === null || amount === 0) continue;

    const postDate = normalizeDateTimeCell(postedDate);
    const absAmount = Math.abs(amount);
    const { counterparty, category, institution } = aliasMatch(description);
    const type = isLikelyTransfer(description) ? "transfer" : amount < 0 || /退款|退货|返现|冲正/.test(description) ? "income" : "expense";
    const key = `${date}|${postDate ?? ""}|${description}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      rawText: `${date} ${description} ${amountCell}`,
      type,
      date,
      amount: absAmount,
      account,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
      remark: postDate && postDate !== date ? `${description}（入账日 ${postDate}）` : description,
      postedDate: postDate,
      _meta: Object.values(itemMeta).some((value) => value !== undefined) ? itemMeta : undefined,
    });
  }

  return items;
}

function parseStructuredStatement(text: string): ParsedItem[] {
  const htmlItems = parseCreditCardHtmlStatement(text);
  if (htmlItems.length > 0) return htmlItems;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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

    const type = isTransfer ? "transfer" : isIncome ? "income" : "expense";

    items.push({
      rawText: line,
      type,
      date,
      amount: amount || 0,
      counterparty: counterparty || undefined,
      institution: institution || undefined,
      category: category || undefined,
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
  const isTransfer = /转账|还款|转入|转出|充值|提现/i.test(text);

  const { counterparty, category, institution } = aliasMatch(text);

  return [{
    rawText: text,
    type: isTransfer ? "transfer" : isIncome ? "income" : "expense",
    date: dateM ? `${dateM[1]}-${dateM[2].padStart(2,"0")}-${dateM[3].padStart(2,"0")}` : undefined,
    amount,
    counterparty: counterparty || undefined,
    institution: institution || undefined,
    category: category || undefined,
    remark: text,
  }];
}

export async function POST(req: Request) {
  try {
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
