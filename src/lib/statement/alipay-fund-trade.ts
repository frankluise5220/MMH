// 支付宝账单里的基金交易抽取。
//
// 支付宝把基金申购 / 赎回记成「不计收支」，走普通流水只能落成转账，投资资产因此
// 不可见。这里把它们单独抽出来，交给标准的基金导入链路（/api/v1/fund/import），
// 得到带份额、净值、T+N 确认日的真实买卖记录。
//
// 账单里只有基金名称（如「蚂蚁财富-摩根标普500指数(QDII)A-买入」），没有 6 位
// 基金代码 —— 后台要求代码必须是 /^\d{6}$/，所以代码要由服务端按名称反查补上
// （见 /api/v1/fund/resolve-by-names），查不到的在预览里由用户补一次，
// 导入成功后本地就有该基金资料，下次自动匹配。

type AlipayFundTradeSubtype = "buy" | "redeem" | "buy_failed";

export type AlipayFundTrade = {
  date: string;
  amount: number;
  subtype: AlipayFundTradeSubtype;
  fundName: string;
  fundAccount: string;
  cashAccount: string;
  rawText: string;
};

export type AlipayFundTradeSheet = { sheetName: string; rows: string[][] };

const ALIPAY_FUND_INSTITUTION_KEYS = [
  "\u57fa\u91d1",
  "\u8d22\u5bcc",
  "\u9500\u552e",
];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHeader(value: string) {
  return cleanText(value).replace(/\s+/g, "").replace(/[\uff1a:]/g, "").toLowerCase();
}

function findHeaderIndex(headers: readonly string[], aliases: readonly string[]) {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(normalizeHeader(alias));
    if (index >= 0) return index;
  }
  return -1;
}

function readCell(row: string[], index: number) {
  return index >= 0 ? cleanText(row[index]) : "";
}

function parseAmount(value: string) {
  const amount = Number(cleanText(value).replace(/[,\uff0c\uffe5\u00a5\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * 从支付宝商品说明里摘出基金名：「蚂蚁财富-摩根标普500指数(QDII)A-买入」
 * → 「摩根标普500指数(QDII)A」。
 */
export function extractAlipayFundName(product: string) {
  const parts = cleanText(product).split("-").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const withoutPlatform = parts[0] === "\u8682\u8681\u8d22\u5bcc" ? parts.slice(1) : parts;
  return withoutPlatform.slice(0, -1).join("-");
}

function isAlipayOwnedAccount(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return /^(?:\u4f59\u989d|\u652f\u4ed8\u5b9d\u4f59\u989d|\u8d26\u6237\u4f59\u989d|\u4f59\u989d\u5b9d|\u82b1\u5457)$/.test(key);
}

/**
 * 资金账户命名与支付宝普通流水保持一致（余额宝 → 「某人支付宝余额宝」），
 * 避免同一个账户在不同导入链路里冒出两个名字。
 */
function buildCashAccount(paymentMethod: string, ownerHint: string) {
  const raw = cleanText(paymentMethod);
  if (!raw) return "";
  const [primary = "", ...rest] = raw.split(/[&\uff0b+]/).map((part) => part.trim()).filter(Boolean);
  const hasDiscount = Boolean(primary && rest.join(" ").match(/\u7acb\u51cf|\u4f18\u60e0|\u7ea2\u5305|\u62b5\u6263/));
  const method = (hasDiscount ? primary : raw).replace(/^\u82b1\u5457\u5206\u671f/, "\u82b1\u5457");
  if (ownerHint && isAlipayOwnedAccount(method)) {
    return `${ownerHint}\u652f\u4ed8\u5b9d${method.replace(/^\u652f\u4ed8\u5b9d/, "")}`;
  }
  return method;
}

/** 「蚂蚁财富-蚂蚁（杭州）基金销售有限公司」→ 「某人蚂蚁财富基金」 */
function buildFundAccount(counterparty: string, ownerHint: string) {
  const raw = cleanText(counterparty);
  if (!raw) return ownerHint ? `${ownerHint}\u57fa\u91d1` : "\u57fa\u91d1";
  const platform = raw.match(/^([^\u2014-]{1,8})/);
  const label = platform?.[1]?.replace(/[\uff08(].*$/, "").trim() || raw;
  return ownerHint ? `${ownerHint}${label}\u57fa\u91d1` : `${label}\u57fa\u91d1`;
}

function detectSubtype(product: string): AlipayFundTradeSubtype | null {
  const text = cleanText(product);
  if (/\u4e70\u5165\u9000\u6b3e|\u8d2d\u4e70\u5931\u8d25/.test(text)) return "buy_failed";
  if (/\u5356\u51fa|\u8d4e\u56de|\u8f6c\u51fa\u5230\u94f6\u884c\u5361|\u8f6c\u51fa\u81f3/.test(text)) return "redeem";
  if (/\u4e70\u5165|\u8ba4\u8d2d|\u7533\u8d2d|\u5b9a\u6295/.test(text)) return "buy";
  return null;
}

function normalizeAlipayDate(value: string) {
  const raw = cleanText(value).replace(/\s+/g, " ");
  const yearFirst = raw.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (yearFirst) {
    const year = Number(yearFirst[1]);
    const month = Number(yearFirst[2]);
    const day = Number(yearFirst[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return raw;
}

function isFundDistributor(value: string) {
  const key = normalizeHeader(value);
  return ALIPAY_FUND_INSTITUTION_KEYS.some((token) => key.includes(token));
}

/**
 * 从支付宝账单工作簿里抽出基金买卖行。
 * 只管申购（buy）、赎回（redeem）、申购失败退款（buy_failed）；
 * 余额宝的每日收益仍留在普通流水里，由用户在转账 / 利息之间取舍。
 */
export function extractAlipayFundTrades(
  sheets: readonly AlipayFundTradeSheet[],
  ownerHint = "",
): AlipayFundTrade[] {
  const trades: AlipayFundTrade[] = [];

  for (const sheet of sheets) {
    const rows = sheet.rows.filter((row) => row.some((cell) => cleanText(cell)));
    let headerIndex = -1;
    let headers: string[] = [];
    for (const [index, row] of rows.slice(0, 80).entries()) {
      if (
        findHeaderIndex(row, ["\u4ea4\u6613\u65f6\u95f4", "\u4ea4\u6613\u521b\u5efa\u65f6\u95f4"]) >= 0 &&
        findHeaderIndex(row, ["\u5546\u54c1\u8bf4\u660e", "\u5546\u54c1\u540d\u79f0"]) >= 0 &&
        findHeaderIndex(row, ["\u91d1\u989d", "\u91d1\u989d(\u5143)", "\u91d1\u989d\uff08\u5143\uff09"]) >= 0
      ) {
        headerIndex = index;
        headers = row;
        break;
      }
    }
    if (headerIndex < 0) continue;

    const timeIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u65f6\u95f4", "\u4ea4\u6613\u521b\u5efa\u65f6\u95f4"]);
    const categoryIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5206\u7c7b"]);
    const counterpartyIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5bf9\u65b9"]);
    const productIndex = findHeaderIndex(headers, ["\u5546\u54c1\u8bf4\u660e", "\u5546\u54c1\u540d\u79f0"]);
    const amountIndex = findHeaderIndex(headers, ["\u91d1\u989d", "\u91d1\u989d(\u5143)", "\u91d1\u989d\uff08\u5143\uff09"]);
    const paymentIndex = findHeaderIndex(headers, ["\u6536/\u4ed8\u6b3e\u65b9\u5f0f", "\u4ed8\u6b3e\u65b9\u5f0f"]);

    for (const row of rows.slice(headerIndex + 1)) {
      const product = readCell(row, productIndex);
      const counterparty = readCell(row, counterpartyIndex);
      const category = readCell(row, categoryIndex);
      const amount = parseAmount(readCell(row, amountIndex));
      const date = normalizeAlipayDate(readCell(row, timeIndex));
      if (!date || !amount) continue;
      if (category !== "\u6295\u8d44\u7406\u8d22" && !isFundDistributor(counterparty)) continue;

      // 余额宝收益发放是货币基金的日收益，不是一次买卖，留在普通流水里处理。
      if (/\u6536\u76ca\u53d1\u653e|\u5206\u7ea2/.test(product)) continue;

      const fundName = extractAlipayFundName(product);
      // 「余额宝-转出到银行卡 / 大额转入」是现金账户的存取，不是基金买卖，
      // 它们留在普通流水里，别混进基金导入。
      if (!fundName || fundName.startsWith("\u4f59\u989d\u5b9d")) continue;

      const subtype = detectSubtype(product);
      if (!subtype) continue;

      trades.push({
        date,
        amount,
        subtype,
        fundName,
        cashAccount: buildCashAccount(readCell(row, paymentIndex), ownerHint),
        fundAccount: buildFundAccount(counterparty, ownerHint),
        rawText: row.join(","),
      });
    }
  }

  return trades;
}
