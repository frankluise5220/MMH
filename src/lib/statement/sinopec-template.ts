/**
 * 中国石化加油卡电子钱包账单 → MMH 标准导入行。
 *
 * 支持两种原始形态（2026-11-22）：
 *   A. 官网邮件账单（.eml 的 HTML 表格转 xlsx）：
 *      - 「交易信息」11 列：卡号|持卡人|交易时间|交易类型|油品|数量(升)|单价(元)|金额(元)|奖励分值|余额(元)|地点
 *      - 「付费信息」5 列：序号|付费时间|付费地点|收款方式|充值金额(元)
 *      用户口径（2026-11-22）：原表格里的升数、地点、单价等字段都要保留到备注里。
 *      因此每张消费/充值行把所有原始列拼成「字段:值; ...」写进备注，不丢信息。
 *   B. 财智式导出（表头「日期|流入|流出|活动类型|标签|余额|备注」）：
 *      与财智8 明细同形，原先一律被财智识别器抢先命中、账户靠文件名猜；
 *      本识别器靠活动类型内容特征（YZ汽油/中石化/加油/充值）认领，账户固定钱包名。
 *
 * 命中后账户固定为账本里的电子钱包账户「中石化加油卡」，不依赖文件名。
 */

import { readStatementSheetRows } from "@/lib/statement/statement-sheet-reader";

export type SinopecWorkbookSheetRows = {
  sheetName: string;
  rows: string[][];
};

/** 账本里中石化加油卡电子钱包的账户名（kind=ewallet），导入行固定落这里。 */
export const SINOPEC_WALLET_ACCOUNT_NAME = "\u4e2d\u77f3\u5316\u52a0\u6cb9\u5361";

const SINOPEC_ACTIVITY_KEYWORDS = [
  "YZ\u6c7d\u6cb9",
  "YZ\u67f4\u6cb9",
  "\u52a0\u6cb9",
  "\u4e2d\u77f3\u5316",
  "\u4e2d\u56fd\u77f3\u5316",
  "sinopec",
];
const BALANCE_ADJUST_KEYWORDS = ["\u4f59\u989d\u8c03\u6574", "\u4f59\u989d\u521d\u59cb\u5316", "\u671f\u521d\u4f59\u989d", "\u7ed3\u606f"];

// 标准 11 列（与财智/京东/支付宝/微信一致，含「入账日期」在第 2 位）。
const NORMALIZED_HEADERS = [
  "\u65e5\u671f",
  "\u5165\u8d26\u65e5\u671f",
  "\u6536\u652f\u5927\u7c7b",
  "\u6d41\u51fa",
  "\u6d41\u5165",
  "\u8d26\u6237",
  "\u5bf9\u5411\u8d26\u6237",
  "\u5206\u7c7b",
  "\u6536\u652f\u673a\u6784",
  "\u6807\u7b7e",
  "\u5907\u6ce8",
];

// —— 财智同形（形态 B）列别名 ——
const LEDGER_HEADER_ALIASES: Record<string, LedgerColumnKey | "skip"> = {
  "\u65e5\u671f": "date",
  "\u4ea4\u6613\u65e5\u671f": "date",
  "\u6d41\u5165": "inflow",
  "\u6d41\u5165\u91d1\u989d": "inflow",
  "\u6d41\u51fa": "outflow",
  "\u652f\u51fa": "outflow",
  "\u6d41\u51fa\u91d1\u989d": "outflow",
  "\u6d3b\u52a8\u7c7b\u578b": "activityType",
  "\u7c7b\u578b": "activityType",
  "\u4ea4\u6613\u7c7b\u578b": "activityType",
  "\u5907\u6ce8": "remark",
  "\u6807\u7b7e": "skip",
  "\u4f59\u989d": "balance",
  "\u7ed3\u4f59": "balance",
  "\u5165\u8d26\u65e5\u671f": "skip",
  "\u6536\u652f\u5927\u7c7b": "skip",
};

type LedgerColumnIndex = {
  date: number;
  inflow: number;
  outflow: number;
  activityType: number;
  remark: number;
  balance: number;
};
type LedgerColumnKey = keyof LedgerColumnIndex;

// —— eml 交易信息（形态 A）列别名 ——
type TradeColumnIndex = {
  cardNo: number;
  holder: number;
  date: number;
  tradeType: number;
  product: number;
  liters: number;
  unitPrice: number;
  amount: number;
  points: number;
  balance: number;
  location: number;
};
type TradeColumnKey = keyof TradeColumnIndex;

const TRADE_HEADER_ALIASES: Record<string, TradeColumnKey> = {
  "\u5361\u53f7": "cardNo",
  "\u6301\u5361\u4eba": "holder",
  "\u4ea4\u6613\u65f6\u95f4": "date",
  "\u4ea4\u6613\u7c7b\u578b": "tradeType",
  "\u6cb9\u54c1": "product",
  "\u6570\u91cf(\u5347)": "liters",
  "\u6570\u91cf\u5347": "liters",
  "\u5355\u4ef7(\u5143)": "unitPrice",
  "\u5355\u4ef7\u5143": "unitPrice",
  "\u91d1\u989d(\u5143)": "amount",
  "\u91d1\u989d\u5143": "amount",
  "\u5956\u52b1\u5206\u503c": "points",
  "\u4f59\u989d(\u5143)": "balance",
  "\u4f59\u989d\u5143": "balance",
  "\u5730\u70b9": "location",
};

// —— eml 付费信息（形态 A）列别名 ——
type PaymentColumnIndex = {
  seq: number;
  date: number;
  location: number;
  method: number;
  amount: number;
};
type PaymentColumnKey = keyof PaymentColumnIndex;

const PAYMENT_HEADER_ALIASES: Record<string, PaymentColumnKey> = {
  "\u5e8f\u53f7": "seq",
  "\u4ed8\u8d39\u65f6\u95f4": "date",
  "\u4ed8\u8d39\u5730\u70b9": "location",
  "\u6536\u6b3e\u65b9\u5f0f": "method",
  "\u5145\u503c\u91d1\u989d(\u5143)": "amount",
  "\u5145\u503c\u91d1\u989d\u5143": "amount",
};

export type SinopecBalanceAdjustRow = {
  date: string;
  targetBalance: number | null;
  activityType: string;
  remark: string;
};

type NormalizedSinopecWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  balanceAdjustRows: SinopecBalanceAdjustRow[];
};

function normalizeHeader(value: string): string {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  return String(value).trim();
}

function parseAmount(value: unknown): number | null {
  const raw = cleanText(value).replace(/,/g, "").replace(/\u00a5/g, "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function normalizeDate(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  const dateTime = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (dateTime) return `${dateTime[1]}-${dateTime[2].padStart(2, "0")}-${dateTime[3].padStart(2, "0")}`;
  const cn = raw.match(/^(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})/);
  if (cn) return `${cn[1]}-${cn[2].padStart(2, "0")}-${cn[3].padStart(2, "0")}`;
  return raw.slice(0, 10);
}

/** 把「字段:值」拼进备注，空值跳过；原始列的顺序即备注里的顺序。 */
function buildRemark(parts: Array<[string, unknown]>): string {
  return parts
    .map(([label, value]) => [label, cleanText(value)] as const)
    .filter(([, value]) => value !== "" && value !== "null" && value !== "0.0" && value !== "0")
    .map(([label, value]) => `${label}:${value}`)
    .join("; ");
}

function buildTypedIndex<T extends string>(
  headerRow: string[],
  aliases: Record<string, T>,
  required: readonly T[],
): Record<T, number> | null {
  // aliases 的 key 是中文表头文本、value 是语义列（date/amount/...）；索引必须按语义列建。
  const index = {} as Record<T, number>;
  for (const semanticKey of new Set(Object.values(aliases))) index[semanticKey] = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const semanticKey = aliases[normalizeHeader(headerRow[i])];
    if (semanticKey) index[semanticKey] = i;
  }
  if (required.some((key) => (index[key] ?? -1) < 0)) return null;
  return index;
}

function buildLedgerHeaderIndex(headerRow: string[]): LedgerColumnIndex | null {
  if (headerRow.some((h) => normalizeHeader(h) === "\u5bf9\u5411\u8d26\u6237")) return null;
  // LEDGER_HEADER_ALIASES 的 value 含 "skip"（跳过列），先剔除再交给通用索引构造。
  const aliases: Record<string, LedgerColumnKey> = {};
  for (const [header, key] of Object.entries(LEDGER_HEADER_ALIASES)) {
    if (key !== "skip") aliases[header] = key;
  }
  return buildTypedIndex<LedgerColumnKey>(headerRow, aliases, ["date", "activityType"] as const) as LedgerColumnIndex | null;
}

function isBalanceAdjust(activityType: string): boolean {
  const act = activityType.trim();
  return BALANCE_ADJUST_KEYWORDS.some((kw) => act.includes(kw));
}

function isSinopecActivity(activityType: string): boolean {
  const act = activityType.toLowerCase();
  return SINOPEC_ACTIVITY_KEYWORDS.some((kw) => act.includes(kw.toLowerCase()));
}

/**
 * 中石化内容判据：交易信息表头（油品/数量(升)/单价(元)）或财智同形表头 + 中石化活动类型。
 * 表头与财智同形时必须靠内容区分，否则会吞掉普通财智流水。
 */
export function looksLikeSinopecRows(sheets: readonly { rows: string[][] }[]): boolean {
  for (const sheet of sheets) {
    const header = sheet.rows[0] ?? [];
    if (buildTypedIndex<TradeColumnKey>(header, TRADE_HEADER_ALIASES, ["date", "amount", "product"] as const)) return true;
    if (buildTypedIndex<PaymentColumnKey>(header, PAYMENT_HEADER_ALIASES, ["date", "amount", "location"] as const)) return true;
    const ledgerIdx = buildLedgerHeaderIndex(header);
    if (!ledgerIdx) continue;
    for (let r = 1; r < Math.min(sheet.rows.length, 120); r++) {
      const activity = cleanText(sheet.rows[r]?.[ledgerIdx.activityType]);
      if (activity && isSinopecActivity(activity)) return true;
    }
  }
  return false;
}

/**
 * eml「交易信息」表 → 标准行（把交易特有字段写进备注）。
 *
 * 口径（2026-11-22 用户）：账户统一属性的信息不进备注——卡号、持卡人、交易类型
 * 对同一张卡每一行都一样，属于账户属性，不重复写进每条流水；只有油品、升数、
 * 单价、地点、奖励分值、余额这类「这笔交易才有」的字段才保留。
 */
function normalizeTradeRows(
  rows: string[][],
  idx: TradeColumnIndex,
  accountName: string,
  resultRows: string[][],
): number {
  let count = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some((cell) => cleanText(cell))) continue;
    const date = normalizeDate(row[idx.date]);
    const amount = parseAmount(row[idx.amount]);
    if (!date || amount === null) continue;
    count++;
    const remark = buildRemark([
      ["\u6cb9\u54c1", row[idx.product]],
      ["\u6570\u91cf(\u5347)", row[idx.liters]],
      ["\u5355\u4ef7(\u5143)", row[idx.unitPrice]],
      ["\u5730\u70b9", row[idx.location]],
      ["\u5956\u52b1\u5206\u503c", row[idx.points]],
      ["\u4f59\u989d(\u5143)", row[idx.balance]],
      // 卡号 / 持卡人 / 交易类型是账户统一属性，不进备注。
    ]);
    resultRows.push([date, "", "\u652f\u51fa", String(Math.abs(amount)), "", accountName, "", "\u52a0\u6cb9", "\u4e2d\u56fd\u77f3\u5316", "", remark]);
  }
  return count;
}

/** eml「付费信息」表 → 标准行（充值，含全部原始字段的备注）。 */
function normalizePaymentRows(
  rows: string[][],
  idx: PaymentColumnIndex,
  accountName: string,
  resultRows: string[][],
): number {
  let count = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some((cell) => cleanText(cell))) continue;
    const date = normalizeDate(row[idx.date]);
    const amount = parseAmount(row[idx.amount]);
    if (!date || amount === null) continue;
    count++;
    const remark = buildRemark([
      ["\u5730\u70b9", row[idx.location]],
      ["\u6536\u6b3e\u65b9\u5f0f", row[idx.method]],
      ["\u5e8f\u53f7", row[idx.seq]],
    ]);
    resultRows.push([date, "", "\u6536\u5165", "", String(Math.abs(amount)), accountName, "", "\u5145\u503c", "", "", remark]);
  }
  return count;
}

/** 财智同形（形态 B）单行归一化。 */
function normalizeLedgerRow(row: string[], idx: LedgerColumnIndex, accountName: string): string[] | null {
  const date = normalizeDate(row[idx.date]);
  if (!date) return null;
  const activityType = cleanText(row[idx.activityType]);
  if (!activityType) return null;
  const remark = cleanText(row[idx.remark]);
  const inflowRaw = idx.inflow >= 0 ? parseAmount(row[idx.inflow]) : null;
  const outflowRaw = idx.outflow >= 0 ? parseAmount(row[idx.outflow]) : null;
  const hasInflow = inflowRaw !== null && inflowRaw > 0;
  const hasOutflow = outflowRaw !== null && outflowRaw > 0;
  if (!hasInflow && !hasOutflow) return null;

  if (activityType.includes("|")) {
    const [prefixRaw, counterRaw] = activityType.split("|");
    const counterAccount = cleanText(counterRaw);
    const prefix = cleanText(prefixRaw);
    return [date, "", "\u8f6c\u8d26", hasOutflow ? String(outflowRaw) : "", hasInflow ? String(inflowRaw) : "",
      accountName, counterAccount, prefix === "\u8f6c\u5165" ? "\u5145\u503c" : "", "", "", remark];
  }
  if (hasInflow) {
    return [date, "", "\u6536\u5165", "", String(inflowRaw), accountName, "", activityType, "", "", remark];
  }
  const isFuel = isSinopecActivity(activityType);
  return [date, "", "\u652f\u51fa", String(outflowRaw), "", accountName, "", isFuel ? "\u52a0\u6cb9" : activityType,
    isFuel ? "\u4e2d\u56fd\u77f3\u5316" : "", "", remark];
}

export function normalizeSinopecWorkbookRows(
  sheets: readonly SinopecWorkbookSheetRows[],
  accountName: string = SINOPEC_WALLET_ACCOUNT_NAME,
): NormalizedSinopecWorkbookRows | undefined {
  const resultRows: string[][] = [];
  const balanceAdjustRows: SinopecBalanceAdjustRow[] = [];
  let includedSheetCount = 0;
  let totalDataRows = 0;

  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue;
    const header = sheet.rows[0];

    // 形态 A-1：eml 交易信息表。
    const tradeIdx = buildTypedIndex<TradeColumnKey>(header, TRADE_HEADER_ALIASES, ["date", "amount", "product"] as const);
    if (tradeIdx) {
      includedSheetCount++;
      totalDataRows += normalizeTradeRows(sheet.rows, tradeIdx as TradeColumnIndex, accountName, resultRows);
      continue;
    }
    // 形态 A-2：eml 付费信息表。
    const paymentIdx = buildTypedIndex<PaymentColumnKey>(header, PAYMENT_HEADER_ALIASES, ["date", "amount", "location"] as const);
    if (paymentIdx) {
      includedSheetCount++;
      totalDataRows += normalizePaymentRows(sheet.rows, paymentIdx as PaymentColumnIndex, accountName, resultRows);
      continue;
    }
    // 形态 B：财智同形。
    const ledgerIdx = buildLedgerHeaderIndex(header);
    if (!ledgerIdx) continue;
    includedSheetCount++;
    for (let r = 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      if (!row.some((cell) => cleanText(cell))) continue;
      const activityType = cleanText(row[ledgerIdx.activityType]);
      if (!activityType) continue;
      totalDataRows++;
      if (isBalanceAdjust(activityType)) {
        balanceAdjustRows.push({
          date: normalizeDate(row[ledgerIdx.date]),
          targetBalance: ledgerIdx.balance >= 0 ? parseAmount(row[ledgerIdx.balance]) : null,
          activityType,
          remark: cleanText(row[ledgerIdx.remark]),
        });
        continue;
      }
      // 整份文件已被 detectSinopecWorkbook 的内容判据认领；形态 B 的行不再逐行过滤
      // 关键词，否则「转入|xxx」充值行（不含中石化字样）会被误删。
      const normalized = normalizeLedgerRow(row, ledgerIdx, accountName);
      if (normalized) resultRows.push(normalized);
    }
  }

  if (includedSheetCount === 0 || resultRows.length === 0) return undefined;
  return {
    rows: [NORMALIZED_HEADERS, ...resultRows],
    sourceDataRowCount: totalDataRows,
    includedSheetCount,
    balanceAdjustRows,
  };
}

export function detectSinopecWorkbook(
  sheets: readonly SinopecWorkbookSheetRows[],
  accountName?: string,
): NormalizedSinopecWorkbookRows | undefined {
  if (!looksLikeSinopecRows(sheets)) return undefined;
  return normalizeSinopecWorkbookRows(sheets, accountName);
}

/** 财智同形原始表头（导入模板下载用）。 */
export const SINOPEC_RAW_HEADERS = ["\u65e5\u671f", "\u6d41\u5165", "\u6d41\u51fa", "\u6d3b\u52a8\u7c7b\u578b", "\u6807\u7b7e", "\u4f59\u989d", "\u5907\u6ce8"];
/** eml 交易信息表原始表头。 */
export const SINOPEC_TRADE_HEADERS = ["\u5361\u53f7", "\u6301\u5361\u4eba", "\u4ea4\u6613\u65f6\u95f4", "\u4ea4\u6613\u7c7b\u578b", "\u6cb9\u54c1", "\u6570\u91cf(\u5347)", "\u5355\u4ef7(\u5143)", "\u91d1\u989d(\u5143)", "\u5956\u52b1\u5206\u503c", "\u4f59\u989d(\u5143)", "\u5730\u70b9"];
/** eml 付费信息表原始表头。 */
export const SINOPEC_PAYMENT_HEADERS = ["\u5e8f\u53f7", "\u4ed8\u8d39\u65f6\u95f4", "\u4ed8\u8d39\u5730\u70b9", "\u6536\u6b3e\u65b9\u5f0f", "\u5145\u503c\u91d1\u989d(\u5143)"];

export type BuildSinopecTemplateOptions = {
  filename: string;
  title: string;
  description: string;
  status: string;
  sheetName: string;
  fields: Array<{ name: string; label?: string; required: boolean; note: string }>;
  guideNotes: string[];
};

export function buildSinopecImportTemplate(options: BuildSinopecTemplateOptions) {
  return {
    key: "sinopec" as const,
    title: options.title,
    description: options.description,
    status: options.status,
    filename: options.filename,
    downloadFormat: "xlsx" as const,
    sheetName: options.sheetName,
    headers: SINOPEC_RAW_HEADERS,
    rows: [
      ["2026-06-01", "", "300.00", "YZ\u6c7d\u6cb9", "", "3106.08", "\u52a0\u6cb9"],
      ["2026-06-20", "500.00", "", "\u8f6c\u5165|\u4ea4\u884c2479", "", "3606.08", "\u5145\u503c"],
      ["2026-06-25", "", "199.80", "YZ\u6c7d\u6cb9", "", "3406.28", ""],
    ],
    fields: options.fields,
    guideNotes: options.guideNotes,
  };
}

export type SinopecSheetRows = Awaited<ReturnType<typeof readStatementSheetRows>>[number];
