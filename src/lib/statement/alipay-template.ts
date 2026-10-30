import {
  cleanStatementText as cleanText,
  findStatementHeaderIndex as findHeaderIndex,
  normalizeStatementDate,
  normalizeStatementHeader as normalizeHeader,
  parseStatementAmount as parseAmount,
  readStatementCell as readCell,
} from "@/lib/statement/header-utils";

export type StatementWorkbookSheetRows = {
  sheetName: string;
  rows: string[][];
};

type NormalizedStatementWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "alipay";
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

const ALIPAY_INSTITUTION = "\u652f\u4ed8\u5b9d";
const ALIPAY_TIME_HEADERS = [
  "\u4ea4\u6613\u65f6\u95f4",
  "\u4ea4\u6613\u521b\u5efa\u65f6\u95f4",
  "\u4ed8\u6b3e\u65f6\u95f4",
];
const ALIPAY_AMOUNT_HEADERS = ["\u91d1\u989d", "\u91d1\u989d\uff08\u5143\uff09", "\u91d1\u989d(\u5143)"];
const ALIPAY_DESCRIPTION_HEADERS = ["\u5546\u54c1\u8bf4\u660e", "\u5546\u54c1\u540d\u79f0", "\u5546\u54c1"];
const ALIPAY_PAYMENT_ACCOUNT_HEADERS = [
  "\u6536/\u4ed8\u6b3e\u65b9\u5f0f",
  "\u6536\u4ed8\u6b3e\u65b9\u5f0f",
  "\u4ed8\u6b3e\u65b9\u5f0f",
  "\u6536\u6b3e\u65b9\u5f0f",
  "\u652f\u4ed8\u65b9\u5f0f",
  "\u8d44\u91d1\u6e20\u9053",
  "\u6263\u6b3e\u65b9\u5f0f",
];

const ALIPAY_OWNER_HEADERS = [
  "\u59d3\u540d",
  "\u7528\u6237",
  "\u7528\u6237\u540d",
  "\u6240\u6709\u4eba",
  "\u8d26\u6237\u6240\u6709\u4eba",
  "\u8d26\u53f7\u59d3\u540d",
  "\u8d26\u6237\u540d",
];

function findAlipayHeaderRow(rows: string[][]) {
  // 支付宝导出的回单头部有「导出信息 / 特别提示 / 电子客户回单」等说明行，
  // 表头通常落在第 20 行以后，扫描窗口必须比 25 行更宽。
  for (const [index, row] of rows.slice(0, 60).entries()) {
    const timeIndex = findHeaderIndex(row, ALIPAY_TIME_HEADERS);
    const flowIndex = findHeaderIndex(row, ["\u6536/\u652f", "\u6536\u652f"]);
    const amountIndex = findHeaderIndex(row, ALIPAY_AMOUNT_HEADERS);
    const statusIndex = findHeaderIndex(row, ["\u4ea4\u6613\u72b6\u6001"]);
    const counterpartyIndex = findHeaderIndex(row, ["\u4ea4\u6613\u5bf9\u65b9"]);
    const descriptionIndex = findHeaderIndex(row, ALIPAY_DESCRIPTION_HEADERS);
    // 京东用「商户名称 + 交易说明」，微信用「支付方式」，都不属于支付宝表头：
    // 出现这两列就跳过，避免京东 / 微信账单被支付宝模板抢走（两者都有「交易状态」「交易分类」）。
    if (findHeaderIndex(row, ["\u5546\u6237\u540d\u79f0"]) >= 0) continue;
    if (findHeaderIndex(row, ["\u652f\u4ed8\u65b9\u5f0f"]) >= 0) continue;
    // 「收/付款方式」只出现在资金明细导出里，交易明细导出没有这一列，
    // 因此账户列不是命中条件；「交易对方 / 商品说明」才是支付宝的专属特征。
    if (
      timeIndex >= 0 &&
      flowIndex >= 0 &&
      amountIndex >= 0 &&
      statusIndex >= 0 &&
      (counterpartyIndex >= 0 || descriptionIndex >= 0)
    ) {
      return index;
    }
  }
  return -1;
}

/** 支付宝交易明细只按日入账，时间部分丢掉；新旧两种日期写法由共性解析器兼容。 */
function normalizeAlipayDate(value: string) {
  return normalizeStatementDate(value, { keepTime: false });
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
    !/\u8d26\u5355|\u5bfc\u51fa|\u8d77\u59cb|\u7ec8\u6b62|\u4ea4\u6613|\u65f6\u95f4|\u652f\u4ed8\u5b9d/.test(value);
}

function normalizeAlipayOwnerHint(value: string) {
  const hint = unwrapHeaderValue(value);
  return isUsefulOwnerHint(hint) ? hint : "";
}

function findAlipayOwnerHint(rows: string[][], headerRowIndex: number) {
  for (const row of rows.slice(0, headerRowIndex)) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = cleanText(row[index]);
      if (!cell) continue;

      const directLabel = ALIPAY_OWNER_HEADERS.some((header) => normalizeHeader(cell) === normalizeHeader(header));
      if (directLabel) {
        const nextValue = normalizeAlipayOwnerHint(row.slice(index + 1).map(cleanText).find(Boolean) ?? "");
        if (nextValue) return nextValue;
      }

      const labelValueMatch = cell.match(/^([^:\uff1a]{1,16})[:\uff1a]\s*(.+)$/);
      if (!labelValueMatch) continue;
      const label = labelValueMatch[1] ?? "";
      const value = labelValueMatch[2] ?? "";
      const matchesOwnerLabel = ALIPAY_OWNER_HEADERS.some((header) => normalizeHeader(label) === normalizeHeader(header));
      if (!matchesOwnerLabel) continue;
      const hint = normalizeAlipayOwnerHint(value);
      if (hint) return hint;
    }
  }
  return "";
}

function isAlipayOwnedPaymentAccount(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return /^(?:\u4f59\u989d|\u652f\u4ed8\u5b9d\u4f59\u989d|\u8d26\u6237\u4f59\u989d|\u4f59\u989d\u5b9d|\u82b1\u5457)$/.test(key);
}

function normalizePaymentAccount(value: string, ownerHint: string) {
  const raw = cleanText(value);
  if (!raw) return "";
  const [primary, ...rest] = raw.split(/[&\uff0b+]/).map((part) => part.trim()).filter(Boolean);
  // 「花呗&优惠」这类组合写法只取主渠道，但所有人前缀要与普通写法一致，
  // 否则同一个花呗账户会在 MMH 里冒出「花呗」和「张四支付宝花呗」两个名字。
  const hasDiscountSuffix = Boolean(primary && rest.join(" ").match(/\u7acb\u51cf|\u4f18\u60e0|\u7ea2\u5305|\u62b5\u6263/));
  const normalized = hasDiscountSuffix && primary
    ? (/^\u82b1\u5457\u5206\u671f/.test(primary) ? "\u82b1\u5457" : primary)
    : (/^\u82b1\u5457\u5206\u671f/.test(raw) ? "\u82b1\u5457" : raw);
  if (ownerHint && isAlipayOwnedPaymentAccount(normalized)) {
    return `${ownerHint}${ALIPAY_INSTITUTION}${normalized.replace(/^\u652f\u4ed8\u5b9d/, "")}`;
  }
  return normalized;
}

function isIgnoredStatus(value: string, flow: string) {
  if (/\u5931\u8d25|\u53d6\u6d88/.test(value)) return true;
  return flow === "\u6536\u5165" && /\u4ea4\u6613\u5173\u95ed|\u5df2\u5173\u95ed/.test(value);
}

function isRefundLikeText(value: string) {
  return /\u9000\u6b3e|\u9000\u8d27|\u9000\u56de|\u6d88\u8d39\u64a4\u9500|\u4ea4\u6613\u64a4\u9500|\u51b2\u6b63|\u64a4\u9500|Refund|Return|Reversal/i.test(value);
}

function isInvestmentLikeText(value: string) {
  return /\u6295\u8d44\u7406\u8d22|\u8682\u8681\u8d22\u5bcc|\u57fa\u91d1|\u7406\u8d22|\u4e70\u5165|\u5356\u51fa|\u8d4e\u56de|\u8f6c\u51fa\u81f3|\u4efd\u989d\u786e\u8ba4/.test(value);
}

/**
 * 花呗 / 借呗 / 信用卡的自动还款。支付宝把它们记为「不计收支」，
 * 但语义是花钱从付款账户（余额宝 / 余额 / 银行卡）划去还账单，
 * 落到 MMH 应该是转账，不是支出。
 */
function isRepaymentLikeText(value: string) {
  return /\u82b1\u5457|\u501f\u5457|\u5907\u7528\u91d1|\u7f51\u5546\u8d37|\u8fd8\u6b3e|\u8fd8\u5457|\u5206\u671f/.test(value);
}

/**
 * 基金公司直接打过来的收益：货币基金每日把收益发放到余额宝
 * （如「余额宝-2026.07.28-收益发放」，交易对方是基金公司）。
 * 支付宝记成「不计收支」，但这不是自己账户之间搬家，而是真金白银的进账，
 * 因此记收入，也不需要「对向账户」（基金公司不是账本里的账户）。
 */
function isFundYieldPayoutText(value: string) {
  return /\u6536\u76ca\u53d1\u653e|\u6536\u76ca\u7ed3\u8f6c|\u4e07\u4efd\u6536\u76ca/.test(value);
}

/**
 * 基金 / 理财里的「钱回来」：基金分红、卖出赎回、买入退款、转出到银行卡。
 * 这些要走转账的反向（基金 → 资金账户），其余 fund flows 一律按买入方向。
 * 收益发放不在这里：它走上面的收入规则。
 */
function isFundRedemptionLikeText(value: string) {
  return /\u5206\u7ea2|\u5356\u51fa|\u8d4e\u56de|\u8f6c\u51fa\u5230\u94f6\u884c\u5361|\u9000\u6b3e/.test(value);
}

function classifyAlipayFlow(params: {
  flow: string;
  category: string;
  status: string;
  description: string;
  remark: string;
  counterparty: string;
  counterpartyAccount: string;
}) {
  if (params.flow === "\u652f\u51fa") return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: false, isTransfer: false };
  if (params.flow === "\u6536\u5165") return { majorType: "\u6536\u5165", outflow: false, inflow: true, requiresReview: false, isTransfer: false };

  const source = [
    params.category,
    params.status,
    params.description,
    params.remark,
    params.counterparty,
    params.counterpartyAccount,
  ].join(" ");
  // 基金公司发的收益（余额宝每日益等）：真进账，记收入，不需要对向账户。
  if (params.flow === "\u4e0d\u8ba1\u6536\u652f" && isFundYieldPayoutText(source)) {
    return { majorType: "\u6536\u5165", outflow: false, inflow: true, requiresReview: false, isTransfer: false };
  }
  if (params.flow === "\u4e0d\u8ba1\u6536\u652f" && isRefundLikeText(source) && !isInvestmentLikeText(source)) {
    return { majorType: "\u652f\u51fa", outflow: false, inflow: true, requiresReview: false, isTransfer: false };
  }
  // 花呗 / 信用卡自动还款：付款方式账户 → 被还款的账户（交易对方），是转账。
  if (
    params.flow === "\u4e0d\u8ba1\u6536\u652f" &&
    isRepaymentLikeText(`${params.category} ${source}`) &&
    !isInvestmentLikeText(source)
  ) {
    return { majorType: "\u8f6c\u8d26", outflow: true, inflow: false, requiresReview: false, isTransfer: true };
  }
  // 基金申购 / 理财：钱在余额宝和基金之间走，按用户的口径记成转账。
  // 方向以买入为准（资金 → 基金销售机构），只有「卖出赎回 / 退款 /
  // 转出到银行卡」这类钱回来的才反向。没有基金代码可用，基金名留在备注里。
  if (params.flow === "\u4e0d\u8ba1\u6536\u652f" && isInvestmentLikeText(source)) {
    const inflow = isFundRedemptionLikeText(source);
    return { majorType: "\u8f6c\u8d26", outflow: !inflow, inflow, requiresReview: false, isTransfer: true };
  }

  return null;
}

function fallbackAlipayFlow() {
  return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: true, isTransfer: false };
}

function normalizeAlipayCounterparty(value: string) {
  const normalized = cleanText(value).replace(/\/$/, "").trim();
  return /^[-\u2013\u2014?/]+$/.test(normalized) ? "" : normalized;
}

function compactJoin(parts: Array<string | undefined>) {
  return parts.map((part) => cleanText(part)).filter(Boolean).join(" / ");
}

function normalizeRemarkComparisonText(value: string) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s/\\|,\uff0c.;\uff1b:\uff1a()[\]{}\uff08\uff09\u3010\u3011<>\u300a\u300b'"\u201c\u201d\u2018\u2019_-]+/g, "");
}

function containsRemarkPart(container: string, candidate: string) {
  const normalizedContainer = normalizeRemarkComparisonText(container);
  const normalizedCandidate = normalizeRemarkComparisonText(candidate);
  return Boolean(normalizedCandidate && normalizedContainer.includes(normalizedCandidate));
}

function buildAlipayVisibleRemark(params: {
  description: string;
  rawRemark: string;
  counterparty: string;
  counterpartyAccount: string;
  category: string;
}) {
  const parts = [params.description || params.rawRemark].filter(Boolean);
  for (const candidate of [params.counterparty, params.counterpartyAccount]) {
    if (!candidate || parts.some((part) => containsRemarkPart(part, candidate))) continue;
    parts.push(candidate);
  }
  return compactJoin(parts) || params.category;
}

function normalizeAlipaySheetRows(sheet: StatementWorkbookSheetRows, ownerOverride = "") {
  const compactRows = sheet.rows.filter((row) => row.some((cell) => cleanText(cell)));
  const headerRowIndex = findAlipayHeaderRow(compactRows);
  if (headerRowIndex < 0) return null;

  const headers = compactRows[headerRowIndex] ?? [];
  const dataRows = compactRows.slice(headerRowIndex + 1);
  const ownerHint = cleanText(ownerOverride) || findAlipayOwnerHint(compactRows, headerRowIndex);
  const timeIndex = findHeaderIndex(headers, ALIPAY_TIME_HEADERS);
  const categoryIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5206\u7c7b"]);
  const counterpartyIndex = (() => {
    const explicit = findHeaderIndex(headers, ["\u4ea4\u6613\u5bf9\u65b9"]);
    if (explicit >= 0) return explicit;
    const flowIndex = findHeaderIndex(headers, ["\u6536/\u652f", "\u6536\u652f"]);
    return categoryIndex >= 0 && flowIndex > categoryIndex + 1 ? categoryIndex + 1 : -1;
  })();
  const counterpartyAccountIndex = findHeaderIndex(headers, ["\u5bf9\u65b9\u8d26\u53f7"]);
  const descriptionIndex = findHeaderIndex(headers, ALIPAY_DESCRIPTION_HEADERS);
  const flowIndex = findHeaderIndex(headers, ["\u6536/\u652f", "\u6536\u652f"]);
  const amountIndex = findHeaderIndex(headers, ALIPAY_AMOUNT_HEADERS);
  const accountIndex = findHeaderIndex(headers, ALIPAY_PAYMENT_ACCOUNT_HEADERS);
  const statusIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u72b6\u6001"]);
  const orderIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u8ba2\u5355\u53f7"]);
  const merchantOrderIndex = findHeaderIndex(headers, ["\u5546\u5bb6\u8ba2\u5355\u53f7"]);
  const remarkIndex = findHeaderIndex(headers, ["\u5907\u6ce8"]);

  const normalizedRows = dataRows.flatMap((row) => {
    const status = readCell(row, statusIndex);
    const flow = readCell(row, flowIndex);
    const amount = parseAmount(readCell(row, amountIndex));
    const date = normalizeAlipayDate(readCell(row, timeIndex));
    if (!date || !amount) return [];

    const rawAccount = readCell(row, accountIndex);
    const account = normalizePaymentAccount(rawAccount, ownerHint);
    const counterparty = normalizeAlipayCounterparty(readCell(row, counterpartyIndex));
    const category = readCell(row, categoryIndex);
    const description = readCell(row, descriptionIndex);
    const counterpartyAccount = normalizeAlipayCounterparty(readCell(row, counterpartyAccountIndex));
    const orderNo = readCell(row, orderIndex);
    const merchantOrderNo = readCell(row, merchantOrderIndex);
    const rawRemark = readCell(row, remarkIndex);
    const classifiedFlow = classifyAlipayFlow({
      flow,
      category,
      status,
      description,
      remark: rawRemark,
      counterparty,
      counterpartyAccount,
    }) ?? fallbackAlipayFlow();
    const transferCounterAccount = classifiedFlow.isTransfer
      ? normalizePaymentAccount(counterparty, ownerHint)
      : "";
    // 转账缺了对向账户就没法落库，仍然要人工确认。
    const requiresReview =
      classifiedFlow.requiresReview ||
      isIgnoredStatus(status, flow) ||
      accountIndex < 0 ||
      (classifiedFlow.isTransfer && !counterparty);

    const visibleRemark = buildAlipayVisibleRemark({
      description,
      rawRemark,
      counterparty,
      counterpartyAccount,
      category,
    });
    const matchRemark = compactJoin([
      requiresReview
        ? classifiedFlow.requiresReview
          ? `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u7c7b\u578b\u548c\u8d26\u6237`
          : `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u8d26\u6237`
        : "",
      flow && requiresReview ? `\u539f\u6536\u652f:${flow}` : "",
      counterparty ? `\u5546\u6237:${counterparty}` : "",
      rawRemark && !containsRemarkPart(visibleRemark, rawRemark) ? `\u539f\u5907\u6ce8:${rawRemark}` : "",
      rawAccount && rawAccount !== account ? `\u539f\u4ed8\u6b3e\u65b9\u5f0f:${rawAccount}` : "",
      counterpartyAccount ? `\u5bf9\u65b9\u8d26\u53f7:${counterpartyAccount}` : "",
      orderNo ? `\u652f\u4ed8\u5b9d\u8ba2\u5355:${orderNo}` : "",
      merchantOrderNo ? `\u5546\u5bb6\u8ba2\u5355:${merchantOrderNo}` : "",
      status && (flow === "\u4e0d\u8ba1\u6536\u652f" || !/^(\u4ea4\u6613\u6210\u529f|\u652f\u4ed8\u6210\u529f|\u9000\u6b3e\u6210\u529f|\u8fd8\u6b3e\u6210\u529f)$/.test(status)) ? `\u72b6\u6001:${status}` : "",
    ]);

    return [[
      date,
      classifiedFlow.majorType,
      classifiedFlow.outflow ? amount : "",
      classifiedFlow.inflow ? amount : "",
      amount,
      requiresReview ? "" : account,
      requiresReview ? "" : transferCounterAccount,
      "",
      ALIPAY_INSTITUTION,
      visibleRemark,
      matchRemark,
    ]];
  });

  return {
    rows: normalizedRows,
    sourceDataRowCount: dataRows.length,
  };
}

export function normalizeAlipayWorkbookRows(
  sheetRows: readonly StatementWorkbookSheetRows[],
  ownerOverride = "",
): NormalizedStatementWorkbookRows | null {
  const normalizedSheets = sheetRows
    .map((sheet) => normalizeAlipaySheetRows(sheet, ownerOverride))
    .filter((sheet): sheet is { rows: string[][]; sourceDataRowCount: number } => Boolean(sheet));
  if (normalizedSheets.length === 0) return null;

  return {
    rows: [NORMALIZED_HEADERS, ...normalizedSheets.flatMap((sheet) => sheet.rows)],
    sourceDataRowCount: normalizedSheets.reduce((sum, sheet) => sum + sheet.sourceDataRowCount, 0),
    includedSheetCount: normalizedSheets.length,
    profile: "alipay",
  };
}
