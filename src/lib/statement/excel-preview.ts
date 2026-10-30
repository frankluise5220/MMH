import { parseFlexibleDateToYmd } from "@/lib/date-utils";
import {
  dropTemplateSampleRows,
  findTemplateGuideTitleRowIndex,
  findTemplateSampleColumnIndex,
  rowsBeforeTemplateGuide,
} from "@/lib/import-template-sample";
import {
  inferBalanceBasedInflowSign,
  inferSignedAmountInflowSign,
  isCreditCardRepaymentLikeText,
  isExpenseRefundLikeText,
  signedAmountDirection,
} from "@/lib/statement/amount-direction";
import {
  STATEMENT_IMPORT_FIELD_HEADERS,
  SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE,
  createStatementHeaderReader,
  matchStatementHeaderProfile,
  normalizeSpdbCurrencyCode,
  parseSpdbOriginalAmount,
  type StatementImportField,
} from "@/lib/statement/header-catalog";
import { normalizeAlipayWorkbookRows } from "@/lib/statement/alipay-template";
import {
  guessCaizhiAccountNameFromFilename,
  normalizeCaizhiWorkbookRows,
  detectCaizhiHeaders,
  type CaizhiBalanceAdjustRow,
  type CaizhiWorkbookSheetRows,
} from "@/lib/statement/caizhi-template";
import { normalizeJdWorkbookRows } from "@/lib/statement/jd-template";
import { normalizeWechatWorkbookRows } from "@/lib/statement/wechat-template";
import { readStatementSheetRows } from "@/lib/statement/statement-sheet-reader";
import { guessOwnerFromFilename } from "@/lib/statement/owner-from-filename";
import { normalizeStatementHeader as normalizeHeader } from "@/lib/statement/header-utils";
import {
  alignStatementIncomeRefunds,
  enrichKnownStatementMerchantForImport,
} from "@/lib/statement/import-normalization";

type StatementExcelPreviewItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  inflow?: number;
  outflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  transferDirection?: "in" | "out";
  category?: string;
  categoryUserEdited?: boolean;
  remark?: string;
  counterparty?: string;
  institution?: string;
  institutionUserEdited?: boolean;
  postedDate?: string;
  currency?: string;
  originalCurrency?: string;
  originalAmount?: number;
  _meta?: {
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
};

type StatementFieldHeaders = Record<StatementImportField, readonly string[]>;

/**
 * 「余额」列别名，只用于按余额差额反推收支方向（招行流水：「联机余额」）。
 * 刻意不加入 STATEMENT_IMPORT_FIELD_HEADERS：它不是导入字段，避免预览/字段映射 UI 多出一列。
 */
const STATEMENT_BALANCE_HEADER_ALIASES = [
  "余额",
  "联机余额",
  "账户余额",
  "帐户余额",
  "本次余额",
  "当前余额",
  "交易后余额",
  "交易后账户余额",
  "balance",
  "runningbalance",
  "残高",
] as const;

/**
 * 银行流水「摘要」里的本行内部资金划转 / 投资申赎判定。
 *
 * 只在既没有「收支大类」列、也没有流入/流出列时启用：支付宝、微信、京东、财智等模板
 * 归一化后自带类型列，模板给的类型优先，不会被摘要关键词改写。
 * 招行借记卡流水就是典型场景——摘要「朝朝宝转入/转出」「转账汇款」其实是转账，
 * 「基金申购/赎回」其实是投资，若按金额正负当成支出/收入，语义就丢了。
 */
/**
 * 「转账汇款 / 行内转账 / 跨行转账 / 网银转账 / 手机银行转账」只是同一个词的不同包装，
 * 摘要里出现「转账」即转账，不列举变体。唯一需要收窄的场景见 WHOLE_ROW_TRANSFER_RE。
 */
const BANK_TRANSFER_RE = /转账|转帐/;
/** 同理：「基金申购 / 基金赎回 / 基金定投 / 基金认购」已被 申购/赎回/定投/认购 覆盖。 */
const BANK_INVESTMENT_RE = /申购|赎回|认购|定投/;
/**
 * 没有摘要列时 remark 会退回整行文本，整行里含着「微信转账」「支付宝转账」这类对手方名称，
 * 裸「转账」会把「快捷支付」误判成转账；这种兜底场景只认以「转账」开头的写法。
 */
const WHOLE_ROW_TRANSFER_RE = /^(?:转账|转帐)/;
const BANK_FEE_REMARK_RE = /手续费|服务费|工本费|年费|短信费|账户管理费|挂失费/;

/**
 * 「X转入 / X转出」是各家银行对本行内部划转最通用的写法（朝朝宝、朝朝盈、理财、通知存款、
 * 信用卡溢缴款…），所以按后缀模式识别，不枚举产品名——产品会下架、会改名，枚举必然漏。
 */
const SELF_TRANSFER_SUFFIX_RE = /^(.{2,12}?)\s*(转入|转出)$/;
/** 这些前缀是收入语义（工资/汇入/结息…）或纯现金动作，虽然也以「转入/转出」结尾，但不是内部划转。 */
const SELF_TRANSFER_NON_TRANSFER_PREFIX_RE = /^(工资|代发|代付|结息|利息|分红|收益|退款|退货|赔付|红包|补贴|报销|奖金|快捷支付|消费|付款|收款|充值|提现|缴费|还款|汇入|汇出|现金|存款|取款|存入|支取)/;
/** 「行内转账转入」这类系统摘要不携带产品名，不能当对向账户。 */
const SELF_TRANSFER_SYSTEM_PREFIX_RE = /^(行内|跨行|网银|手机银行|银行|转账|转帐|他行|本行|ATM|自动)/;

type BankRemarkFlowType = "transfer" | "investment" | null;

type SelfTransferRemark = {
  /** 摘要前缀，通常就是被划转的产品名 / 账户名。 */
  name: string;
  inflow: boolean;
};

function parseSelfTransferRemark(remark: string): SelfTransferRemark | null {
  const text = String(remark ?? "").trim();
  const match = text.match(SELF_TRANSFER_SUFFIX_RE);
  const name = (match?.[1] ?? "").trim();
  if (!name || SELF_TRANSFER_NON_TRANSFER_PREFIX_RE.test(name)) return null;
  return { name, inflow: match?.[2] === "转入" };
}

function inferBankRemarkFlowType(
  remark: string,
  options: { fromWholeRow?: boolean } = {},
): BankRemarkFlowType {
  const text = String(remark ?? "").trim();
  if (!text) return null;
  // 「转账手续费」「基金申购手续费」是费用支出，不是资金划转/申赎本身。
  if (BANK_FEE_REMARK_RE.test(text)) return null;
  if (parseSelfTransferRemark(text)) return "transfer";
  if ((options.fromWholeRow ? WHOLE_ROW_TRANSFER_RE : BANK_TRANSFER_RE).test(text)) return "transfer";
  if (BANK_INVESTMENT_RE.test(text)) return "investment";
  return null;
}

/** 摘要前缀就是本行内部划转的对向产品名（对向账户由用户在预览里确认/批量替换）。 */
function inferSelfTransferCounterAccount(remark: string) {
  const selfTransfer = parseSelfTransferRemark(remark);
  if (!selfTransfer || SELF_TRANSFER_SYSTEM_PREFIX_RE.test(selfTransfer.name)) return "";
  return selfTransfer.name;
}

/** 「转账-张三」「汇款 李四」：有些行把对方名直接写在摘要里，可当对向账户的默认值。 */
const TRANSFER_COUNTERPARTY_IN_REMARK_RE = /^(?:转账|转帐|汇款)[-—－·:：\s]+([^\s\-—－·:：]{2,16})$/;
const TRANSFER_NON_NAME_RE = /手续费|服务费|退款|撤销|失败|利息/;

function inferTransferCounterpartyFromRemark(remark: string) {
  const name = String(remark ?? "").trim().match(TRANSFER_COUNTERPARTY_IN_REMARK_RE)?.[1]?.trim() ?? "";
  if (!name || TRANSFER_NON_NAME_RE.test(name)) return "";
  return name;
}

/**
 * 银行流水的「对手信息」常是「名称 + 换行 + 账号」或「名称 卡号」。
 * 只保留名称首行并去掉末尾账号，避免卡号混进机构/对手方字段参与匹配。
 */
function cleanStatementCounterparty(value: string) {
  const firstLine = String(value ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return firstLine.replace(/[\s\u3000]*\d{6,}[\d\s]*$/, "").trim();
}


function normalizeDate(value: string) {
  const raw = value.trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const timeMatch = raw.match(/\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  const match = raw
    .replace(/[\u5e74\u6708]/g, "-")
    .replace(/[\u65e5\u53f7]/g, "")
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
  if (match) {
    const datePart = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return timeMatch ? `${datePart} ${timeMatch[1]}` : datePart;
  }
  // Lenient fallback (e.g. "26-02-2026" day-first); re-append time if present.
  const fallback = parseFlexibleDateToYmd(raw);
  return fallback ? (timeMatch ? `${fallback} ${timeMatch[1]}` : fallback) : raw.slice(0, 10);
}

function parseAmount(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parsePositiveAmountCell(row: string[], index: number) {
  if (index < 0) return 0;
  const raw = String(row[index] ?? "").trim();
  if (!raw) return 0;
  const parsed = parseAmount(raw);
  return parsed === null ? 0 : Math.abs(parsed);
}

function rowText(row: string[]) {
  return row.filter(Boolean).join(" ");
}

export function hasImportableStatementRows(items: StatementExcelPreviewItem[]) {
  return items.some((item) => item.date && Number(item.amount) > 0);
}

function cardAccountHint(institutionName: string | undefined, defaultAccountName: string, last4: string) {
  const cardTail = last4.trim();
  if (!cardTail) return defaultAccountName;
  const bankName = String(institutionName ?? "").trim();
  if (bankName) return `${bankName}信用卡(${cardTail})`;
  const defaultName = defaultAccountName.trim();
  if (!defaultName) return `信用卡(${cardTail})`;
  if (defaultName.includes(cardTail)) return defaultName;
  return `${defaultName}(${cardTail})`;
}

function isKnownCreditCardStatementRows(rows: string[][]) {
  for (const [index, row] of rows.entries()) {
    const indexes = matchStatementHeaderProfile(row, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
    if (!indexes) continue;
    let validRows = 0;
    for (const sampleRow of rows.slice(index + 1, index + 21)) {
      const date = normalizeDate(sampleRow[indexes.transactionDate] ?? "");
      const amount = parseAmount(sampleRow[indexes.amount] ?? "");
      const description = String(sampleRow[indexes.description] ?? "").trim();
      const cardLast4 = String(sampleRow[indexes.cardLast4] ?? "").trim();
      if (date && amount !== null && amount !== 0 && description && /^\d{4}$/.test(cardLast4)) validRows += 1;
      if (validRows >= SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.minValidSampleRows) return true;
    }
  }
  return false;
}

export function normalizeStatementExcelParsedItems(items: StatementExcelPreviewItem[]) {
  return alignStatementIncomeRefunds(items.map(enrichKnownStatementMerchantForImport));
}

function statementHeaderScore(row: string[], fieldHeaders: StatementFieldHeaders) {
  const reader = createStatementHeaderReader(row, fieldHeaders);
  let score = 0;
  if (reader.hasField("transactionDate")) score += 4;
  if (reader.hasField("amount")) score += 4;
  if (reader.hasField("sourceAccount")) score += 3;
  if (reader.hasField("majorType")) score += 2;
  if (reader.hasField("explicitType")) score += 2;
  if (reader.hasField("creditAccount")) score += 2;
  if (reader.hasField("repaymentAccount")) score += 1;
  if (reader.hasField("transferCounterAccount")) score += 1;
  if (reader.hasField("category")) score += 1;
  if (reader.hasField("institution")) score += 1;
  if (reader.hasField("remark")) score += 1;
  return score >= 8 ? score : 0;
}

function trimRowsToStatementHeader(rows: string[][], fieldHeaders: StatementFieldHeaders) {
  const compactRows = rows.filter((row) => row.some((cell) => cell.trim()));
  let bestIndex = 0;
  let bestScore = statementHeaderScore(compactRows[0] ?? [], fieldHeaders);
  compactRows.slice(0, 25).forEach((row, index) => {
    const score = statementHeaderScore(row, fieldHeaders);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore > 0 ? compactRows.slice(bestIndex) : compactRows;
}

function headerSignature(row: string[]) {
  return row.map(normalizeHeader).join("|");
}

function mergeStatementWorkbookRows(
  sheetRows: Array<{ sheetName: string; rows: string[][] }>,
  fieldHeaders: StatementFieldHeaders,
) {
  const trimmedSheets = sheetRows
    .map((sheet) => ({ ...sheet, rows: trimRowsToStatementHeader(sheet.rows, fieldHeaders) }))
    .filter((sheet) => sheet.rows.length > 0);
  if (trimmedSheets.length === 0) return [] as string[][];

  const groups = new Map<string, typeof trimmedSheets>();
  for (const sheet of trimmedSheets) {
    const signature = headerSignature(sheet.rows[0] ?? []);
    groups.set(signature, [...(groups.get(signature) ?? []), sheet]);
  }

  const selectedSheets = Array.from(groups.values()).sort((a, b) => {
    const aScore = statementHeaderScore(a[0]?.rows[0] ?? [], fieldHeaders);
    const bScore = statementHeaderScore(b[0]?.rows[0] ?? [], fieldHeaders);
    if (aScore !== bScore) return bScore - aScore;
    const aRows = a.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    const bRows = b.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    return bRows - aRows;
  })[0] ?? [];

  const [firstSheet, ...restSheets] = selectedSheets;
  const mergedRows = [...(firstSheet?.rows ?? [])];
  for (const sheet of restSheets) mergedRows.push(...sheet.rows.slice(1));
  return mergedRows;
}

export function parseStatementTemplateRows(
  rows: string[][],
  defaultAccountName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  /** 模板说明区标题行文案；传入后会截断标题行以下的所有说明行 */
  guideTitle = "",
): StatementExcelPreviewItem[] {
  const [headers = [], ...rawDataRows] = rows;
  // 模板自带的样板行和底部字段说明区都不是真实账单数据。
  const guideTitleRowIndex = findTemplateGuideTitleRowIndex(rawDataRows, guideTitle);
  const sampleColumnIndex = findTemplateSampleColumnIndex(headers);
  const dataRows = dropTemplateSampleRows(rowsBeforeTemplateGuide(rawDataRows, guideTitleRowIndex), sampleColumnIndex);
  const spdbIndexes = matchStatementHeaderProfile(headers, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
  const knownInstitutionName = spdbIndexes ? SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.institutionName : undefined;
  const reader = createStatementHeaderReader(headers, fieldHeaders);
  const dateIndex = spdbIndexes?.transactionDate ?? reader.findFieldIndex("transactionDate");
  const typeIndex = reader.findIndex([...fieldHeaders.explicitType, ...fieldHeaders.majorType]);
  const plainAccountIndex = reader.findFieldIndex("sourceAccount");
  const legacyCardIndex = spdbIndexes?.cardLast4 ?? reader.findFieldIndex("creditAccount");
  const accountIndex = plainAccountIndex >= 0 ? plainAccountIndex : legacyCardIndex;
  const legacyCardAccountMode = plainAccountIndex < 0 && legacyCardIndex >= 0;
  const counterIndex = reader.findIndex([...fieldHeaders.transferCounterAccount, ...fieldHeaders.repaymentAccount]);
  const outflowIndex = reader.findFieldIndex("outflow");
  const inflowIndex = reader.findFieldIndex("inflow");
  const amountIndex = spdbIndexes?.amount ?? reader.findFieldIndex("amount");
  const categoryIndex = reader.findFieldIndex("category");
  const merchantIndex = reader.findFieldIndex("institution");
  const tagsIndex = reader.findFieldIndex("tags");
  const remarkIndex = spdbIndexes?.description ?? reader.findFieldIndex("remark");
  const postedIndex = spdbIndexes?.postingDate ?? reader.findFieldIndex("postedAt");
  const currencyIndex = spdbIndexes?.currency ?? -1;
  const originalAmountIndex = spdbIndexes?.originalAmount ?? -1;
  const balanceIndex = reader.findIndex(STATEMENT_BALANCE_HEADER_ALIASES);

  if (dateIndex < 0 || (amountIndex < 0 && inflowIndex < 0 && outflowIndex < 0)) return [];

  const keywordInflowSign = inferSignedAmountInflowSign(dataRows.flatMap((row) => {
    const rawInflowText = inflowIndex >= 0 ? String(row[inflowIndex] ?? "").trim() : "";
    const rawOutflowText = outflowIndex >= 0 ? String(row[outflowIndex] ?? "").trim() : "";
    const hasExplicitFlow =
      parsePositiveAmountCell(row, inflowIndex) > 0 ||
      parsePositiveAmountCell(row, outflowIndex) > 0 ||
      !!rawInflowText ||
      !!rawOutflowText;
    if (hasExplicitFlow) return [];
    const typeText = String(row[typeIndex] ?? "").trim();
    const category = String(row[categoryIndex] ?? "").trim();
    const institution = String(row[merchantIndex] ?? "").trim();
    const remark = String(row[remarkIndex] ?? "").trim();
    return [{
      amount: amountIndex >= 0 ? parseAmount(row[amountIndex] ?? "") : null,
      text: `${typeText} ${category} ${institution} ${remark} ${rowText(row)}`,
    }];
  }));
  // 余额差额是流水事实，优先于关键词推断：借记卡「正数=收入」不会再被套用信用卡口径而整体反向。
  const signedAmountInflowSign = balanceIndex >= 0
    ? inferBalanceBasedInflowSign(dataRows.map((row) => ({
      amount: amountIndex >= 0 ? parseAmount(row[amountIndex] ?? "") : null,
      balance: parseAmount(row[balanceIndex] ?? ""),
    }))) ?? keywordInflowSign
    : keywordInflowSign;

  return dataRows.flatMap<StatementExcelPreviewItem>((row) => {
    const date = normalizeDate(row[dateIndex] ?? "");
    if (!date) return [];

    const typeText = String(row[typeIndex] ?? "").trim().toLowerCase();
    const rawOutflow = parsePositiveAmountCell(row, outflowIndex);
    const rawInflow = parsePositiveAmountCell(row, inflowIndex);
    const rawOutflowText = outflowIndex >= 0 ? String(row[outflowIndex] ?? "").trim() : "";
    const rawInflowText = inflowIndex >= 0 ? String(row[inflowIndex] ?? "").trim() : "";
    const hasExplicitFlow = rawInflow > 0 || rawOutflow > 0 || !!rawInflowText || !!rawOutflowText;
    const amountSigned = amountIndex >= 0 ? parseAmount(row[amountIndex] ?? "") : null;
    const amount = amountSigned === null
      ? rawInflow || rawOutflow
      : Math.abs(amountSigned) || rawInflow || rawOutflow;
    if (amount === 0) return [];
    const explicitDirection: "in" | "out" | null =
      rawInflow > 0 && rawOutflow <= 0 ? "in"
      : rawOutflow > 0 && rawInflow <= 0 ? "out"
      : null;
    const signedDirection = hasExplicitFlow ? explicitDirection : signedAmountDirection(amountSigned, signedAmountInflowSign);
    const rawAccountValue = accountIndex >= 0 ? String(row[accountIndex] ?? "").trim() : defaultAccountName;
    const contextAccount = accountIndex < 0 ? defaultAccountName : "";
    const cardLast4 = legacyCardAccountMode ? rawAccountValue.match(/\d{4}(?!\d)/)?.[0] ?? "" : "";
    const accountValue = legacyCardAccountMode
      ? cardAccountHint(knownInstitutionName, defaultAccountName, cardLast4)
      : rawAccountValue;
    const category = String(row[categoryIndex] ?? "").trim();
    const institution = cleanStatementCounterparty(String(row[merchantIndex] ?? "").trim());
    const tags = tagsIndex >= 0 ? String(row[tagsIndex] ?? "").trim() : "";
    const remark = String(row[remarkIndex] ?? "").trim() || tags || rowText(row);
    // 无类型列、无流入/流出列的银行流水（招行借记卡即如此）按摘要判断资金性质：
    // 「X转入/X转出」「转账汇款」是本行内部划转，「基金申购/赎回」是投资申赎。
    // 摘要与对手信息分开判定：摘要可能是整行兜底（此时不能裸认「转账」），
    // 对手信息则一律走严格模式——「微信转账」是商户名，不是转账动作。
    const remarkFromColumn = remarkIndex >= 0 && Boolean(String(row[remarkIndex] ?? "").trim() || tags);
    const remarkFlowType = !typeText && !hasExplicitFlow && !category
      ? inferBankRemarkFlowType(remark, { fromWholeRow: !remarkFromColumn })
        || inferBankRemarkFlowType(institution, { fromWholeRow: true })
      : null;
    const postedDate = postedIndex >= 0 ? normalizeDate(row[postedIndex] ?? "") : undefined;
    const sourceText = `${typeText} ${category} ${institution} ${remark} ${rowText(row)}`;
    const isRepayment = /转账|transfer|振替/.test(typeText)
      || isCreditCardRepaymentLikeText(sourceText)
      || remarkFlowType === "transfer";
    const isRefund = isExpenseRefundLikeText(sourceText);
    const isSignedInflow = signedDirection === "in";
    const isIncome = !isRefund && (/income|收入|収入/.test(typeText) || isSignedInflow);
    const rawCounterAccount = counterIndex >= 0
      ? cleanStatementCounterparty(String(row[counterIndex] ?? "").trim())
      : "";
    // 对向账户兜底：本行划转取摘要里的产品名（朝朝宝），对外转账取「对手信息」列的名称。
    // 只给转账行兜底，普通收支不受影响；匹配不到时由用户在预览里批量补齐。
    const counterAccount = rawCounterAccount
      || (isRepayment
        ? inferSelfTransferCounterAccount(remark)
          || inferTransferCounterpartyFromRemark(remark)
          || institution
        : "");

    if (isRepayment) {
      const accountIsCurrent = normalizeHeader(accountValue) === normalizeHeader(defaultAccountName);
      const counterIsCurrent = normalizeHeader(counterAccount) === normalizeHeader(defaultAccountName);
      const accountSideIsPrimary = legacyCardAccountMode || accountIsCurrent || !counterIsCurrent;
      // 方向以「收支列/金额正负号」为准：借记卡里的「信用卡还款」是转出，
      // 不能因为摘要含「还款」就一律当成入账（那会把转出金额记成转入）。
      const transferIsInflow = explicitDirection
        ? explicitDirection === "in"
        : signedDirection
          ? signedDirection === "in"
          : isCreditCardRepaymentLikeText(sourceText);
      const fromAccount = transferIsInflow
        ? accountSideIsPrimary ? counterAccount : accountValue
        : accountSideIsPrimary ? (accountValue || contextAccount) : (counterAccount || contextAccount);
      const toAccount = transferIsInflow
        ? accountSideIsPrimary ? (accountValue || contextAccount) : (counterAccount || contextAccount)
        : accountSideIsPrimary ? counterAccount : accountValue;
      return [{
        rawText: rowText(row),
        type: "transfer" as const,
        date,
        amount,
        inflow: transferIsInflow ? amount : undefined,
        outflow: transferIsInflow ? undefined : amount,
        account: transferIsInflow ? toAccount : fromAccount,
        fromAccount,
        toAccount,
        transferDirection: transferIsInflow ? "in" as const : "out" as const,
        category,
        institution,
        counterparty: institution || undefined,
        remark,
        postedDate,
        _meta: cardLast4 || knownInstitutionName ? {
          institutionName: knownInstitutionName,
          cardNumberMasked: cardLast4 || undefined,
        } : undefined,
      }];
    }

    const account = accountValue || contextAccount;
    // 投资申赎在流水里只有「钱出去/钱回来」，标的（基金/产品）不在本表：先落成投资类型的
    // 半截记录，账户仍是扣款账户，fundCode/fundName 留空由用户后续补充。
    const resolvedType = remarkFlowType === "investment"
      ? "investment" as const
      : explicitDirection === "out" ? "expense" : isIncome ? "income" : "expense";
    const accountSideInflow = explicitDirection
      ? explicitDirection === "in"
      : isIncome || isRefund;
    // SPDB settlement facts: 交易币种 + 原始交易金额&币种 keep the foreign
    // provenance when the posted amount differs from the original spend.
    const settlementCurrency = currencyIndex >= 0 ? normalizeSpdbCurrencyCode(row[currencyIndex] ?? "") : "";
    const settlementAmount = originalAmountIndex >= 0 ? parseSpdbOriginalAmount(row[originalAmountIndex] ?? "") : null;
    const settlementDiffers = settlementCurrency !== "" && settlementCurrency !== "CNY"
      && settlementAmount != null && Math.abs(settlementAmount - amount) > 0.005;
    return [{
      rawText: rowText(row),
      type: resolvedType,
      date,
      amount,
      inflow: accountSideInflow ? amount : undefined,
      outflow: accountSideInflow ? undefined : amount,
      account,
      category,
      institution,
      counterparty: institution || undefined,
      remark,
      postedDate,
      originalCurrency: settlementDiffers ? settlementCurrency : undefined,
      originalAmount: settlementDiffers ? settlementAmount ?? undefined : undefined,
      _meta: cardLast4 || knownInstitutionName ? {
        institutionName: knownInstitutionName,
        cardNumberMasked: cardLast4 || undefined,
      } : undefined,
    }];
  });
}

type ReadStatementWorkbookResult = {
  rows: string[][];
  text: string;
  /** 检测为财智8格式时为标准化后的行（含 MMH 标准表头，可直接交 parseStatementTemplateRows）；否则 undefined */
  caizhiRows?: string[][];
  /** 财智余额调整行（余额校准用：指定日期把账户余额校正为目标值） */
  caizhiBalanceAdjustRows?: CaizhiBalanceAdjustRow[];
};

export { guessCaizhiAccountNameFromFilename } from "@/lib/statement/caizhi-template";

/**
 * 已经读出来（甚至已经被过滤过）的原始工作表行 → 账单标准行。
 * 与 `readStatementWorkbookRowsAndText` 共用同一套模板识别，只是不碰文件。
 */
export function normalizeStatementSheetsRows(
  readonlySheetRows: readonly { sheetName: string; rows: string[][] }[],
  sourceFileName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): ReadStatementWorkbookResult {
  const sheetRows = readonlySheetRows.map((sheet) => ({ sheetName: sheet.sheetName, rows: sheet.rows }));
  const jdRows = normalizeJdWorkbookRows(sheetRows);
  // 「张四.支付宝交易明细(...).csv」这类文件名前缀代表账本里的实际所有人，
  // 优先于账单内部写的导出者姓名。
  const alipayRows = normalizeAlipayWorkbookRows(sheetRows, guessOwnerFromFilename(sourceFileName));
  const wechatRows = normalizeWechatWorkbookRows(sheetRows);

  // 优先检测财智8格式（需要从文件名猜账户名）
  const accountNameFromFile = guessCaizhiAccountNameFromFilename(sourceFileName);
  const caizhiRows = normalizeCaizhiWorkbookRows(sheetRows as CaizhiWorkbookSheetRows[], accountNameFromFile);

  const rows = caizhiRows?.rows
    ?? jdRows?.rows
    ?? alipayRows?.rows
    ?? wechatRows?.rows
    ?? mergeStatementWorkbookRows(sheetRows, fieldHeaders);

  const text = sheetRows
    .flatMap((sheet) => sheet.rows.filter((row) => row.some(Boolean)))
    .map((row) => row.join("\t"))
    .join("\n");

  return {
    rows,
    text,
    caizhiRows: caizhiRows?.rows,
    caizhiBalanceAdjustRows: caizhiRows?.balanceAdjustRows?.filter((row) => row.targetBalance != null),
  };
}

export async function readStatementWorkbookRowsAndText(
  file: File,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): Promise<ReadStatementWorkbookResult> {
  return normalizeStatementSheetsRows(await readStatementSheetRows(file), file.name, fieldHeaders);
}

export async function parseStatementExcelFile(
  file: File,
  defaultAccountName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  guideTitle = "",
  /** 已经读过（可能还剔过基金买卖行）的工作表行；不传则自己读文件。 */
  sheetRows?: readonly { sheetName: string; rows: string[][] }[],
) {
  const { rows, text } = sheetRows
    ? normalizeStatementSheetsRows(sheetRows, file.name, fieldHeaders)
    : await readStatementWorkbookRowsAndText(file, fieldHeaders);
  const localItems = normalizeStatementExcelParsedItems(
    parseStatementTemplateRows(rows, defaultAccountName, fieldHeaders, guideTitle),
  );
  return {
    rows,
    text,
    localItems,
    preferServerRecognition: isKnownCreditCardStatementRows(rows),
  };
}
