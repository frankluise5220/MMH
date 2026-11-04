// 导入管线第 1~2 步的共享组装（2026-11-04 P2）：
//   第 1 步 专用识别器（这是谁家的账单格式）：财智8 → 京东 → 支付宝 → 微信，命中即短路
//   第 2 步 兜底识别器：MMH 标准模板（表头打分截表头 + 多 sheet 合并）
//   第 3 步 表归属：caizhi 的余额校准行随识别结果带出；支付宝基金买卖抽取仍由
//           alipay-fund-bill.ts（routeAlipayFundBill）承担，调用方在预览路由时使用。
//
// 本模块是「组装」不是「重写」：各段实现均原样来自既有代码——
//   - 识别器：alipay-template / jd-template / wechat-template / caizhi-template 的
//     normalize*WorkbookRows 原样引用（此前批量导入页与 excel-preview 各挂了一份清单，
//     顺序还不一致；现收敛为这一份，财智最先——其表头特征最特异，与明细页现状一致）。
//   - 表头打分 billHeaderScore：batch-import/page.tsx 与 excel-preview.ts 各有一份逐行
//     相同的拷贝，取一份。
//   - 基金表头识别（FundImportHeaderField / FUND_FIELD_ALIASES / buildFundHeaderIndex /
//     fundHeaderScore / FUND_LABEL_HEADER_SET / looksLikeFundLabelRow）：原样从
//     batch-import/page.tsx 移入（FundImportPreviewDialog 内还有一份近似拷贝，待后续收敛）。
//   - 截表头 trimRowsToStatementHeader / 多 sheet 合并 mergeStandardWorkbookRows：以
//     batch-import/page.tsx 的超集版本为基准（含二级表头跳过），fundAware 选项还原两个
//     入口的差异——批量导入页靠截表头顺带认基金文件（fundAware: true），明细页在更早的
//     detectImportFileKind 已判过表，截表头只认流水表头（fundAware: false）。
//   - 表头签名归一化统一用 normalizeStatementHeader（此前 page 用
//     normalizeImportAccountMatchKey、excel-preview 用 normalizeStatementHeader，仅影响
//     多 sheet 表头分组的极端边角，取共享库语义更纯的一份）。
// 调用方（batch-import/page.tsx、excel-preview.ts）只做「读文件 → 交本模块 → 按表挂预览」。

import {
  STATEMENT_IMPORT_FIELD_HEADERS,
  createStatementHeaderReader,
  type StatementImportField,
} from "@/lib/statement/header-catalog";
import { normalizeAlipayWorkbookRows } from "@/lib/statement/alipay-template";
import {
  guessCaizhiAccountNameFromFilename,
  normalizeCaizhiWorkbookRows,
  type CaizhiBalanceAdjustRow,
  type CaizhiWorkbookSheetRows,
} from "@/lib/statement/caizhi-template";
import { normalizeJdWorkbookRows } from "@/lib/statement/jd-template";
import { normalizeWechatWorkbookRows } from "@/lib/statement/wechat-template";
import { guessOwnerFromFilename } from "@/lib/statement/owner-from-filename";
import { normalizeStatementHeader } from "@/lib/statement/header-utils";

export type StatementFieldHeaders = Record<StatementImportField, readonly string[]>;

/** 识别器命中的账单格式；standard = 兜底（MMH 标准模板）。 */
export type StatementFileTemplate = "caizhi" | "jd" | "alipay" | "wechat" | "standard";

export type RecognizedStatementSheets = {
  template: StatementFileTemplate;
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  /** 仅 caizhi：财智8 归一化出的全部标准行（= rows）。 */
  caizhiRows?: string[][];
  /** 仅 caizhi：余额校准行（余额调整/初始化等，不作为流水导入）。 */
  caizhiBalanceAdjustRows?: CaizhiBalanceAdjustRow[];
};

// —— 基金表头识别（原 batch-import/page.tsx，原样移入）——

// 基金 CSV 的表头字段：只用于表头识别（buildFundHeaderIndex / fundHeaderScore）。
export type FundImportHeaderField =
  | "date"
  | "fundSubtype"
  | "cashAccount"
  | "fundAccount"
  | "fundCode"
  | "amount"
  | "feeRateInput"
  | "fee"
  | "nav"
  | "units"
  | "confirmDate"
  | "arrivalDate"
  | "remark";

const FUND_LABEL_HEADER_SET = new Set([
  "日期",
  "基金动作",
  "资金账户",
  "基金账户",
  "基金代码",
  "金额",
  "手续费率",
  "手续费",
  "净值",
  "份额",
  "净值日期",
  "入账日期",
  "备注",
]);

const FUND_FIELD_ALIASES: Record<FundImportHeaderField, string[]> = {
  date: ["date", "日期", "交易日期", "申请日期", "Date", "日付"],
  fundSubtype: ["fundSubtype", "分类", "业务类型", "基金动作", "基金类型", "动作", "Fund Action", "Action", "基金アクション", "ファンド操作", "cash dividend", "dividend reinvest", "現金分配", "分配金再投資"],
  cashAccount: ["cashAccount", "资金账户", "现金账户", "付款账户", "cash account", "Cash Account", "資金口座"],
  fundAccount: ["fundAccount", "基金账户", "投资账户", "account", "fund account", "Fund Account", "ファンド口座"],
  fundCode: ["fundCode", "基金代码", "代码", "fund code", "Fund Code", "ファンドコード", "基金コード"],
  amount: ["amount", "金额", "发生金额", "Amount", "金額"],
  feeRateInput: ["feeRateInput", "feeRate", "手续费率", "费率", "Fee Rate", "Fee Rate (%)", "手数料率"],
  fee: ["fee", "手续费", "Fee", "手数料"],
  nav: ["nav", "净值", "成交净值", "NAV", "基準価額"],
  units: ["units", "份额", "确认份额", "Units", "口数"],
  confirmDate: ["confirmDate", "确认日期", "净值日期", "NAV Date", "基準価額日"],
  arrivalDate: ["arrivalDate", "入账日期", "到账日期", "Posting Date", "入帳日"],
  remark: ["remark", "备注", "说明", "Remark", "Note", "備考", "メモ"],
};

function normalizeFundHeaderText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function buildFundHeaderIndex(headers: string[]) {
  const normalizedHeaders = headers.map(normalizeFundHeaderText);
  const map = new Map<FundImportHeaderField, number>();
  (Object.entries(FUND_FIELD_ALIASES) as Array<[FundImportHeaderField, string[]]>).forEach(([field, aliases]) => {
    const index = normalizedHeaders.findIndex((header) => aliases.some((alias) => normalizeFundHeaderText(alias) === header));
    if (index >= 0) map.set(field, index);
  });
  return map;
}

export function fundHeaderScore(row: string[]) {
  const index = buildFundHeaderIndex(row);
  let score = 0;
  if (index.has("date")) score += 4;
  if (index.has("fundAccount")) score += 4;
  if (index.has("fundCode")) score += 4;
  if (index.has("amount")) score += 4;
  if (index.has("fundSubtype")) score += 2;
  if (index.has("cashAccount")) score += 1;
  return score >= 11 ? score : 0;
}

/** True when the parsed workbook rows carry fund-specific columns (fund code/account/amount). */
export function looksLikeFundImportFile(rows: string[][]) {
  return fundHeaderScore(rows[0] ?? []) >= 11;
}

function looksLikeFundLabelRow(headers: string[]) {
  return headers.some((header) => FUND_LABEL_HEADER_SET.has(header.trim()));
}

// —— 兜底识别器：MMH 标准模板（原 page.tsx / excel-preview.ts 各一份，取一份）——

export function billHeaderScore(row: string[], fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS) {
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

/**
 * 截表头用的综合打分。fundAware=true 时基金表头也参与（批量导入页靠它顺带认出
 * 基金文件）；明细页在 detectImportFileKind 已判过表，截表头只认流水表头。
 */
export function importHeaderScore(
  row: string[],
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  fundAware = false,
) {
  return Math.max(billHeaderScore(row, fieldHeaders), fundAware ? fundHeaderScore(row) : 0);
}

export function trimRowsToStatementHeader(
  rows: string[][],
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  opts?: { fundAware?: boolean },
) {
  const fundAware = opts?.fundAware ?? false;
  const compactRows = rows.filter((row) => row.some((cell) => cell.trim()));
  let bestIndex = 0;
  let bestScore = importHeaderScore(compactRows[0] ?? [], fieldHeaders, fundAware);
  compactRows.slice(0, 25).forEach((row, index) => {
    const score = importHeaderScore(row, fieldHeaders, fundAware);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore > 0 ? compactRows.slice(bestIndex) : compactRows;
}

function headerSignature(row: string[]) {
  return row.map(normalizeStatementHeader).join("|");
}

export function mergeStandardWorkbookRows(
  sheetRows: Array<{ sheetName: string; rows: string[][] }>,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  opts?: { fundAware?: boolean },
): { rows: string[][]; sourceDataRowCount: number; includedSheetCount: number } {
  const fundAware = opts?.fundAware ?? false;
  const trimmedSheets = sheetRows
    .map((sheet) => ({ ...sheet, rows: trimRowsToStatementHeader(sheet.rows, fieldHeaders, { fundAware }) }))
    .filter((sheet) => sheet.rows.length > 0);
  if (trimmedSheets.length === 0) return { rows: [], sourceDataRowCount: 0, includedSheetCount: 0 };

  const groups = new Map<string, typeof trimmedSheets>();
  for (const sheet of trimmedSheets) {
    const signature = headerSignature(sheet.rows[0] ?? []);
    groups.set(signature, [...(groups.get(signature) ?? []), sheet]);
  }

  // 按表头签名分组后，选中「打分最高、行数最多」的那一组（原 page.tsx 的 [0] 语义）。
  const selectedSheets = Array.from(groups.values()).sort((a, b) => {
    const aScore = importHeaderScore(a[0]?.rows[0] ?? [], fieldHeaders, fundAware);
    const bScore = importHeaderScore(b[0]?.rows[0] ?? [], fieldHeaders, fundAware);
    if (aScore !== bScore) return bScore - aScore;
    const aRows = a.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    const bRows = b.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    return bRows - aRows;
  })[0] ?? [];

  // 二级表头跳过（原 page.tsx）：主 sheet 第二行是基金标签表头、且其他 sheet 也有
  // 相同的第二行时，按两行表头跳过，避免表头被并进数据。
  const primaryRows = selectedSheets[0]?.rows ?? [];
  const primarySecondSignature = headerSignature(primaryRows[1] ?? []);
  const primaryHasSecondHeader = looksLikeFundLabelRow(primaryRows[1] ?? []);
  const headerRowCount = (sheet: { rows: string[][] }) =>
    primaryHasSecondHeader && headerSignature(sheet.rows[1] ?? []) === primarySecondSignature ? 2 : 1;

  const mergedRows = [...primaryRows];
  for (const sheet of selectedSheets.slice(1)) mergedRows.push(...sheet.rows.slice(headerRowCount(sheet)));

  return {
    rows: mergedRows,
    sourceDataRowCount: selectedSheets.reduce(
      (sum, sheet) => sum + Math.max(0, sheet.rows.length - headerRowCount(sheet)),
      0,
    ),
    includedSheetCount: selectedSheets.length,
  };
}

// —— 第 1 步：专用识别器清单（命中即短路）——

export function recognizeStatementSheets(
  rawSheetRows: Array<{ sheetName: string; rows: string[][] }>,
  sourceFileName = "",
): RecognizedStatementSheets | null {
  // 优先检测财智8格式（表头特征最特异；需要从文件名猜账户名）。
  const caizhiRows = normalizeCaizhiWorkbookRows(
    rawSheetRows as CaizhiWorkbookSheetRows[],
    guessCaizhiAccountNameFromFilename(sourceFileName),
  );
  if (caizhiRows) {
    return {
      template: "caizhi",
      rows: caizhiRows.rows,
      sourceDataRowCount: caizhiRows.sourceDataRowCount,
      includedSheetCount: caizhiRows.includedSheetCount,
      caizhiRows: caizhiRows.rows,
      caizhiBalanceAdjustRows: caizhiRows.balanceAdjustRows?.filter((row) => row.targetBalance != null),
    };
  }

  const jdRows = normalizeJdWorkbookRows(rawSheetRows);
  if (jdRows) {
    return {
      template: "jd",
      rows: jdRows.rows,
      sourceDataRowCount: jdRows.sourceDataRowCount,
      includedSheetCount: jdRows.includedSheetCount,
    };
  }

  // 「张四.支付宝交易明细(...).csv」的文件名前缀是账本里的实际所有人，优先于账单内部姓名。
  const alipayRows = normalizeAlipayWorkbookRows(rawSheetRows, guessOwnerFromFilename(sourceFileName));
  if (alipayRows) {
    return {
      template: "alipay",
      rows: alipayRows.rows,
      sourceDataRowCount: alipayRows.sourceDataRowCount,
      includedSheetCount: alipayRows.includedSheetCount,
    };
  }

  const wechatRows = normalizeWechatWorkbookRows(rawSheetRows);
  if (wechatRows) {
    return {
      template: "wechat",
      rows: wechatRows.rows,
      sourceDataRowCount: wechatRows.sourceDataRowCount,
      includedSheetCount: wechatRows.includedSheetCount,
    };
  }

  return null;
}

// —— 第 1~2 步合并入口：专用识别器（短路）→ 兜底 ——

export function parseStatementSheetsStandard(
  rawSheetRows: Array<{ sheetName: string; rows: string[][] }>,
  options: {
    sheetCount?: number;
    sourceFileName?: string;
    fieldHeaders?: StatementFieldHeaders;
    /** 截表头时是否让基金表头参与（批量导入页 true；明细页 false）。 */
    fundAware?: boolean;
  } = {},
): RecognizedStatementSheets {
  const { sheetCount = rawSheetRows.length, sourceFileName = "", fieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS, fundAware = false } = options;
  const recognized = recognizeStatementSheets(rawSheetRows, sourceFileName);
  if (recognized) return recognized;
  const merged = mergeStandardWorkbookRows(rawSheetRows, fieldHeaders, { fundAware });
  return { template: "standard", ...merged };
}
