import type { StatementWorkbookSheetRows } from "@/lib/statement/alipay-template";
import { parseImportPaymentCardAccount } from "@/lib/account-import-match";
import {
  cleanStatementText as cleanText,
  findStatementHeaderIndex as findHeaderIndex,
  normalizeStatementDate as normalizeWechatDate,
  normalizeStatementHeader as normalizeHeader,
  parseStatementAmount as parseAmount,
  readStatementCell as readCell,
} from "@/lib/statement/header-utils";

/**
 * Normalized row layout produced by the WeChat bill template.
 * Mirrors the Alipay template layout so downstream preview/import
 * pipelines can consume both without changes:
 * [0]  \u65e5\u671f (date, may include time portion)
 * [1]  \u6536\u652f\u5927\u7c7b (majorType)
 * [2]  \u6d41\u51fa (outflow)
 * [3]  \u6d41\u5165 (inflow)
 * [4]  \u91d1\u989d (amount)
 * [5]  \u8d26\u6237 (account)
 * [6]  \u5bf9\u5411\u8d26\u6237 (counter account)
 * [7]  \u5206\u7c7b (category)
 * [8]  \u6536\u652f\u673a\u6784 (institution)
 * [9]  \u5907\u6ce8 (visible remark)
 * [10] \u7b2c\u4e8c\u5907\u6ce8 (match remark)
 */
type NormalizedWechatWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "wechat";
};

type WechatImportTemplate = {
  key: "wechat";
  title: string;
  description: string;
  status: string;
  filename: string;
  downloadFormat: "xlsx";
  sheetName: string;
  headers: string[];
  rows: string[][];
  fields: Array<{ name: string; label: string; required: boolean; note: string }>;
  guideNotes: string[];
};

const NORMALIZED_HEADERS = [
  "\u65e5\u671f",
  "\u6536\u652f\u5927\u7c7b",
  "\u6d41\u51fa",
  "\u6d41\u5165",
  "\u91d1\u989d",
  "\u8d26\u6237",
  "\u5bf9\u5411\u8d26\u6237",
  "\u5206\u7c7b",
  "\u6536\u652f\u673a\u6784",
  "\u5907\u6ce8",
  "\u7b2c\u4e8c\u5907\u6ce8",
];

const WECHAT_INSTITUTION = "\u5fae\u4fe1";
const WECHAT_DEFAULT_ACCOUNT = "\u5fae\u4fe1\u96f6\u94b1";

const WECHAT_TIME_HEADERS = ["\u4ea4\u6613\u65f6\u95f4", "\u4ea4\u6613\u65e5\u671f", "\u652f\u4ed8\u65f6\u95f4", "\u65f6\u95f4"];

const WECHAT_AMOUNT_HEADERS = [
  "\u91d1\u989d",
  "\u91d1\u989d(\u5143)",
  "\u91d1\u989d\uff08\u5143\uff09",
  "\u4ea4\u6613\u91d1\u989d",
];

/**
 * 新版微信导出（2026 起）把金额拆成「支出」「收入」两列，不再有「金额(元)」。
 * 两列各存一侧的正数金额，缺列填空。
 */
const WECHAT_OUTFLOW_AMOUNT_HEADERS = ["\u652f\u51fa", "\u652f\u51fa\u91d1\u989d", "\u4ed8\u6b3e\u91d1\u989d"];
const WECHAT_INFLOW_AMOUNT_HEADERS = ["\u6536\u5165", "\u6536\u5165\u91d1\u989d", "\u6536\u6b3e\u91d1\u989d"];

const WECHAT_FLOW_HEADERS = [
  "\u6536/\u652f",
  "\u6536\uff0f\u652f",
  "\u6536\u652f",
  "\u6536\u652f\u7c7b\u578b",
  "\u6536\u652f\u65b9\u5411",
];

/** 京东（商户名称/交易说明）、支付宝（商品说明）的专属列：微信表头里不会同时出现。 */
const WECHAT_FOREIGN_HEADERS = ["\u5546\u6237\u540d\u79f0", "\u4ea4\u6613\u8bf4\u660e", "\u5546\u54c1\u8bf4\u660e"];

const WECHAT_OWNER_HEADERS = [
  "\u5fae\u4fe1\u6635\u79f0",
  "\u6635\u79f0",
  "\u7528\u6237",
  "\u7528\u6237\u540d",
  "\u6240\u6709\u4eba",
  "\u8d26\u6237\u6240\u6709\u4eba",
  "\u59d3\u540d",
];

function compactJoin(parts: Array<string | undefined>) {
  return parts.map((part) => cleanText(part)).filter(Boolean).join(" / ");
}

/**
 * Normalize a WeChat text cell. The value "/" means "no data" in WeChat
 * bill exports and should be treated as empty.
 */
function normalizeWechatText(value: string) {
  const normalized = cleanText(value);
  if (!normalized || normalized === "/") return "";
  return normalized;
}

function unwrapHeaderValue(value: string) {
  return cleanText(value)
    .replace(/^[\s\[\(\uff08\u3010\u3014]+/, "")
    .replace(/[\s\]\)\uff09\u3011\u3015]+$/, "")
    .trim();
}

function isUsefulOwnerHint(value: string) {
  if (!value || value.length > 40) return false;
  return !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(value) &&
    !/\u8d26\u5355|\u5bfc\u51fa|\u8d77\u59cb|\u7ec8\u6b62|\u4ea4\u6613|\u65f6\u95f4/.test(value);
}

function normalizeWechatOwnerHint(value: string) {
  const hint = unwrapHeaderValue(value);
  return isUsefulOwnerHint(hint) ? hint : "";
}

function findWechatOwnerHint(rows: string[][], headerRowIndex: number) {
  for (const row of rows.slice(0, headerRowIndex)) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = cleanText(row[index]);
      if (!cell) continue;

      const directLabel = WECHAT_OWNER_HEADERS.some((header) => normalizeHeader(cell) === normalizeHeader(header));
      if (directLabel) {
        const nextValue = normalizeWechatOwnerHint(readCell(row, index + 1));
        if (nextValue) return nextValue;
      }

      const labelValueMatch = cell.match(/^([^:\uff1a]{1,16})[:\uff1a]\s*(.+)$/);
      if (!labelValueMatch) continue;
      const label = labelValueMatch[1] ?? "";
      const value = labelValueMatch[2] ?? "";
      const matchesOwnerLabel = WECHAT_OWNER_HEADERS.some((header) => normalizeHeader(label) === normalizeHeader(header));
      if (!matchesOwnerLabel) continue;
      const hint = normalizeWechatOwnerHint(value);
      if (hint) return hint;
    }
  }
  return "";
}

function buildWechatVisibleRemark(transactionType: string, counterparty: string, product: string, rawRemark: string) {
  const parts = [transactionType, counterparty, product].filter(Boolean);
  if (rawRemark && !parts.some((part) => part.includes(rawRemark) || rawRemark.includes(part))) {
    parts.push(rawRemark);
  }
  return compactJoin(parts);
}

function isWechatBalanceAccountText(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return !key || key === "/" || key === "\u96f6\u94b1" || key === "\u5fae\u4fe1\u96f6\u94b1";
}

/** 昵称里的装饰符（emoji、波浪线、括号、标点）：微信昵称常带这些，不能进账户名。 */
const WECHAT_NICKNAME_NOISE_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}~～`^'"*#@!！？?。.,，、:：;；=+|\\/><\-—–_()[\]（）【】]/gu;

/** 昵称由这些通用词组成时不是人名（「微信用户」「微信支付」）。 */
const WECHAT_GENERIC_NICKNAME_RE = /^(?:微信|昵称|用户|支付|账单|转账|零钱|wechat|weixin|user)+$/i;

/**
 * 从微信昵称里抽「像人名」的部分：「ヅ~~墨斗鱼🙈🙉🙊」→「墨斗鱼」。
 *
 * 这是账户名的第一层判断：昵称干净、2-8 字、不是「微信用户」这类通用词，才当成
 * 所有人前缀；否则宁可丢掉昵称——账本里的账户叫「微信零钱」时，拼上脏昵称反而
 * 匹配不上（2019 旧账单实测账户变成「ヅ~~墨斗鱼🙈🙉🙊微信零钱」）。
 */
function extractOwnerNameFromNickname(nickname: string) {
  const base = unwrapHeaderValue(nickname);
  if (!base) return "";
  const cleaned = base.replace(WECHAT_NICKNAME_NOISE_RE, " ");
  const candidates = cleaned.match(/[\u4e00-\u9fa5A-Za-z]+/g) ?? [];
  const best = candidates
    .filter((part) => !WECHAT_GENERIC_NICKNAME_RE.test(part))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  return best.length >= 2 && best.length <= 8 ? best : "";
}

/**
 * Normalize the payment method column into an account name. When the value
 * is "/" (unspecified), default to the WeChat balance account.
 *
 * 所有人前缀只在昵称能抽出干净人名时才加；否则只写「微信零钱」，
 * 由导入预览的账户匹配去账本里按「包含」关系落到「X的微信零钱 / 微信零钱」。
 *
 * 银行卡（2026-11-05 用户要求）：微信 2019 版这列写「招商银行储蓄卡(9447)」，
 * 交给 `parseImportPaymentCardAccount` 拆成 机构 + 卡类型 + 尾号 再拼成
 * `墨斗鱼招商银行储蓄卡(9447)`，让匹配器按「招商银行 + 借记卡 + 9447」精确落账，
 * 而不是靠宽松包含落到同银行另一张也在做借记卡的卡上。
 */
function normalizeWechatPaymentAccount(value: string, ownerHint: string) {
  const raw = cleanText(value);
  if (!isWechatBalanceAccountText(raw)) {
    const ownerName = extractOwnerNameFromNickname(ownerHint);
    return parseImportPaymentCardAccount(raw, ownerName)?.accountName ?? raw;
  }
  const ownerName = extractOwnerNameFromNickname(ownerHint);
  return ownerName ? `${ownerName}${WECHAT_DEFAULT_ACCOUNT}` : WECHAT_DEFAULT_ACCOUNT;
}

/**
 * 微信旧版账单里「已全额退款 / 已退还」的交易不会另起一条收入行，
 * 而是把原来那条支出行的「当前状态」改成这个值（金额仍是正数）。
 * 所以它不是「忽略」信号，而是「方向翻转成收入」的信号，见下方 classifiedFlow。
 */
function isWechatRefundStatus(value: string) {
  return /\u5df2\u5168\u989d\u9000\u6b3e|\u5df2\u9000\u8fd8/.test(value);
}

function classifyWechatFlow(flow: string) {
  if (/^(\u6536\u5165|income|inflow|\u53ce\u5165)$/i.test(flow)) return { majorType: "\u6536\u5165", outflow: false, inflow: true, requiresReview: false };
  if (/^(\u652f\u51fa|expense|outflow|\u652f\u6255\u3044|\u652f\u6255)$/i.test(flow)) return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: false };
  return null;
}

function fallbackWechatFlow() {
  return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: true };
}

const WECHAT_INFLOW_TEXT_RE =
  /(?:\u6536\u5230|\u6536\u6b3e|\u6536\u94b1|\u5165\u8d26|\u5230\u8d26|\u9000\u6b3e|\u8fd4\u73b0|\u5956\u52b1|\u5229\u606f|\u5206\u7ea2|\u8f6c\u5165)/;
const WECHAT_OUTFLOW_TEXT_RE =
  /(?:\u53d1\u51fa|\u6d88\u8d39|\u652f\u4ed8|\u4ed8\u6b3e|\u8f6c\u51fa|\u63d0\u73b0|\u5145\u503c|\u6263\u8d39|\u7f34\u8d39|\u8fd8\u6b3e|\u8f6c\u8d26\u7ed9)/;

/**
 * 方向列的第四层兜底：没有「收/支」列、也没有「支出/收入」双列时，从文字线索判方向。
 * 「转账」本身不收不支，必须靠「转账给 / 收到」这类词区分，所以这里只认成对词。
 */
function inferWechatFlowFromText(...parts: string[]) {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return "";
  if (WECHAT_INFLOW_TEXT_RE.test(text)) return "\u6536\u5165";
  if (WECHAT_OUTFLOW_TEXT_RE.test(text)) return "\u652f\u51fa";
  return "";
}

/**
 * 微信表头打分（2026-11-05）：不再「每一列都必须有」——用户改过表头（删列、改列名、
 * 金额拆两列）就整份降级到标准模板，方向和账户列会静默丢失。改为层层判定：
 *   硬门槛：交易时间 + （金额 或 支出+收入 双列）——没有这两样就不是流水表；
 *   加分项：收/支 + 支付方式 + 当前状态 + 交易对方 + 备注，缺一列只少几分。
 * 命中下限 10 分：删掉任意一列仍能认出是微信账单。
 */
function wechatHeaderScore(row: string[]) {
  if (findHeaderIndex(row, WECHAT_FOREIGN_HEADERS) >= 0) return 0;
  if (findHeaderIndex(row, WECHAT_TIME_HEADERS) < 0) return 0;
  const hasSingleAmount = findHeaderIndex(row, WECHAT_AMOUNT_HEADERS) >= 0;
  // 新版导出没有「金额(元)」，改由「支出」「收入」两列承载金额。
  const hasSplitAmount =
    findHeaderIndex(row, WECHAT_OUTFLOW_AMOUNT_HEADERS) >= 0 &&
    findHeaderIndex(row, WECHAT_INFLOW_AMOUNT_HEADERS) >= 0;
  if (!hasSingleAmount && !hasSplitAmount) return 0;

  // 微信专属列：「收/支」「支付方式」「当前状态」在标准模板（含「支出/收入」双列）里不会有。
  // 缺了这一层，MMH 标准模板导出（交易时间/对方账户/收支大类/商品/支出/收入/账户）
  // 会被微信模板按「时间 + 双列金额 + 商品 + 备注」抢走。
  const hasFlow = findHeaderIndex(row, WECHAT_FLOW_HEADERS) >= 0;
  const hasPaymentAccount = findHeaderIndex(row, ["\u652f\u4ed8\u65b9\u5f0f"]) >= 0;
  const hasStatus = findHeaderIndex(row, ["\u5f53\u524d\u72b6\u6001", "\u4ea4\u6613\u72b6\u6001"]) >= 0;
  if (!hasFlow && !hasPaymentAccount && !hasStatus) return 0;

  let score = 8;
  if (hasFlow) score += 2;
  if (hasPaymentAccount) score += 2;
  if (hasStatus) score += 2;
  if (findHeaderIndex(row, ["\u4ea4\u6613\u5bf9\u65b9"]) >= 0) score += 1;
  if (findHeaderIndex(row, ["\u5907\u6ce8"]) >= 0) score += 1;
  if (findHeaderIndex(row, ["\u5546\u54c1"]) >= 0) score += 1;
  return score >= 10 ? score : 0;
}

function findWechatHeaderRow(rows: string[][]) {
  let bestIndex = -1;
  let bestScore = 0;
  rows.slice(0, 60).forEach((row, index) => {
    const score = wechatHeaderScore(row);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function normalizeWechatSheetRows(sheet: StatementWorkbookSheetRows) {
  const compactRows = sheet.rows.filter((row) => row.some((cell) => cleanText(cell)));
  const headerRowIndex = findWechatHeaderRow(compactRows);
  if (headerRowIndex < 0) return null;

  const headers = compactRows[headerRowIndex] ?? [];
  const dataRows = compactRows.slice(headerRowIndex + 1);
  const ownerHint = findWechatOwnerHint(compactRows, headerRowIndex);
  const timeIndex = findHeaderIndex(headers, WECHAT_TIME_HEADERS);
  const counterpartyIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5bf9\u65b9"]);
  const productIndex = findHeaderIndex(headers, ["\u5546\u54c1", "\u5546\u54c1\u8bf4\u660e", "\u5546\u54c1\u540d\u79f0"]);
  const flowIndex = findHeaderIndex(headers, WECHAT_FLOW_HEADERS);
  const amountIndex = findHeaderIndex(headers, WECHAT_AMOUNT_HEADERS);
  const outflowAmountIndex = amountIndex >= 0 ? -1 : findHeaderIndex(headers, WECHAT_OUTFLOW_AMOUNT_HEADERS);
  const inflowAmountIndex = amountIndex >= 0 ? -1 : findHeaderIndex(headers, WECHAT_INFLOW_AMOUNT_HEADERS);
  const accountIndex = findHeaderIndex(headers, ["\u652f\u4ed8\u65b9\u5f0f", "\u4ed8\u6b3e\u65b9\u5f0f", "\u8d44\u91d1\u6e20\u9053"]);
  const statusIndex = findHeaderIndex(headers, ["\u5f53\u524d\u72b6\u6001", "\u4ea4\u6613\u72b6\u6001"]);
  const transactionTypeIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u7c7b\u578b", "\u7c7b\u578b"]);
  const orderIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5355\u53f7", "\u4ea4\u6613\u53f7"]);
  const merchantOrderIndex = findHeaderIndex(headers, ["\u5546\u6237\u5355\u53f7"]);
  const remarkIndex = findHeaderIndex(headers, ["\u5907\u6ce8"]);

  const normalizedRows = dataRows.flatMap((row) => {
    const status = readCell(row, statusIndex);
    const outflowAmount = outflowAmountIndex >= 0 ? parseAmount(readCell(row, outflowAmountIndex)) : "";
    const inflowAmount = inflowAmountIndex >= 0 ? parseAmount(readCell(row, inflowAmountIndex)) : "";
    // 金额三层：单列「金额」→「支出/收入」双列 → 都没有就丢行。
    const amount = parseAmount(readCell(row, amountIndex)) || outflowAmount || inflowAmount;
    const date = normalizeWechatDate(readCell(row, timeIndex));
    if (!date || !amount) return [];

    const counterparty = normalizeWechatText(readCell(row, counterpartyIndex));
    const product = normalizeWechatText(readCell(row, productIndex));
    const transactionType = normalizeWechatText(readCell(row, transactionTypeIndex));
    const rawRemark = normalizeWechatText(readCell(row, remarkIndex));
    // 收支方向三层：收/支列 → 支出/收入哪列有值 → 交易类型/商品/对方的文字线索；
    // 三层都判不出来才落「待确认」，不再默认当支出。
    const flow = readCell(row, flowIndex)
      || (outflowAmount ? "\u652f\u51fa" : inflowAmount ? "\u6536\u5165" : "")
      || inferWechatFlowFromText(transactionType, product, counterparty, rawRemark);

    // 微信旧版账单专用口径（2026-11-05 用户裁定）：「收/支」列写着「支出」、
    // 当前状态是「已全额退款 / 已退还」时，钱当天已经退回付款账户，
    // 必须记成收入（金额仍是正数），不能再当支出扣一次余额。
    // 例：2019-11-19 转账给 TK-史美玲 ¥2,000 状态「已全额退款」→ 收入 ¥2,000，
    // 与 2019-11-20 那笔「对方已收钱」的支出 ¥2,000 正好一进一出。
    const declaredFlow = classifyWechatFlow(flow);
    const refunded = isWechatRefundStatus(status);
    const classifiedFlow =
      refunded && declaredFlow?.outflow
        ? { majorType: "\u6536\u5165", outflow: false, inflow: true, requiresReview: false }
        : declaredFlow ?? fallbackWechatFlow();
    // 方向由「已全额退款」定死的行不需要人工确认；只有方向本身判不出来时才留待确认。
    const requiresReview = classifiedFlow.requiresReview || (refunded && !declaredFlow);

    const account = normalizeWechatPaymentAccount(readCell(row, accountIndex), ownerHint);
    const orderNo = readCell(row, orderIndex);
    const merchantOrderNo = readCell(row, merchantOrderIndex);

    const visibleRemark = buildWechatVisibleRemark(transactionType, counterparty, product, rawRemark);
    const matchRemark = compactJoin([
      requiresReview
        ? account
          ? `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u7c7b\u578b`
          : `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u7c7b\u578b\u548c\u8d26\u6237`
        : "",
      // 退款行也写「原收支」，让用户看到微信原文写的是「支出」、是我们按退款口径翻成收入。
      flow && (requiresReview || refunded) ? `\u539f\u6536\u652f:${flow}` : "",
      rawRemark && !visibleRemark.includes(rawRemark) ? `\u539f\u59cb\u5907\u6ce8:${rawRemark}` : "",
      orderNo ? `\u5fae\u4fe1\u5355\u53f7:${orderNo}` : "",
      merchantOrderNo ? `\u5546\u6237\u5355\u53f7:${merchantOrderNo}` : "",
      status && (requiresReview || refunded) ? `\u72b6\u6001:${status}` : "",
    ]);

    return [[
      date,
      classifiedFlow.majorType,
      classifiedFlow.outflow ? amount : "",
      classifiedFlow.inflow ? amount : "",
      amount,
      // 账户列不因「待确认」清空（2026-11-05 用户：2019-11-19 那笔「已全额退款」的转账
      // 付款方式写着「零钱」，却因为状态被标待确认而把账户清空，预览随即回退到
      // 发起导入的那个账户——一笔零钱转账被记成了「宁波(0214)」银行储蓄卡）。
      // 付款方式能解析出来就是可用信息，待确认只影响「类型」，不影响「账户」。
      account,
      "",
      "",
      WECHAT_INSTITUTION,
      visibleRemark,
      matchRemark,
    ]];
  });

  return {
    rows: normalizedRows,
    sourceDataRowCount: dataRows.length,
  };
}

export function normalizeWechatWorkbookRows(
  sheetRows: readonly StatementWorkbookSheetRows[],
): NormalizedWechatWorkbookRows | null {
  const normalizedSheets = sheetRows
    .map(normalizeWechatSheetRows)
    .filter((sheet): sheet is { rows: string[][]; sourceDataRowCount: number } => Boolean(sheet));
  if (normalizedSheets.length === 0) return null;

  return {
    rows: [NORMALIZED_HEADERS, ...normalizedSheets.flatMap((sheet) => sheet.rows)],
    sourceDataRowCount: normalizedSheets.reduce((sum, sheet) => sum + sheet.sourceDataRowCount, 0),
    includedSheetCount: normalizedSheets.length,
    profile: "wechat",
  };
}


export function buildWechatImportTemplate(t: (key: string, params?: Record<string, string | number>) => string): WechatImportTemplate {
  return {
    key: "wechat",
    title: t("batchImport.template.wechat.title"),
    description: t("batchImport.template.wechat.description"),
    status: t("batchImport.template.normal.status"),
    filename: t("batchImport.template.wechat.filename") + ".xlsx",
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: [
      "\u4ea4\u6613\u65f6\u95f4",
      "\u6536/\u652f",
      "\u91d1\u989d(\u5143)",
      "\u652f\u4ed8\u65b9\u5f0f",
      "\u5f53\u524d\u72b6\u6001",
      "\u4ea4\u6613\u7c7b\u578b",
      "\u4ea4\u6613\u5bf9\u65b9",
      "\u5546\u54c1",
      "\u5907\u6ce8",
      "\u4ea4\u6613\u5355\u53f7",
      "\u5546\u6237\u5355\u53f7",
    ],
    rows: [
      [
        "2026-06-08 08:12:30",
        "\u652f\u51fa",
        "32.50",
        t("batchImport.template.sample.wechatBalance"),
        "\u652f\u4ed8\u6210\u529f",
        "\u5546\u6237\u6d88\u8d39",
        t("viewImport.sampleMerchantFastFood"),
        t("viewImport.sampleRemarkLunch"),
        t("viewImport.sampleRemarkLunch"),
        "WX202606080001",
        "M202606080001",
      ],
      [
        "2026-06-09 12:30:00",
        "\u6536\u5165",
        "100.00",
        t("batchImport.template.sample.wechatBalance"),
        "\u5df2\u5165\u8d26",
        "\u7ea2\u5305",
        t("batchImport.template.sample.wechatFriend"),
        t("batchImport.template.sample.wechatRedPacket"),
        t("viewImport.sampleRemarkTransfer"),
        "WX202606090002",
        "M202606090002",
      ],
      [
        "2026-06-10 18:00:00",
        "\u652f\u51fa",
        "108.00",
        t("batchImport.template.sample.wechatBalance"),
        "\u5df2\u5168\u989d\u9000\u6b3e",
        "\u5546\u6237\u6d88\u8d39",
        t("viewImport.sampleMerchantRestaurant"),
        t("batchImport.template.sample.wechatRefund"),
        t("viewImport.sampleRemarkCreditCardRefund"),
        "WX202606100003",
        "M202606100003",
      ],
    ],
    fields: [
      { name: "transactionTime", label: t("batchImport.template.wechat.label.transactionTime"), required: true, note: t("batchImport.template.wechat.field.transactionTime") },
      { name: "flow", label: t("batchImport.template.wechat.label.flow"), required: true, note: t("batchImport.template.wechat.field.flow") },
      { name: "amount", label: t("batchImport.template.wechat.label.amount"), required: true, note: t("batchImport.template.wechat.field.amount") },
      { name: "paymentAccount", label: t("batchImport.template.wechat.label.paymentAccount"), required: true, note: t("batchImport.template.wechat.field.paymentAccount") },
      { name: "status", label: t("batchImport.template.wechat.label.status"), required: false, note: t("batchImport.template.wechat.field.status") },
      { name: "transactionType", label: t("batchImport.template.wechat.label.transactionType"), required: false, note: t("batchImport.template.wechat.field.transactionType") },
      { name: "counterparty", label: t("batchImport.template.wechat.label.counterparty"), required: true, note: t("batchImport.template.wechat.field.counterparty") },
      { name: "product", label: t("batchImport.template.wechat.label.product"), required: false, note: t("batchImport.template.wechat.field.product") },
      { name: "remark", label: t("batchImport.template.wechat.label.remark"), required: false, note: t("batchImport.template.wechat.field.remark") },
      { name: "orderNo", label: t("batchImport.template.wechat.label.orderNo"), required: false, note: t("batchImport.template.wechat.field.orderNo") },
      { name: "merchantOrderNo", label: t("batchImport.template.wechat.label.merchantOrderNo"), required: false, note: t("batchImport.template.wechat.field.merchantOrderNo") },
    ],
    guideNotes: [
      t("batchImport.guide.currentSupport"),
      t("batchImport.guide.wechatBill"),
    ],
  };
}
