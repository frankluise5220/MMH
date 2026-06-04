import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { TransactionType } from "@prisma/client";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

async function logDistill(payload: {
  source: string;
  rawInput: string;
  preprocessed?: string;
  promptSent?: string;
  llmResponse?: string;
  parsedItems?: unknown;
  operationType?: string;
  finalResult?: unknown;
  trace?: string[];
  modelName?: string;
  latencyMs?: number;
  success: boolean;
  errorMsg?: string;
}) {
  try {
    await prisma.distillLog.create({
      data: {
        source: payload.source,
        rawInput: payload.rawInput.slice(0, 20000),
        preprocessed: payload.preprocessed?.slice(0, 20000),
        promptSent: payload.promptSent?.slice(0, 20000),
        llmResponse: payload.llmResponse?.slice(0, 20000),
        parsedItems: payload.parsedItems ? JSON.stringify(payload.parsedItems).slice(0, 20000) : undefined,
        operationType: payload.operationType,
        finalResult: payload.finalResult ? JSON.stringify(payload.finalResult).slice(0, 20000) : undefined,
        trace: payload.trace?.join("\n")?.slice(0, 5000),
        modelName: payload.modelName,
        latencyMs: payload.latencyMs,
        success: payload.success,
        errorMsg: payload.errorMsg?.slice(0, 2000),
      },
    });
  } catch {
    // 蒸馏日志写入失败不影响主流程
  }
}

function joinBaseUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) return `${base}${p.slice(3)}`;
  if (base.endsWith("/v1") && p.startsWith("/api/")) return `${base.slice(0, -3)}${p}`;
  return `${base}${p}`;
}

function modelSupportsVision(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return [
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-4-vision",
    "claude-3",
    "claude-3.5",
    "claude-3.7",
    "gemini-1.5",
    "gemini-2",
    "gemini-pro-vision",
    "qwen-vl",
    "qwen2-vl",
    "vision",
  ].some((m) => lower.includes(m)) || lower.includes("vision") || lower.includes("vl") || lower.includes("gemma3");
}

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

type CommandScope = {
  operation: "create" | "update" | "delete" | "restore" | "query";
  timeRange: {
    hasRange: boolean;
    year?: number;
    month?: number;
    startDay?: number;
    endDay?: number;
  };
  amountRange: {
    min?: number;
    max?: number;
  };
  accountRange: {
    keyword?: string;
  };
  remarkCondition: {
    hasRemark?: boolean;
    keyword?: string;
  };
  type?: "expense" | "income" | "transfer" | "investment";
};

function buildScopeSummary(scope: CommandScope) {
  return {
    operation: scope.operation,
    timeRange: scope.timeRange,
    amountRange: scope.amountRange,
    accountRange: scope.accountRange,
    remarkCondition: scope.remarkCondition,
    type: scope.type,
  };
}

function parseAmountRange(text: string) {
  const t = text.replace(/，|,/g, " ");
  const gt = t.match(/(?:大于|超过|高于|>\s*)(\d+(?:\.\d+)?)/);
  const lt = t.match(/(?:小于|低于|少于|<\s*)(\d+(?:\.\d+)?)/);
  const between = t.match(/(\d+(?:\.\d+)?)\s*(?:到|至|-)\s*(\d+(?:\.\d+)?)/);
  if (between) {
    const a = Number(between[1]);
    const b = Number(between[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return {
    min: gt ? Number(gt[1]) : undefined,
    max: lt ? Number(lt[1]) : undefined,
  };
}

type BillHeader = {
  statementDate?: string;
  paymentDueDate?: string;
  newBalance?: number;
  minPayment?: number;
  currency?: "CNY" | "USD";
};

function normalizeDateToken(raw: string) {
  const s = raw.trim().replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, "");
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function extractAmountNear(text: string, labels: string[]) {
  const escaped = labels.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const reg = new RegExp(`(?:${escaped})[^\\n\\r]{0,30}?(?:RMB|人民币|USD|美元)?\\s*([+-]?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})|[+-]?\\d+(?:\\.\\d{1,2})?)`, "i");
  const m = text.match(reg);
  if (!m) return undefined;
  const n = Number(String(m[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : undefined;
}

function parseBillHeader(text: string): BillHeader {
  const t = text.replace(/\u00A0/g, " ");
  const statementRaw = t.match(/(?:本期账单日|账单日|Statement\s*Date|Bill\s*Date)\s*[:：]?\s*(\d{4}[\/.年-]\d{1,2}[\/.月-]\d{1,2}日?)/i)?.[1];
  const dueRaw = t.match(/(?:本期最后还款日|最后还款日|Payment\s*Due\s*Date|Due\s*Date)\s*[:：]?\s*(\d{4}[\/.年-]\d{1,2}[\/.月-]\d{1,2}日?)/i)?.[1];
  const newBalance = extractAmountNear(t, ["本期应还款金额", "应还款金额", "New Balance", "Total Due"]);
  const minPayment = extractAmountNear(t, ["本期最低还款金额", "最低还款金额", "Min.Payment", "Min Payment", "Minimum Due"]);
  const hasCny = /RMB|人民币/i.test(t);
  const hasUsd = /USD|美元/i.test(t);
  const currency: "CNY" | "USD" | undefined = hasCny ? "CNY" : hasUsd ? "USD" : undefined;
  return {
    statementDate: statementRaw ? normalizeDateToken(statementRaw) : undefined,
    paymentDueDate: dueRaw ? normalizeDateToken(dueRaw) : undefined,
    newBalance,
    minPayment,
    currency,
  };
}

function preprocessBillText(raw: string) {
  const src = raw.replace(/\r/g, "");
  const cleaned = src
    .replace(/精彩推荐[\s\S]*?(?=本期账单交易明细|交易日\s*SOLD|$)/g, " ")
    .replace(/查看更多精彩活动[\s\S]*?(?=本期账单交易明细|交易日\s*SOLD|$)/g, " ")
    .replace(/账单也能分期还[\s\S]*?(?=本期账单交易明细|交易日\s*SOLD|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const header = parseBillHeader(src);

  const txMatches = [...src.matchAll(/(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(.{2,80}?)\s+(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2}))\s+(\d{4})(?=\s|$)/g)];
  const txLines = txMatches.slice(0, 20).map((m) => {
    const sold = m[1];
    const posted = m[2];
    const desc = m[3].trim();
    const amt = String(m[4]).replace(/,/g, "");
    const card4 = m[5];
    const y = header.statementDate ? Number(header.statementDate.slice(0, 4)) : new Date().getFullYear();
    const soldIso = `${y}-${sold.slice(0,2)}-${sold.slice(3,5)}`;
    const postedIso = `${y}-${posted.slice(0,2)}-${posted.slice(3,5)}`;
    return `${soldIso}|${postedIso}|${desc}|${amt}|${card4}`;
  });

  return { cleaned, header, txLines };
}

function buildBillHeaderContext(header: BillHeader) {
  const parts: string[] = [];
  if (header.statementDate) parts.push(`账单日=${header.statementDate}`);
  if (header.paymentDueDate) parts.push(`最后还款日=${header.paymentDueDate}`);
  if (header.newBalance != null) parts.push(`本期应还=${header.newBalance}`);
  if (header.minPayment != null) parts.push(`最低还款=${header.minPayment}`);
  if (header.currency) parts.push(`币种=${header.currency}`);
  return parts.join("；");
}

type ParsedItem = z.infer<typeof ParsedItemSchema>;

function parseBillTxLines(txLines: string[], header: BillHeader, issuerKeyword: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const line of txLines) {
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [soldIso, _, desc, amt, card4] = parts;
    const amount = parseFloat(amt);
    if (!Number.isFinite(amount)) continue;

    const isRepayment = amount < 0 || /还款|入账/.test(desc);
    const absAmt = Math.abs(amount);

    const counterparty = /支付宝/.test(desc) ? "支付宝" : /微信/.test(desc) ? "微信" : /银联/.test(desc) ? "银联" : undefined;
    const account = issuerKeyword ? `${issuerKeyword}信用卡` : undefined;

    items.push({
      rawText: line,
      type: isRepayment ? "transfer" : "expense",
      date: soldIso,
      amount: absAmt,
      account,
      remark: desc.trim(),
      counterparty,
      fromAccount: isRepayment ? "外部还款" : undefined,
    });
  }
  return items;
}

async function buildAccountContextText() {
  try {
    const accounts = await prisma.account.findMany({
      where: { isActive: true },
      include: { Institution: true },
      orderBy: [{ name: "asc" }],
      take: 300,
    });

    let aliases: Array<{ alias: string; account: { name: string; Institution: { name: string } | null } }> = [];
    try {
      const aliasModel = (prisma as any).accountAlias;
      if (aliasModel?.findMany) {
        aliases = await aliasModel.findMany({
          include: { Account: { include: { Institution: true } } },
          orderBy: [{ alias: "asc" }],
          take: 1000,
        });
      }
    } catch {
      aliases = [];
    }

    const canonical = accounts.map((a) => (a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name));

    const aliasLines = aliases
      .map((x) => {
        const target = x.account.Institution?.name ? `${x.account.Institution.name}·${x.account.name}` : x.account.name;
        return `${x.alias} => ${target}`;
      })
      .slice(0, 300);

    const lines = [
      `可用账户（严格优先匹配以下标准账户名）：${canonical.join("、") || "（暂无）"}`,
      `账户别名映射（命中别名时应归一到右侧标准账户）：${aliasLines.join("；") || "（暂无）"}`,
    ];

    return lines.join("\n");
  } catch {
    return "可用账户列表暂时无法加载，请按实际账户名称匹配。";
  }
}


const SYSTEM_PROMPT = `你是一个出色的家庭帐簿记录管理专家，你需要将用户的自然语句提炼成可对数据库进行精确操作的指令。

你的任务：识别用户语句中是否包含以下字段，并结构化返回：
1) 操作类型（operation）：create|delete|update|restore|query|stats
2) 时间范围（timeRange）：某个时间段 / 不限时间段
3) 账户范围（accountRange）：指定账户 / 不限账户
4) 金额范围（amountRange）：某个金额区间 / 不限金额
5) 备注条件（remarkCondition）：是否要求"有备注/无备注"或备注关键词

你必须输出严格 JSON，格式如下：
{
  "operation": "create|delete|update|restore|query|stats",
  "scope": {
    "timeRange": {
      "hasRange": true,
      "year": 2024,
      "month": 3,
      "startDay": 15,
      "endDay": 31,
      "unlimited": false
    },
    "accountRange": {
      "keyword": "花呗",
      "unlimited": false
    },
    "amountRange": {
      "min": 100,
      "max": 500,
      "unlimited": false
    },
    "remarkCondition": {
      "hasRemark": true,
      "keyword": "台盆"
    },
    "type": "expense|income|transfer|investment"
  },
  "items": [],
  "reason": "简要说明你的判断依据"
}

字段规则：
- 若用户未指定时间范围：timeRange.unlimited=true
- 若用户未指定账户：accountRange.unlimited=true
- 若用户未指定金额：amountRange.unlimited=true
- 用户说"消费"默认 type=expense
- 用户说"恢复这7条"可解析为 operation=restore，并在 scope 中体现 limit=7（可放在 reason 中补充）
- 如果是账单明细解析任务，operation=create 且 items 返回结构化明细
- 只输出 JSON，不要解释文字，不要 markdown。`;

/** Build fund-specific system prompt when user is viewing a fund's holdings page */
function buildFundSystemPrompt(ctx: FundContext) {
  const fundLabel = ctx.fundName ? `${ctx.fundName}(${ctx.fundCode})` : ctx.fundCode;
  const cashLabel = ctx.cashAccountId ?? "(需用户手动选择)";
  const today = new Date().toISOString().slice(0, 10);
  return `你是一个基金交易记录解析器。用户正在查看基金持仓页面。当前上下文:

基金: ${fundLabel}
基金账户ID: ${ctx.accountId}
资金账户ID: ${cashLabel}
今天日期: ${today}

用户输入的目标基金已经确定 (=${fundLabel})，你不需要提取基金代码/账户ID。
你的任务: 判断用户意图是单笔操作还是批量操作，输出对应的 JSON。

## A. 单笔操作 (operation: "single")
用户只想记录一笔交易。

输出格式:
{"operation":"single","items":[{"type":"investment","date":"YYYY-MM-DD","amount":数字,"remark":"","fundSubtype":"buy|redeem|dividend_cash","fundNav":null,"fundUnits":null,"fundFee":null}]}

- date: 默认今天(${today})，可从"昨天""5月1日""上周三"等解析
- amount: 必填，从"1000元""10块""500份""1万"提取
- fundSubtype: "buy"(买入/申购), "redeem"(赎回/卖出), "dividend_cash"(现金红利/分红到账)
- 净值和份额可选，不确定就不填

单笔示例:
"买入1000元" → {"operation":"single","items":[{"type":"investment","date":"${today}","amount":1000,"fundSubtype":"buy","fundNav":null,"fundUnits":null,"fundFee":null,"remark":""}]}
"5月1日赎回500份" → {"operation":"single","items":[{"type":"investment","date":"2026-05-01","amount":500,"fundSubtype":"redeem","fundNav":null,"fundUnits":500,"fundFee":null,"remark":""}]}
"昨天分红到账200元" → {"operation":"single","items":[{"type":"investment","date":"2026-06-03","amount":200,"fundSubtype":"dividend_cash","fundNav":null,"fundUnits":null,"fundFee":null,"remark":"红利到账"}]}

## B. 批量操作 (operation: "batch")
用户想按某个频率重复买入。输出:
{"operation":"batch","plan":{"amount":数字,"intervalUnit":"day|week|biweek|month","intervalValue":数字,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD 或 null"}}

- amount: 每期买入金额(必填)
- intervalUnit: day=每天, week=每周, biweek=每两周, month=每月
- intervalValue: 间隔数量(默认1)
- startDate: 如果提到"N月份"则取该月1日，否则取今天
- endDate: 如果提到"N月份"则取该月最后一天。无截止则 null

批量示例:
"每天投10块" → {"operation":"batch","plan":{"amount":10,"intervalUnit":"day","intervalValue":1,"startDate":"${today}","endDate":null}}
"5月份每天买50元" → {"operation":"batch","plan":{"amount":50,"intervalUnit":"day","intervalValue":1,"startDate":"2026-05-01","endDate":"2026-05-31"}}
"每周定投500" → {"operation":"batch","plan":{"amount":500,"intervalUnit":"week","intervalValue":1,"startDate":"${today}","endDate":null}}
"5月1日到6月1日每两天投100" → {"operation":"batch","plan":{"amount":100,"intervalUnit":"day","intervalValue":2,"startDate":"2026-05-01","endDate":"2026-06-01"}}

## 判断规则
- 有"每天""每周""每月""一天一""两天一""定投"等频率词 → batch
- 无频率词 → single
- 只输出 JSON，不要任何解释文字，不要 markdown`;
}

const CLASSIFY_PROMPT = `你是 WiseMe 系统的输入分类器。你的任务是根据用户输入的内容，判断其类型并输出分类结果。

用户输入可能是以下几种类型之一：
1. 自然语句（natural）：用户用自然语言描述的交易记录，如"今天在超市买了50块的东西"、"转账100元给张三"
2. 批量账单（bill_statement）：来自银行/信用卡的账单邮件或截图，包含账单日、还款日、多笔交易明细
3. 批量表格（batch_table）：多行格式化的交易记录文本，如日期+金额+备注的表格形式，每行一条记录
4. 操作指令（command）：删除、恢复、统计等操作命令，如"删除上个月的所有消费"、"恢复最近10条"

判断规则：
- 如果包含"账单日"、"最后还款日"、"本期应还"等关键词 → bill_statement
- 如果包含多行日期格式（YYYY-MM-DD）且每行有金额 → batch_table
- 如果是"删"、"恢复"、"统计"、"查询回收站"等明确操作意图 → command
- 其他情况 → natural

只输出严格 JSON，格式如下：
{
  "inputType": "natural|bill_statement|batch_table|command",
  "confidence": 0.95,
  "reason": "判断理由（1-2句话）",
  "suggestedAction": "分类后建议的处理方式（1句话）"
}

只输出 JSON，不要解释，不要 markdown。`;

function extractItemsFromText(text: string): ParsedItem[] | null {
  const patterns = [
    /```json\s*([\s\S]*?)\s*```/i,
    /```\s*([\s\S]*?)\s*```/,
    /\{[\s\S]*"items"[\s\S]*\}/,
    /\[[\s\S]*\{[\s\S]*rawText[\s\S]*\]/,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const str = m[1] ?? m[0];
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return parsed;
        if (parsed?.items && Array.isArray(parsed.items)) return parsed.items;
      } catch {
        continue;
      }
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed?.items && Array.isArray(parsed.items)) return parsed.items;
  } catch {
    return null;
  }

  return null;
}

function formatYmd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeekMonday(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function hasRelativeDateToken(text: string) {
  const t = text.trim();
  if (!t) return false;
  return /(今天|昨天|前天|上周|本周|这周|上星期|本星期|这星期|周[一二三四五六日天1-7]|星期\s*[一二三四五六日天1-7])/.test(t);
}

function parseRelativeDateFromText(text: string, now: Date) {
  const t = text.trim();
  if (!t) return null;

  if (/(^|[^\u4e00-\u9fa5])(今天)([^\u4e00-\u9fa5]|$)/.test(t)) return formatYmd(now);
  if (/(昨天|昨日)/.test(t)) return formatYmd(addDays(now, -1));
  if (/前天/.test(t)) return formatYmd(addDays(now, -2));

  const w = t.match(/(上周|本周|这周|上星期|本星期|这星期)?\s*(周|星期)\s*([一二三四五六日天1-7])/);
  if (w) {
    const prefix = w[1] ?? "";
    const weekdayChar = w[3];
    const weekdayIndex =
      weekdayChar === "一"
        ? 0
        : weekdayChar === "二"
          ? 1
          : weekdayChar === "三"
            ? 2
            : weekdayChar === "四"
              ? 3
              : weekdayChar === "五"
                ? 4
                : weekdayChar === "六"
                  ? 5
                  : weekdayChar === "7"
                    ? 6
                    : weekdayChar === "1"
                      ? 0
                      : weekdayChar === "2"
                        ? 1
                        : weekdayChar === "3"
                          ? 2
                          : weekdayChar === "4"
                            ? 3
                            : weekdayChar === "5"
                              ? 4
                              : weekdayChar === "6"
                                ? 5
                                : 6;

    const base = startOfWeekMonday(now);
    if (prefix.startsWith("上")) return formatYmd(addDays(base, -7 + weekdayIndex));
    if (prefix.startsWith("本") || prefix.startsWith("这")) return formatYmd(addDays(base, weekdayIndex));

    const candidate = addDays(base, weekdayIndex);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    if (candidate.getTime() > todayStart.getTime()) return formatYmd(addDays(candidate, -7));
    return formatYmd(candidate);
  }

  return null;
}

function parseAmountLoose(value: unknown, fallbackText: string) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value);
  if (typeof value === "string") {
    const m = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (m) return Math.abs(Number(m[0]));
  }
  const matches = fallbackText.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g) ?? [];
  if (matches.length) return Math.abs(Number(matches[matches.length - 1]));
  return 0;
}

function normalizeDate(dateInput: unknown, rawText: string, now: Date) {
  const rel = parseRelativeDateFromText(rawText, now);
  if (rel && hasRelativeDateToken(rawText)) return rel;
  const dateStr = typeof dateInput === "string" ? dateInput.trim() : "";
  if (dateStr) {
    const d = new Date(dateStr.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, ""));
    if (!Number.isNaN(d.getTime())) return formatYmd(d);
  }
  return rel ?? formatYmd(now);
}

function isReadyForImport(item: ParsedItem) {
  if (!(item.amount > 0)) return false;
  if (item.type === "transfer") return !!(item.fromAccount?.trim() && item.toAccount?.trim());
  return true;
}

function isBillStatement(text: string) {
  const t = text ?? "";
  if (/(基金交易记录|基金定期定额|申购|赎回|交易日期.*交易时间)/i.test(t)) return false;
  return /(账单日|最后还款日|本期应还|最低还款|信用额度|Statement\s*Date|Payment\s*Due\s*Date|New\s*Balance|Min\.Payment)/i.test(t);
}

function extractBankKeywordFromBill(text: string) {
  if (/民生/.test(text)) return "民生银行";
  if (/平安/.test(text)) return "平安银行";
  if (/招商|招行/.test(text)) return "招商银行";
  if (/交通|交行/.test(text)) return "交通银行";
  if (/中信/.test(text)) return "中信银行";
  if (/光大/.test(text)) return "光大银行";
  if (/华夏/.test(text)) return "华夏银行";
  if (/浦发/.test(text)) return "浦发银行";
  if (/兴业/.test(text)) return "兴业银行";
  if (/广发/.test(text)) return "广发银行";
  if (/邮储/.test(text)) return "邮储银行";
  if (/工商|工行/.test(text)) return "工商银行";
  if (/农业|农行/.test(text)) return "农业银行";
  if (/建设|建行/.test(text)) return "建设银行";
  if (/中国银行|中行/.test(text)) return "中国银行";
  return "";
}

function looksLikeBatchLedgerText(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (/交易日期.*交易时间.*支出.*余额.*交易类型/i.test(t)) return false;
  const matches = t.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (matches.length < 3) return false;
  return true;
}

function isCMBFundRecord(text: string) {
  const t = text ?? "";
  if (!/交易日期.*交易时间.*支出.*余额.*交易类型/i.test(t)) return false;
  if (/账单日|最后还款日|本期应还|信用额度/i.test(t)) return false;
  return true;
}

// ---- Fund natural language pre-processing ----

type FundContext = { fundCode: string; fundName?: string; accountId: string; cashAccountId?: string };

/** Detect if text looks like a fund trade expressed in natural language */
function looksLikeFundTrade(text: string) {
  const t = text.trim();
  if (!t || t.length > 200) return false;
  return /(买入|卖出|赎回|申购|红利转投|红利再投|现金红利|转出|转入)/.test(t) &&
    /\d{6}/.test(t);
}

/** Parse regular invest plan creation from natural language with fund context */
function parseCMBFundRecord(text: string, now: Date): { items: ParsedItem[]; directImport: boolean } {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const rows: ParsedItem[] = [];
  for (const line of lines) {
    const parts = line.split(/\|/).map(p => p.trim().replace(/"/g, ""));
    if (parts.length < 6) continue;
    const dateStr = parts[0].replace(/\D/g, "");
    if (!/^\d{8}$/.test(dateStr)) continue;
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const expense = parseFloat(parts[3]) || 0;
    if (expense <= 0) continue;
    const fundCode = (parts[parts.length - 1] || "").replace(/\D/g, "").slice(-6);
    const remark = parts[parts.length - 1]?.trim() || "";
    const isRedeem = /赎回/.test(remark);
    const rawText = `${isRedeem ? "赎回" : "买入"} ${fundCode} ${expense}元`;
    rows.push({
      rawText: rawText.slice(0, 200),
      type: "investment",
      date,
      amount: expense,
      remark: remark && /\d{6}/.test(remark) ? remark : `${fundCode} ${isRedeem ? "赎回" : "申购"}`,
      account: "招商银行",
      counterparty: /\d{6}/.test(fundCode) ? `基金${fundCode}` : undefined,
      // Fund code embedded in rawText for downstream extraction
      ...(fundCode ? { category: `基金·${fundCode}` } : {}),
    });
  }
  return { items: rows, directImport: rows.length > 0 };
}

function parseItems(raw: string, now: Date, userTextForContext: string): { items: ParsedItem[]; directImport: boolean } {
  const items = extractItemsFromText(raw);
  if (!items || items.length === 0) {
    const ctx = (userTextForContext || raw).trim();
    const fallback: ParsedItem = {
      rawText: ctx.slice(0, 200),
      type: "expense",
      amount: parseAmountLoose(undefined, ctx),
      date: normalizeDate(undefined, ctx, now),
    };
    return { items: [fallback], directImport: isReadyForImport(fallback) };
  }
  const parsedItems = items.map((item) => {
    const rawText = (item.rawText ?? "").trim() || userTextForContext.slice(0, 200) || raw.slice(0, 200);
    const ctxText = `${userTextForContext}\n${rawText}`.trim();
    const typeFromModel = (item.type as ParsedItem["type"]) || "expense";
    const date = normalizeDate(item.date, ctxText, now);
    const amount = parseAmountLoose(item.amount, ctxText);
    return {
      rawText,
      type: typeFromModel,
      date,
      amount,
      account: item.account?.trim() ? item.account : undefined,
      fromAccount: item.fromAccount,
      toAccount: item.toAccount,
      category: item.category,
      remark: item.remark,
      counterparty: item.counterparty,
    };
  });
  const allValid = parsedItems.every(isReadyForImport);
  return { items: parsedItems, directImport: allValid };
}

function normalizeOperationText(text: string) {
  let t = text.trim();
  t = t.replace(/删掉|去掉|不要了|移除/g, "删除");
  t = t.replace(/还原/g, "恢复");
  t = t.replace(/看看|查下|看一下/g, "查询");
  t = t.replace(/算一下|统计一下|统计下|汇总/g, "统计");
  t = t.replace(/改成|改成|改为|改成|改称/g, "更新");
  return t;
}

function parseUpdateCommand(text: string) {
  const t = normalizeOperationText(text);
  if (!t) return null;

  const sqlStyleMatch = t.match(/^replace\s+(.+?)\s+with\s+(.+?)\s+for\s+(.+?)$/i);
  if (sqlStyleMatch) {
    return {
      remarkKeyword: sqlStyleMatch[3].trim(),
      newAccountName: sqlStyleMatch[2].trim(),
    };
  }

  const naturalMatch = t.match(/把所有备注包含(.+?)的记录.*改成(.+?)(?:$|，|。|的话)/);
  if (naturalMatch) {
    return {
      remarkKeyword: naturalMatch[1].trim(),
      newAccountName: naturalMatch[2].trim(),
    };
  }

  const simpleMatch = t.match(/备注包含(.+?).*改成(.+?)(?:$|，|。)/);
  if (simpleMatch) {
    return {
      remarkKeyword: simpleMatch[1].trim(),
      newAccountName: simpleMatch[2].trim(),
    };
  }

  const explicitMatch = t.match(/(?:把|把.+的)?记录.*账户.*改成(.+?)(?:吧|，|$)/);
  const expenseMatch = t.match(/支出改(投资|收入|转账)/);
  if (explicitMatch || expenseMatch) {
    return {
      remarkKeyword: "",
      newAccountName: explicitMatch ? explicitMatch[1].trim() : "",
      newType: expenseMatch ? expenseMatch[1].trim() : undefined,
    };
  }

  return null;
}

function parseBulkUpdateCommand(text: string) {
  const t = text.trim();
  if (/^修改/.test(t)) {
    const dateMatch = t.match(/(\d{1,2})号/);
    const monthMatch = t.match(/(\d{1,2})月/);
    const allMatch = /所有/.test(t);
    if (dateMatch || monthMatch || allMatch) {
      return { targetText: t };
    }
  }
  return null;
}

function parseBatchEditCommand(text: string) {
  const t = text.trim();
  if (!/^修改/.test(t)) return null;

  const year = new Date().getFullYear();
  let yearMatch = t.match(/(\d{4})年/);
  const targetYear = yearMatch ? Number(yearMatch[1]) : year;

  let targetMonth: number | undefined = undefined;
  const monthMatch = t.match(/(\d{1,2})月/);
  if (monthMatch) targetMonth = Number(monthMatch[1]);

  let targetDay: number | undefined = undefined;
  const dayMatch = t.match(/(\d{1,2})号/);
  if (dayMatch) targetDay = Number(dayMatch[1]);

  let accountKeyword: string | undefined = undefined;
  if (/招行|招商/.test(t)) accountKeyword = "招商";
  else if (/花呗/.test(t)) accountKeyword = "花呗";
  else if (/微信/.test(t)) accountKeyword = "微信";
  else if (/支付宝/.test(t)) accountKeyword = "支付宝";
  else {
    const m = t.match(/(?:所有|的)(.+?)(?:交易|记录)/);
    if (m?.[1]) accountKeyword = m[1].trim();
  }

  return {
    year: targetYear,
    month: targetMonth,
    day: targetDay,
    accountKeyword: accountKeyword || undefined,
  };
}

async function executeBatchEditPlan(plan: { year: number; month?: number; day?: number; accountKeyword?: string }) {
  const where: Record<string, unknown> = { deletedAt: null };

  if (plan.day) {
    const start = new Date(Date.UTC(plan.year, (plan.month ?? 1) - 1, plan.day, 0, 0, 0));
    const end = new Date(Date.UTC(plan.year, (plan.month ?? 1) - 1, plan.day + 1, 0, 0, 0));
    where.transaction = { date: { gte: start as Date, lt: end as Date }, deletedAt: null };
  } else if (plan.month) {
    const start = new Date(Date.UTC(plan.year, plan.month - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(plan.year, plan.month, 1, 0, 0, 0));
    where.transaction = { date: { gte: start as Date, lt: end as Date }, deletedAt: null };
  } else {
    where.transaction = { deletedAt: null };
  }

  if (plan.accountKeyword) {
    where.accountName = { contains: plan.accountKeyword };
  }

  const entries = await prisma.txRecord.findMany({
    where,
    take: 100,
    orderBy: [{ date: "desc" }],
  });

  const targets = entries.map(e => ({
    id: e.id,
    transactionId: e.id,
    date: e.date.toISOString().slice(0, 10),
    accountName: e.accountName,
    amount: Number(e.amount),
    remark: e.note ?? "",
    type: e.type ?? "expense",
  }));

  return {
    ok: true,
    count: entries.length,
    targets,
    requiresConfirm: true,
  };
}

async function executeUpdatePlan(plan: { remarkKeyword: string; newAccountName: string; newType?: string }, apply: boolean, accountName?: string) {
  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    include: { Institution: true },
    take: 300,
  });

  let accountId: string | undefined = undefined;
  let accountFullName = "";
  if (plan.newAccountName) {
    const account = accounts.find(a => a.name.includes(plan.newAccountName) || a.Institution?.name.includes(plan.newAccountName));
    if (!account) {
      return { ok: false, error: `未找到账户：${plan.newAccountName}` };
    }
    accountId = account.id;
    accountFullName = account.name;
  }

  const where: Record<string, unknown> = { deletedAt: null };
  if (plan.remarkKeyword) {
    where.note = { contains: plan.remarkKeyword };
  }
  if (accountName) {
    where.accountName = accountName;
  }

  const entries = await prisma.txRecord.findMany({
    where,
    take: 500,
  });

  if (!apply) {
    return {
      ok: true,
      requiresConfirm: true,
      count: entries.length,
      accountName: accountFullName,
      targets: entries.slice(0, 10).map(e => ({
        transactionId: e.id,
        date: e.date.toISOString().slice(0, 10),
        accountName: e.accountName,
        amount: Number(e.amount),
        remark: e.note ?? "",
        type: e.type ?? "expense",
      })),
    };
  }

  const data: Record<string, unknown> = {};
  if (accountId) {
    data.accountId = accountId;
    data.accountName = accountFullName;
  }
  if (plan.newType) {
    data.type = plan.newType;
  }

  const result = await prisma.txRecord.updateMany({
    where: { id: { in: entries.map(e => e.id) } },
    data,
  });

  return {
    ok: true,
    updatedCount: result.count,
    accountName: accountFullName,
    requiresConfirm: false,
  };
}

function parseDeleteCommand(text: string) {
  const t = normalizeOperationText(text);
  if (!t) return null;
  if (!/^删除/.test(t)) return null;

  const ym = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  const hasMonth = !!ym;
  const year = hasMonth ? Number(ym![1]) : undefined;
  const month = hasMonth ? Number(ym![2]) : undefined;
  if (hasMonth && (!Number.isFinite(year) || !Number.isFinite(month) || (month as number) < 1 || (month as number) > 12)) return null;

  const type = /收入/.test(t) ? "income" : /转账/.test(t) ? "transfer" : "expense";

  let startDay = 1;
  let endDay = 31;

  if (hasMonth) {
    const daysInMonth = new Date(year as number, month as number, 0).getDate();
    startDay = 1;
    endDay = daysInMonth;

    const rangeMatch = t.match(/(\d{1,2})\s*(?:号|日)?\s*(?:到|至|\-|~)\s*(\d{1,2})\s*(?:号|日)?/);
    const afterMatch = t.match(/(\d{1,2})\s*(?:号|日)?\s*(?:以后|之后|后)/);
    const beforeMatch = t.match(/(\d{1,2})\s*(?:号|日)?\s*(?:以前|之前|前)/);

    if (rangeMatch) {
      startDay = Number(rangeMatch[1]);
      endDay = Number(rangeMatch[2]);
    } else if (afterMatch) {
      startDay = Number(afterMatch[1]);
      endDay = daysInMonth;
    } else if (beforeMatch) {
      startDay = 1;
      endDay = Number(beforeMatch[1]);
    }

    startDay = Math.max(1, Math.min(daysInMonth, startDay));
    endDay = Math.max(1, Math.min(daysInMonth, endDay));
    if (startDay > endDay) {
      const tmp = startDay;
      startDay = endDay;
      endDay = tmp;
    }
  }

  let accountQuery = "";
  if (/招行信用卡|招商信用卡|信用卡/.test(t) && /招行|招商/.test(t)) accountQuery = "招商信用卡";
  else if (/花呗/.test(t)) accountQuery = "花呗";
  else if (/微信/.test(t)) accountQuery = "微信";
  else if (/支付宝/.test(t)) accountQuery = "支付宝";
  else if (/招行|招商/.test(t)) accountQuery = "招商";

  if (!accountQuery) {
    const m = t.match(/(?:所有|全部)?(?:的)?(.+?)(?:消费|记录|明细)/);
    if (m?.[1]) accountQuery = m[1].trim();
  }
  if (!accountQuery) return null;

  return {
    year: year as number | undefined,
    month: month as number | undefined,
    hasMonth,
    startDay,
    endDay,
    accountQuery,
    type: type as "expense" | "income" | "transfer",
  };
}

async function executeDeletePlan(plan: { year?: number; month?: number; hasMonth: boolean; startDay: number; endDay: number; accountQuery: string; type: "expense" | "income" | "transfer"; amountRange?: { min?: number; max?: number }; remarkCondition?: { hasRemark?: boolean; keyword?: string } }, apply: boolean) {
  const start = plan.hasMonth ? new Date(Date.UTC(plan.year as number, (plan.month as number) - 1, plan.startDay, 0, 0, 0)) : null;
  const end = plan.hasMonth ? new Date(Date.UTC(plan.year as number, (plan.month as number) - 1, plan.endDay + 1, 0, 0, 0)) : null;

  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    include: { Institution: true },
    orderBy: { name: "asc" },
    take: 300,
  });

  const q = plan.accountQuery.trim();
  const candidates = accounts.filter((a) => {
    const inst = (a.Institution?.name ?? "").trim();
    const label = inst ? `${inst}·${a.name}` : a.name;
    return a.name.includes(q) || inst.includes(q) || label.includes(q) || q.includes(a.name);
  });

  const picked = candidates.find((a) => a.name === q) ?? candidates[0] ?? null;
  if (!picked) {
    return { ok: false as const, error: `未找到账户：${plan.accountQuery}` };
  }

  const txType =
    plan.type === "expense" ? TransactionType.expense : plan.type === "income" ? TransactionType.income : TransactionType.transfer;

  const txIds = await prisma.txRecord.findMany({
    where: {
      accountId: picked.id,
      deletedAt: null,
      type: txType,
      date: { gte: start as Date, lt: end as Date },
    },
    select: { id: true },
    take: 20000,
  });

  const ids = txIds.map((r) => r.id);
  if (ids.length === 0) {
    return { ok: true as const, deletedCount: 0, accountName: picked.name, targets: [] as Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string }> };
  }

  const preview = await prisma.txRecord.findMany({
    where: { id: { in: ids } },
    orderBy: [{ date: "desc" }],
    take: 5,
  });

  const targets = preview.map((tx) => {
    return {
      transactionId: tx.id,
      date: tx.date.toISOString().slice(0, 10),
      accountName: tx.accountName,
      amount: Number(tx.amount),
      remark: tx.note ?? "",
    };
  });

  if (!apply && ids.length > 5) {
    return { ok: true as const, deletedCount: ids.length, accountName: picked.name, requiresConfirm: true as const, targets };
  }

  const deletedAt = new Date();
  const res = await prisma.txRecord.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt },
  });

  return { ok: true as const, deletedCount: res.count, accountName: picked.name, deletedAt, requiresConfirm: false as const, targets };
}

function parseRestoreCommand(text: string) {
  const t = text.trim();
  if (!t) return null;
  if (!/^恢复/.test(t) && !/^还原/.test(t)) return null;
  const m = t.match(/(\d+)\s*条/);
  const take = Math.max(1, Math.min(100, m ? Number(m[1]) : 1));
  return { take };
}

async function executeRestorePlan(plan: { take: number }, apply: boolean) {
  const rows = await prisma.txRecord.findMany({
    where: { deletedAt: { not: null } },
    orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
    take: plan.take,
  });
  if (!rows.length) return { ok: true as const, restoredCount: 0, requiresConfirm: false as const, targets: [] as Array<{ date: string; accountName: string; amount: number; remark: string }> };

  const targets = rows.slice(0, 5).map((tx) => {
    return {
      date: tx.date.toISOString().slice(0, 10),
      accountName: tx.accountName,
      amount: Number(tx.amount),
      remark: tx.note ?? "",
    };
  });

  if (!apply && rows.length > 5) {
    return { ok: true as const, restoredCount: rows.length, requiresConfirm: true as const, targets };
  }

  const ids = rows.map((r) => r.id);
  const res = await prisma.txRecord.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: null },
  });
  return { ok: true as const, restoredCount: res.count, requiresConfirm: false as const, targets };
}

function parseQueryCommand(text: string) {
  const t = normalizeOperationText(text);
  if (!t) return null;
  if (!/(显示|查看|看看|列出|展示|查下|查询)/.test(t)) return null;
  if (!/回收站|移入回收站|删除记录|已删除/.test(t)) return null;

  const m = t.match(/(\d+)\s*条/);
  const take = Math.max(1, Math.min(100, m ? Number(m[1]) : 10));
  return { mode: "recycle_recent" as const, take };
}

function parseStatsCommand(text: string) {
  const t = normalizeOperationText(text);
  if (!t) return null;
  if (!/(统计|算一下|统计一下|汇总)/.test(t)) return null;
  const metric = /(多少钱|金额|总额|合计)/.test(t) ? "sum" : "count";
  const type = /收入/.test(t) ? TransactionType.income : /转账/.test(t) ? TransactionType.transfer : TransactionType.expense;

  let year: number | undefined = undefined;
  const yearMatch = t.match(/(\d{4})年/);
  if (yearMatch) year = Number(yearMatch[1]);

  let month: number | undefined = undefined;
  const monthMatch = t.match(/(\d{1,2})月/);
  if (monthMatch) month = Number(monthMatch[1]);

  let accountKeyword: string | undefined = undefined;
  const bankKey = extractBankKeywordFromBill(t);
  if (bankKey) accountKeyword = bankKey;

  return { metric: metric as "count" | "sum", type, year, month, accountKeyword };
}

async function executeStatsPlan(plan: { metric: "count" | "sum"; type: TransactionType; year?: number; month?: number; accountKeyword?: string }) {
  const where: any = {
    transaction: {
      deletedAt: null,
      type: plan.type,
    },
  };

  if (plan.year) {
    const start = new Date(plan.year, (plan.month ?? 1) - 1, 1);
    const end = plan.month
      ? new Date(plan.year, plan.month, 1)
      : new Date(plan.year + 1, 0, 1);
    where.transaction.date = { gte: start, lt: end };
  }

  if (plan.accountKeyword) {
    where.OR = [
      { account: { name: { contains: plan.accountKeyword } } },
      { account: { Institution: { name: { contains: plan.accountKeyword } } } },
    ];
  }

  const rows = await prisma.txRecord.findMany({
    where,
    select: { amount: true },
    take: 50000,
  });
  const count = rows.length;
  const sum = rows.reduce((acc, r) => acc + Math.abs(Number(r.amount ?? 0)), 0);
  return { count, sum };
}

async function executeQueryPlan(plan: { mode: "recycle_recent"; take: number }) {
  const rows = await prisma.txRecord.findMany({
    where: { deletedAt: { not: null } },
    orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
    take: plan.take,
  });

  const records = rows.map((tx) => {
    return {
      id: tx.id,
      date: tx.date.toISOString().slice(0, 10),
      deletedAt: tx.deletedAt?.toISOString() ?? null,
      type: tx.type,
      amount: Number(tx.amount),
      accountName: tx.accountName,
      remark: tx.note ?? "",
    };
  });

  return { ok: true as const, records };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = z
    .object({
      text: z.string().optional(),
      imageDataUrl: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      modelName: z.string().optional(),
      accountName: z.string().optional(),
      fundContext: z.object({
        fundCode: z.string(),
        fundName: z.string().optional(),
        accountId: z.string(),
        cashAccountId: z.string().optional(),
      }).optional(),
    })
    .safeParse(body);

  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "参数格式不正确" }, { status: 400, headers: corsHeaders() });
  }

  const { text, imageDataUrl, fundContext } = parse.data;
  const baseUrl = (parse.data.baseUrl ?? "").trim();
  const apiKey = (parse.data.apiKey ?? "").trim();
  const modelName = (parse.data.modelName ?? "").trim();
  const accountName = (parse.data.accountName ?? "").trim();

  if (!text && !imageDataUrl) {
    return NextResponse.json({ ok: false, error: "缺少 text 或 imageDataUrl" }, { status: 400, headers: corsHeaders() });
  }

  if (!baseUrl || !modelName) {
    return NextResponse.json({ ok: false, error: "缺少模型配置（baseUrl/modelName）" }, { status: 400, headers: corsHeaders() });
  }

  if (text) {
    const startMs = Date.now();

    const restorePlan = parseRestoreCommand(text);
    if (restorePlan) {
      try {
        const r = await executeRestorePlan(restorePlan, false);
        return NextResponse.json({
          ok: true,
          operation: "restore",
          stage: "confirm",
          restoredCount: r.restoredCount,
          targets: r.targets ?? [],
          trace: [`识别为恢复指令：恢复最近 ${restorePlan.take} 条`, `命中 ${r.restoredCount} 条记录`],
        }, { headers: corsHeaders() });
      } catch { /* continue */ }
    }

    const updatePlan = parseUpdateCommand(text);
    if (updatePlan) {
      try {
        const result = await executeUpdatePlan(updatePlan, false, accountName);
        if (!result.ok) return NextResponse.json({ ok: false, error: (result as { error: string }).error }, { status: 422, headers: corsHeaders() });
        return NextResponse.json({
          ok: true,
          operation: "update",
          stage: "confirm",
          count: (result as { count: number }).count,
          accountName: (result as { accountName: string }).accountName,
          remarkKeyword: updatePlan.remarkKeyword,
          newType: updatePlan.newType,
          targets: (result as { targets: Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string; type?: string }> }).targets,
          trace: [
            `识别为更新指令：${updatePlan.remarkKeyword ? `备注包含"${updatePlan.remarkKeyword}"的` : "当前账户"}记录${updatePlan.newAccountName ? `改为"${updatePlan.newAccountName}"` : ""}${updatePlan.newType ? `，类型改为"${updatePlan.newType}"` : ""}`,
            `命中 ${(result as { count: number }).count} 条记录，需要确认后执行。`,
          ],
        }, { headers: corsHeaders() });
      } catch {
        // 数据库不可用，跳到下一步
      }
    }

    const batchEditPlan = parseBatchEditCommand(text);
    if (batchEditPlan) {
      try {
        const planToExecute = {
          ...batchEditPlan,
          accountKeyword: batchEditPlan.accountKeyword || accountName || undefined,
        };
        const result = await executeBatchEditPlan(planToExecute);
        return NextResponse.json(
          {
            ok: true,
            operation: "batchEdit",
            stage: "confirm",
            count: result.count,
            targets: result.targets,
            trace: [
              `识别为批量编辑指令：${batchEditPlan.day ? `${batchEditPlan.day}号` : batchEditPlan.month ? `${batchEditPlan.month}月` : "全部"}${batchEditPlan.accountKeyword ? ` ${batchEditPlan.accountKeyword}` : ""}交易`,
              `命中 ${result.count} 条记录`,
            ],
          },
          { headers: corsHeaders() },
        );
      } catch {
        // 数据库不可用，跳到下一步
      }
    }

    const plan = parseDeleteCommand(text);
    if (plan) {
      try {
        const applyNow = /确认|继续|执行|立即/.test(text);
        const result = await executeDeletePlan(plan, false);
        if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422, headers: corsHeaders() });
        const scopeText = plan.hasMonth
          ? `${plan.year}-${String(plan.month).padStart(2, "0")}-${String(plan.startDay).padStart(2, "0")} 到 ${String(plan.endDay).padStart(2, "0")}`
          : `全部时间`;
        return NextResponse.json({
          ok: true,
          operation: "delete",
          stage: "confirm",
          deletedCount: result.deletedCount,
          accountName: result.accountName,
          yearMonth: plan.hasMonth ? `${plan.year}-${String(plan.month).padStart(2, "0")}` : undefined,
          targets: result.targets,
          trace: [
            `识别为删除指令：${scopeText} ${plan.accountQuery} ${plan.type}`,
            `命中 ${result.deletedCount} 条记录`,
          ],
        }, { headers: corsHeaders() });
      } catch {
        // 数据库不可用，跳到下一步
      }
    }

    const statsPlan = parseStatsCommand(text);
    if (statsPlan) {
      try {
        const s = await executeStatsPlan(statsPlan);
        return NextResponse.json(
          {
            ok: true,
            operation: "stats",
            metric: statsPlan.metric,
            type: statsPlan.type,
            count: s.count,
            sum: s.sum,
            trace: [
              `识别为统计指令：${statsPlan.metric === "sum" ? "金额汇总" : "数量统计"}`,
              `统计结果：count=${s.count}, sum=${s.sum.toFixed(2)}`,
            ],
          },
          { headers: corsHeaders() },
        );
      } catch {
        // 数据库不可用，跳到下一步
      }
    }

    const queryPlan = parseQueryCommand(text);
    if (queryPlan) {
      try {
        const q = await executeQueryPlan(queryPlan);
        return NextResponse.json(
          {
            ok: true,
            operation: "query",
            queryType: "recycle_recent",
            records: q.records,
            trace: [`识别为查询指令：最近回收站记录`, `返回 ${q.records.length} 条记录`],
          },
          { headers: corsHeaders() },
        );
      } catch {
        // 数据库不可用，跳到下一步
      }
    }
  }

  if (imageDataUrl && !modelSupportsVision(modelName)) {
    return NextResponse.json(
      { ok: false, error: `当前模型 "${modelName}" 不支持图片识别，请切换到支持图片的模型（如 GPT-4o、Claude-3.5、Qwen-VL 等），或将截图另存为文本后粘贴上传。` },
      { status: 422, headers: corsHeaders() },
    );
  }

  const cleanUrl = baseUrl.replace(/\/$/, "");
  const isOllama = /:11434(\/|$)/.test(cleanUrl);

  if (text && !imageDataUrl) {
    const billPre = preprocessBillText(text);
    if (billPre.txLines.length > 0 && billPre.header.statementDate) {
      const issuer = extractBankKeywordFromBill(text);
      const billItems = parseBillTxLines(billPre.txLines, billPre.header, issuer);
      if (billItems.length) {
        const result = {
          ok: true,
          items: billItems,
          directImport: false,
          billHeader: billPre.header.statementDate ? {
            statementDate: billPre.header.statementDate,
            paymentDueDate: billPre.header.paymentDueDate,
            newBalance: billPre.header.newBalance,
            minPayment: billPre.header.minPayment,
            currency: billPre.header.currency,
            issuer,
          } : undefined,
          trace: [
            `信用卡账单规则直出 ${billItems.length} 条记录（无需模型）`,
            `账单类文本：需人工确认后再导入`,
            `账单头部预识别：${buildBillHeaderContext(billPre.header)}`,
            `预抽取交易行：${billPre.txLines.length} 条`,
          ],
        };
        void logDistill({
          source: "chat",
          rawInput: text,
          preprocessed: billPre.cleaned,
          parsedItems: billItems,
          operationType: "bill_direct",
          finalResult: result,
          trace: result.trace,
          success: true,
        });
        return NextResponse.json(result, { headers: corsHeaders() });
      }
    }
  }

  const startMs = Date.now();

  async function classifyInput(userText: string, model: string, base: string, key: string, ollamaMode: boolean) {
    if (!userText || imageDataUrl) return null;
    try {
      if (ollamaMode) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (key) headers.Authorization = `Bearer ${key}`;
        const body = { model, stream: false, messages: [{ role: "user", content: `${CLASSIFY_PROMPT}\n\n输入内容：${userText.slice(0, 500)}` }] };
        const r = await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        const content = (d as any)?.message?.content ?? "";
        return extractInputType(content);
      } else {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (key) headers.Authorization = `Bearer ${key}`;
        const body = { model, messages: [{ role: "user", content: `${CLASSIFY_PROMPT}\n\n输入内容：${userText.slice(0, 500)}` }] };
        const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        const content = (d as any)?.choices?.[0]?.message?.content ?? "";
        return extractInputType(content);
      }
    } catch {
      return null;
    }
  }

  function extractInputType(raw: string): { inputType: string; confidence: number; reason: string } | null {
    for (const pat of [/```json\s*([\s\S]*?)\s*```/i, /```\s*([\s\S]*?)\s*```/, /(\{[\s\S]*\})/]) {
      const m = raw.match(pat);
      if (m) {
        try {
          const obj = JSON.parse(m[1] ?? m[0]);
          if (obj?.inputType) return obj;
        } catch { continue; }
      }
    }
    try {
      const obj = JSON.parse(raw);
      if (obj?.inputType) return obj;
    } catch { return null; }
    return null;
  }

  async function routeByType(inputType: string, text: string, now: Date) {
    const pre = preprocessBillText(text);
    if (inputType === "bill_statement") {
      if (pre.txLines.length > 0 && pre.header.statementDate) {
        const issuer = extractBankKeywordFromBill(text);
        const billItems = parseBillTxLines(pre.txLines, pre.header, issuer);
        if (billItems.length) {
          return {
            ok: true,
            items: billItems,
            directImport: false,
            billHeader: pre.header.statementDate ? {
              statementDate: pre.header.statementDate,
              paymentDueDate: pre.header.paymentDueDate,
              newBalance: pre.header.newBalance,
              minPayment: pre.header.minPayment,
              currency: pre.header.currency,
              issuer,
            } : undefined,
            trace: [
              `[分类路由] bill_statement：信用卡账单规则直出 ${billItems.length} 条`,
              `账单头部：${buildBillHeaderContext(pre.header)}`,
            ],
          };
        }
      }
      return null;
    }

    if (inputType === "batch_table") {
      const parsedOut = isCMBFundRecord(text)
        ? parseCMBFundRecord(text, now)
        : parseItems(text, now, text);
      const items = parsedOut.items;
      if (items.length) {
        return {
          ok: true,
          items,
          directImport: false,
          trace: [
            `[分类路由] ${isCMBFundRecord(text) ? "招行基金交易记录" : "batch_table"}：直出 ${items.length} 条`,
            `directImport=${parsedOut.directImport}`,
          ],
        };
      }
      return null;
    }

    return null;
  }

  try {
    if (text && !imageDataUrl && isCMBFundRecord(text)) {
      const now = new Date();
      const parsedOut = parseCMBFundRecord(text, now);
      if (parsedOut.items.length) {
        return NextResponse.json(
          {
            ok: true,
            items: parsedOut.items,
            directImport: true,
            trace: [
              `招行基金交易记录解析 ${parsedOut.items.length} 条（无需模型）`,
              `耗时 ${Date.now() - startMs}ms`,
            ],
          },
          { headers: corsHeaders() },
        );
      }
    }

    if (text && !imageDataUrl && looksLikeFundTrade(text)) {
      const now = new Date();
      // When fund context is available, use it to fill fund-specific fields
      if (fundContext) {
        const isRedeem = /赎回|卖出/.test(text);
        const isDividendReinvest = /红利转投|红利再投/.test(text);
        const isDividendCash = /现金红利/.test(text);
        const subtype = isRedeem ? "redeem" : isDividendReinvest ? "dividend_reinvest" : isDividendCash ? "dividend_cash" : "buy";

        const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块|万)/);
        const sharesMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:份)/);
        const amount = amountMatch ? parseFloat(amountMatch[1]) : sharesMatch ? parseFloat(sharesMatch[1]) : 0;

        const date = normalizeDate(undefined, text, now);
        const typeLabel = subtype === "redeem" ? "赎回" : subtype === "dividend_cash" ? "现金红利" : subtype === "dividend_reinvest" ? "红利转投" : "申购";

        return NextResponse.json({
          ok: true,
          items: [{
            rawText: text.slice(0, 200),
            type: "investment",
            date,
            amount: amount || 0,
            remark: `${typeLabel} ${fundContext.fundCode}`,
            category: `基金·${fundContext.fundCode}`,
            counterparty: `基金${fundContext.fundCode}`,
          }],
          directImport: amount > 0,
          trace: [
            `基金上下文直出：${fundContext.fundCode} ${typeLabel}${amount > 0 ? ` ${amount}元` : ""}（无需模型）`,
            `耗时 ${Date.now() - startMs}ms`,
          ],
        }, { headers: corsHeaders() });
      }
      // Without fund context: extract fund code from text for basic fund trades
      const fundCodeFromText = text.match(/\b(\d{6})\b/)?.[1];
      if (fundCodeFromText && (/\b(买入|卖出|赎回|申购)\b/.test(text))) {
        const isRedeem = /赎回|卖出/.test(text);
        const amtMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块|万)/);
        const amount = amtMatch ? parseFloat(amtMatch[1]) : 0;
        const date = normalizeDate(undefined, text, now);
        return NextResponse.json({
          ok: true,
          items: [{
            rawText: text.slice(0, 200),
            type: "investment",
            date,
            amount: amount || 0,
            remark: `${isRedeem ? "赎回" : "申购"} ${fundCodeFromText}`,
            category: `基金·${fundCodeFromText}`,
            counterparty: `基金${fundCodeFromText}`,
          }],
          directImport: amount > 0,
          trace: [
            `基金代码直出: ${fundCodeFromText} (无需模型)`,
            `耗时 ${Date.now() - startMs}ms`,
          ],
        }, { headers: corsHeaders() });
      }
    }

    if (text && !imageDataUrl) {
      const classification = await classifyInput(text, modelName, cleanUrl, apiKey, isOllama);
      if (classification) {
        const routeResult = await routeByType(classification.inputType, text, new Date());
        if (routeResult) {
          return NextResponse.json(routeResult, { headers: corsHeaders() });
        }
      }
    }

    if (text && !imageDataUrl && looksLikeBatchLedgerText(text) && text.length > 300) {
      const now = new Date();
      const parsedOut = parseItems(text, now, text);
      const items = parsedOut.items;
      if (items.length) {
        const isBill = isBillStatement(text);
        const directImport = !isBill && items.every(isReadyForImport);
        return NextResponse.json(
          {
            ok: true,
            items,
            directImport,
            trace: [
              `批量文本解析 ${items.length} 条记录（无需模型）`,
              isBill ? "账单类文本：需人工确认后再导入" : `directImport=${directImport ? "true" : "false"}`,
              `耗时 ${Date.now() - startMs}ms`,
            ],
          },
          { headers: corsHeaders() },
        );
      }
    }

    const nowForPrompt = new Date();
    const accountContext = await buildAccountContextText();
    const pre = preprocessBillText(text ?? "");
    const billHeaderCtx = buildBillHeaderContext(pre.header);
    const txCtx = pre.txLines.length ? `预抽取交易行：${pre.txLines.join(" || ")}` : "";
    const systemPrompt = fundContext ? buildFundSystemPrompt(fundContext) : SYSTEM_PROMPT;
    let llmBody: Record<string, unknown>;
    if (imageDataUrl) {
      llmBody = {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n${billHeaderCtx ? `账单头部预识别：${billHeaderCtx}\n` : ""}${txCtx ? `${txCtx}\n` : ""}请解析这张账单/交易表格截图。只输出JSON，不要其他文字。` },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0.1,
      };
    } else {
      llmBody = {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n只输出JSON，不要任何解释：\n${text ?? ""}`,
          },
        ],
        temperature: 0.1,
      };
    }

    let rawContent = "";
    if (isOllama) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = (apiKey ?? "").trim();
      if (key) headers.Authorization = `Bearer ${key}`;

      const msgText =
        imageDataUrl
          ? `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n${billHeaderCtx ? `账单头部预识别：${billHeaderCtx}\n` : ""}${txCtx ? `${txCtx}\n` : ""}请解析这张账单/交易表格截图。只输出JSON，不要其他文字。`
          : `当前日期：${formatYmd(nowForPrompt)}。\n${accountContext}\n${billHeaderCtx ? `账单头部预识别：${billHeaderCtx}\n` : ""}${txCtx ? `${txCtx}\n` : ""}只输出JSON，不要任何解释：\n${pre.cleaned || text || ""}`;

      const base64 = imageDataUrl ? (imageDataUrl.split(",")[1] ?? "").trim() : "";
      const ollamaBody: Record<string, unknown> = {
        model: modelName,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          imageDataUrl ? { role: "user", content: msgText, images: base64 ? [base64] : [] } : { role: "user", content: msgText },
        ],
      };

      const llmRes = await fetch(joinBaseUrl(cleanUrl, "/api/chat"), {
        method: "POST",
        headers,
        body: JSON.stringify(ollamaBody),
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text().catch(() => "");
        return NextResponse.json(
          { ok: false, error: `LLM 调用失败 (${llmRes.status}): ${errText.slice(0, 300)}` },
          { status: 502, headers: corsHeaders() },
        );
      }

      const llmData = (await llmRes.json().catch(() => null)) as
        | { message?: { content?: string | null } }
        | { response?: string | null }
        | null;

      rawContent = (llmData as any)?.message?.content ?? (llmData as any)?.response ?? "";
    } else {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = (apiKey ?? "").trim();
      if (key) headers.Authorization = `Bearer ${key}`;

      const llmRes = await fetch(joinBaseUrl(cleanUrl, "/v1/chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify(llmBody),
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text().catch(() => "");
        return NextResponse.json(
          { ok: false, error: `LLM 调用失败 (${llmRes.status}): ${errText.slice(0, 300)}` },
          { status: 502, headers: corsHeaders() },
        );
      }

      const llmData = (await llmRes.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        error?: { message?: string };
      } | null;

      if (llmData?.error) {
        return NextResponse.json(
          { ok: false, error: `LLM 错误: ${llmData.error.message ?? "未知错误"}` },
          { status: 400, headers: corsHeaders() },
        );
      }

      rawContent = llmData?.choices?.[0]?.message?.content ?? "";
    }

    if (!rawContent) {
      void logDistill({
        source: "chat",
        rawInput: text ?? imageDataUrl ?? "",
        preprocessed: text ? pre.cleaned : undefined,
        promptSent: undefined,
        operationType: "chat",
        modelName,
        latencyMs: Date.now() - startMs,
        success: false,
        errorMsg: "LLM 未返回内容",
      });
      return NextResponse.json({ ok: false, error: "LLM 未返回内容，请重试或更换模型" }, { status: 422, headers: corsHeaders() });
    }

    const now = new Date();

    // ── Check if fund LLM returned a batch plan ──
    if (fundContext) {
      try {
        let batchJson: any = null;
        // Try to extract JSON from the response
        for (const pat of [/```json\s*([\s\S]*?)\s*```/i, /```\s*([\s\S]*?)\s*```/, /\{[\s\S]*"operation"[\s\S]*\}/, /(\{[\s\S]*\})/]) {
          const m = rawContent.match(pat);
          if (m) {
            try { batchJson = JSON.parse(m[1] ?? m[0]); break; } catch { continue; }
          }
        }
        if (!batchJson) try { batchJson = JSON.parse(rawContent); } catch { /* not JSON */ }
        if (batchJson?.operation === "batch" && batchJson?.plan) {
          const plan = batchJson.plan;
          if (plan.amount > 0 && plan.intervalUnit && plan.startDate) {
            return NextResponse.json({
              ok: true,
              operation: "batchInvest",
              plan: {
                amount: Number(plan.amount),
                intervalUnit: String(plan.intervalUnit),
                intervalValue: Number(plan.intervalValue || 1),
                startDate: String(plan.startDate),
                endDate: plan.endDate || null,
              },
              trace: [
                `AI 解析为批量买入: ${plan.intervalUnit === "day" ? "每天" : plan.intervalUnit === "week" ? "每周" : plan.intervalUnit === "biweek" ? "每两周" : "每月"}${plan.amount}元`,
                plan.endDate ? `${plan.startDate} ~ ${plan.endDate}` : `${plan.startDate} 起，无截止`,
                `耗时 ${Date.now() - startMs}ms`,
              ],
            }, { headers: corsHeaders() });
          }
        }
      } catch { /* fall through to normal parseItems */ }
    }

    const parsedOut = parseItems(rawContent, now, text ?? "");
    const items = parsedOut.items;
    const isBill = isBillStatement(text ?? "");
    const directImport = items.every(isReadyForImport);
    const finalDirectImport = !isBill && directImport;

    const duplicates: Array<{ existingEntryId: string; existingTransactionId: string; overlapStart: Date; overlapEnd: Date }> = [];

    const traceLines = [
      `通过 ${modelName} 解析 ${items.length} 条记录`,
      `directImport=${finalDirectImport ? "true" : "false"}`,
      isBill ? "账单类文本：需人工确认后再导入" : "",
      billHeaderCtx ? `账单头部预识别：${billHeaderCtx}` : "",
      txCtx ? `预抽取交易行：${pre.txLines.length} 条` : "",
      `耗时 ${Date.now() - startMs}ms`,
    ].filter(Boolean);

    const result = {
      ok: true,
      items,
      directImport: finalDirectImport,
      duplicates: duplicates.length > 0 ? duplicates : undefined,
      billHeader: isBill && pre.header.statementDate ? {
        statementDate: pre.header.statementDate,
        paymentDueDate: pre.header.paymentDueDate,
        newBalance: pre.header.newBalance,
        minPayment: pre.header.minPayment,
        currency: pre.header.currency,
        issuer: extractBankKeywordFromBill(text ?? ""),
      } : undefined,
      trace: traceLines,
    };

    void logDistill({
      source: "chat",
      rawInput: text ?? imageDataUrl ?? "",
      preprocessed: text ? pre.cleaned : undefined,
      promptSent: undefined,
      llmResponse: rawContent,
      parsedItems: items,
      operationType: "chat",
      finalResult: result,
      trace: traceLines,
      modelName,
      latencyMs: Date.now() - startMs,
      success: true,
    });

    return NextResponse.json(result, { headers: corsHeaders() });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "LLM 调用失败";
    void logDistill({
      source: "chat",
      rawInput: text ?? imageDataUrl ?? "",
      operationType: "chat",
      modelName,
      latencyMs: Date.now() - startMs,
      success: false,
      errorMsg: errMsg,
    });
    return NextResponse.json(
      { ok: false, error: errMsg },
      { status: 500, headers: corsHeaders() },
    );
  }
}

