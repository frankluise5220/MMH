import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

const ParsedItemSchema = z.object({
  rawText: z.string(),
  type: z.enum(["expense", "income", "transfer", "investment"]),
  date: z.string().optional(),
  amount: z.number(),
  account: z.string().optional(),
  fromAccount: z.string().optional(),
  toAccount: z.string().optional(),
  category: z.string().optional(),
  remark: z.string().optional(),
  counterparty: z.string().optional(),
});

type ParsedItem = z.infer<typeof ParsedItemSchema>;

const ALIAS_PATTERNS: Array<{ pattern: RegExp; counterparty: string; category?: string }> = [
  { pattern: /支付宝[^-]*-?(.*)/, counterparty: "支付宝", category: "购物" },
  { pattern: /财付通[^-]*-?(.*)/, counterparty: "微信支付", category: "购物" },
  { pattern: /微信支付/, counterparty: "微信支付", category: "购物" },
  { pattern: /美团(平台)?商户?/, counterparty: "美团", category: "餐饮" },
  { pattern: /美团外卖/, counterparty: "美团外卖", category: "餐饮" },
  { pattern: /大众点评/, counterparty: "大众点评", category: "餐饮" },
  { pattern: /饿了么/, counterparty: "饿了么", category: "餐饮" },
  { pattern: /携程/, counterparty: "携程", category: "旅游" },
  { pattern: /滴滴出行|打车/, counterparty: "滴滴出行", category: "交通" },
  { pattern: /地铁|公交/, counterparty: "公共交通", category: "交通" },
  { pattern: /停车/, counterparty: "停车场", category: "交通" },
  { pattern: /移动|联通|电信/, counterparty: "运营商", category: "通讯" },
  { pattern: /(水|电|燃气|天然气|暖气)/, counterparty: "水电燃气", category: "生活缴费" },
  { pattern: /(物业|管理费)/, counterparty: "物业", category: "居住" },
  { pattern: /京东(到家)?/, counterparty: "京东", category: "购物" },
  { pattern: /天猫|淘宝/, counterparty: "淘宝/天猫", category: "购物" },
  { pattern: /拼多多/, counterparty: "拼多多", category: "购物" },
  { pattern: /盒马/, counterparty: "盒马鲜生", category: "餐饮" },
  { pattern: /(永辉|沃尔玛|家乐福|大润发)/, counterparty: "超市", category: "购物" },
  { pattern: /(顺丰|圆通|中通|韵达|申通|邮政)/, counterparty: "快递", category: "购物" },
  { pattern: /(医保|社保|药店)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(医院|诊所|挂号)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(学费|培训|教育)/, counterparty: "教育", category: "教育" },
  { pattern: /(会员|订阅|自动续费)/, counterparty: "会员", category: "娱乐" },
  { pattern: /(爱奇艺|腾讯视频|优酷|哔哩)/, counterparty: "视频会员", category: "娱乐" },
  { pattern: /(星巴克|瑞幸|喜茶|奈雪)/, counterparty: "咖啡茶饮", category: "餐饮" },
  { pattern: /(麦当劳|肯德基|汉堡王)/, counterparty: "快餐", category: "餐饮" },
  { pattern: /云闪付/, counterparty: "云闪付", category: "购物" },
];

function aliasMatch(text: string): { counterparty: string; category: string } {
  for (const { pattern, counterparty, category } of ALIAS_PATTERNS) {
    if (pattern.test(text)) {
      const m = text.match(pattern);
      const extra = m && m[1] ? m[1].trim() : "";
      return { counterparty: extra && extra !== counterparty ? `${counterparty}-${extra}` : counterparty, category: category ?? "购物" };
    }
  }
  return { counterparty: "", category: "" };
}

function isNoiseLine(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
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

function extractAmount(text: string): number {
  const nums = text.match(/[\d,]+\.?\d*/g) ?? [];
  let best = 0;
  for (const s of nums) {
    const v = parseFloat(s.replace(/,/g, ""));
    if (!Number.isFinite(v) || v <= 0) continue;
    if (v > 10000) continue;
    best = v;
  }
  return best;
}

function extractDate(line: string): string | undefined {
  const m = line.match(/\b(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})\b/);
  if (!m) return undefined;
  return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
}

function isLikelyTransfer(text: string): boolean {
  return /转账|还款|还款|转入|转出|汇款|充值|提现/i.test(text);
}

function parseStructuredStatement(text: string): ParsedItem[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: ParsedItem[] = [];

  for (const line of lines) {
    if (isNoiseLine(line)) continue;

    const date = extractDate(line);
    const amount = extractAmount(line);
    if (!date && amount === 0) continue;

    const { counterparty, category } = aliasMatch(line);
    const isIncome = /收入|工资|报销|退款|返现|返利|到账|奖金|红包/i.test(line);
    const isTransfer = isLikelyTransfer(line);

    const type = isTransfer ? "transfer" : isIncome ? "income" : "expense";

    items.push({
      rawText: line,
      type,
      date,
      amount: amount || 0,
      counterparty: counterparty || undefined,
      category: category || undefined,
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

  const { counterparty, category } = aliasMatch(text);

  return [{
    rawText: text,
    type: isTransfer ? "transfer" : isIncome ? "income" : "expense",
    date: dateM ? `${dateM[1]}-${dateM[2].padStart(2,"0")}-${dateM[3].padStart(2,"0")}` : undefined,
    amount,
    counterparty: counterparty || undefined,
    category: category || undefined,
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
