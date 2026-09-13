/**
 * Caizhi 8 statement detail files (.xls/.xlsx) -> MMH standard import rows.
 *
 * Conversion rules:
 * 1. Activity types containing "|" are transfer rows. The right-hand side is
 *    the counter account, and category stays blank.
 * 2. Activity types without "|" become income or expense based on direction,
 *    with the original activity text kept as category data.
 * 3. Balance-adjustment rows are excluded because MMH balance reconciliation
 *    should handle opening balances without polluting income statistics.
 *
 * Input: SheetJS-parsed rows.
 * Output: MMH standard statement rows without the header.
 */
export type CaizhiWorkbookSheetRows = {
  sheetName: string;
  rows: string[][];
};

export type NormalizedCaizhiWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "caizhi";
  /** Balance-adjustment rows removed from import, used for user-facing summary. */
  balanceAdjustRows: string[][];
};

// MMH standard headers, kept aligned with generic/Alipay/WeChat templates.
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

const CAIZHI_HEADER_ALIASES: Record<string, CaizhiColumnKey | "skip"> = {
  // Canonical columns.
  "\u65e5\u671f": "date",
  "\u4ea4\u6613\u65e5\u671f": "date",
  "\u6d41\u5165": "inflow",
  "\u652f\u51fa": "outflow",
  "\u6d3b\u52a8\u7c7b\u578b": "activityType",
  "\u5907\u6ce8": "remark",
  // Supported aliases.
  "\u5165\u8d26\u65e5\u671f": "skip",
  "\u6536\u652f\u5927\u7c7b": "skip",
  "\u6d41\u51fa": "outflow",
  "\u6d41\u5165\u91d1\u989d": "inflow",
  "\u6d41\u51fa\u91d1\u989d": "outflow",
  "\u7c7b\u578b": "activityType",
  "\u4ea4\u6613\u7c7b\u578b": "activityType",
};

type CaizhiColumnIndex = {
  date: number;
  inflow: number;
  outflow: number;
  activityType: number;
  remark: number;
};

type CaizhiColumnKey = keyof CaizhiColumnIndex;

const CAIZHI_COLUMN_INDEX: CaizhiColumnIndex = {
  date: -1,
  inflow: -1,
  outflow: -1,
  activityType: -1,
  remark: -1,
};

const BALANCE_ADJUST_KEYWORDS = [
  "\u4f59\u989d\u8c03\u6574",
  "\u4f59\u989d\u521d\u59cb\u5316",
  "\u671f\u521d\u4f59\u989d",
  "\u7ed3\u606f",
];

const TRANSFER_PREFIXES = new Set([
  "\u8f6c\u5165",
  "\u8f6c\u51fa",
  "\u501f\u51fa",
  "\u501f\u5165",
  "\u6536\u56de",
  "\u8fd4\u8fd8",
  "\u5f00\u653e\u5f0f\u57fa\u91d1\u8d4e\u56de",
  "\u5f00\u653e\u5f0f\u57fa\u91d1\u7533\u8d2d",
  "\u57fa\u91d1\u8d4e\u56de",
  "\u57fa\u91d1\u7533\u8d2d",
]);

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

function isBalanceAdjust(activityType: string): boolean {
  const act = activityType.trim();
  return BALANCE_ADJUST_KEYWORDS.some((kw) => act.includes(kw));
}

function normalizeDate(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  // Accept several common date shapes, including CJK date suffixes.
  const slashMatch = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[3].padStart(2, "0")}`;
  }
  const hyphenMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (hyphenMatch) {
    return `${hyphenMatch[1]}-${hyphenMatch[2].padStart(2, "0")}-${hyphenMatch[3].padStart(2, "0")}`;
  }
  const cnMatch = raw.match(/^(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})/);
  if (cnMatch) {
    return `${cnMatch[1]}-${cnMatch[2].padStart(2, "0")}-${cnMatch[3].padStart(2, "0")}`;
  }
  return raw.slice(0, 10);
}

function buildCaizhiHeaderIndex(headerRow: string[]): CaizhiColumnIndex | null {
  // 已带「对向账户」列的是结构化表格（MMH 化/工具转换产物），不是财智原始导出——
  // 交给通用模板链路解析才能保住转账对向账户；财智原始导出绝无此列。
  if (headerRow.some((h) => normalizeHeader(h) === "\u5bf9\u5411\u8d26\u6237")) return null;
  const result = { date: -1, inflow: -1, outflow: -1, activityType: -1, remark: -1 };
  let foundCount = 0;

  for (let i = 0; i < headerRow.length; i++) {
    const normalized = normalizeHeader(headerRow[i]);
    if (!normalized || normalized === "skip") continue;

    const alias = CAIZHI_HEADER_ALIASES[normalized];
    if (!alias || alias === "skip") continue;

    if (alias in result) {
      (result as Record<string, number>)[alias] = i;
      foundCount++;
    }
  }

  // Require date, activity type, and at least one money direction.
  if (result.date < 0 || result.activityType < 0) return null;
  if (result.inflow < 0 && result.outflow < 0) return null;
  return result;
}

function normalizeCaizhiRow(
  row: string[],
  colIdx: CaizhiColumnIndex,
  accountName: string,
): string[] | null {
  const date = normalizeDate(row[colIdx.date]);
  if (!date) return null;

  const activityType = cleanText(row[colIdx.activityType]);
  if (!activityType) return null;

  // Skip opening-balance and balance-adjustment rows.
  if (isBalanceAdjust(activityType)) return null;

  const remark = cleanText(row[colIdx.remark]);
  const inflowRaw = colIdx.inflow >= 0 ? parseAmount(row[colIdx.inflow]) : null;
  const outflowRaw = colIdx.outflow >= 0 ? parseAmount(row[colIdx.outflow]) : null;

  // At least one direction must carry a positive amount.
  const hasInflow = inflowRaw !== null && inflowRaw > 0;
  const hasOutflow = outflowRaw !== null && outflowRaw > 0;
  if (!hasInflow && !hasOutflow) return null;

  if (activityType.includes("|")) {
    // Transfer: right side of "|" is the counter account.
    // 网贷收回→贷款账户、信用卡还款→信用卡账户：活动类型前缀写入分类列，供导入按类型建账户。
    const [typePrefixRaw] = activityType.split("|");
    const typePrefix = typePrefixRaw?.trim() ?? "";
    const [, counterAccountRaw] = activityType.split("|");
    const counterAccount = counterAccountRaw?.trim() ?? "";
    const outflow = hasOutflow ? String(outflowRaw) : "";
    const inflow = hasInflow ? String(inflowRaw) : "";
    const category =
      typePrefix === "\u7f51\u8d37\u6536\u56de" || typePrefix === "\u4fe1\u7528\u5361\u8fd8\u6b3e" ? typePrefix : "";
    return [date, "", "\u8f6c\u8d26", outflow, inflow, accountName, counterAccount, category, "", "", remark];
  }

  if (hasInflow) {
    // Income.
    return [date, "", "\u6536\u5165", "", String(inflowRaw), accountName, "", activityType, "", "", remark];
  }

  // Expense.
  return [date, "", "\u652f\u51fa", String(outflowRaw), "", accountName, "", activityType, "", "", remark];
}

/**
 * Detect and extract Caizhi 8 data from SheetJS workbook rows.
 * Returns { rows, sourceDataRowCount, includedSheetCount, profile, balanceAdjustRows }.
 */
export function normalizeCaizhiWorkbookRows(
  sheets: CaizhiWorkbookSheetRows[],
  accountName: string,
): NormalizedCaizhiWorkbookRows | undefined {
  const resultRows: string[][] = [];
  const balanceAdjustRows: string[][] = [];
  let includedSheetCount = 0;
  let totalDataRows = 0;

  for (const sheet of sheets) {
    const dataRows = sheet.rows;
    if (dataRows.length === 0) continue;

    const headerIdx = buildCaizhiHeaderIndex(dataRows[0]);
    if (!headerIdx) continue;

    includedSheetCount++;
    const dataStart = 1; // Skip the header row.

    for (let r = dataStart; r < dataRows.length; r++) {
      const row = dataRows[r];
      // Skip fully empty rows.
      if (!row.some((cell) => cleanText(cell))) continue;

      totalDataRows++;

      const activityType = cleanText(row[headerIdx.activityType]);
      if (!activityType) continue;

      if (isBalanceAdjust(activityType)) {
        balanceAdjustRows.push([
          normalizeDate(row[headerIdx.date]),
          activityType,
          cleanText(row[headerIdx.inflow] ?? row[headerIdx.outflow] ?? ""),
          cleanText(row[headerIdx.remark]),
        ]);
        continue;
      }

      const normalized = normalizeCaizhiRow(row, headerIdx, accountName);
      if (normalized) resultRows.push(normalized);
    }
  }

  if (includedSheetCount === 0) return undefined;

  return {
    // 与京东/支付宝/微信模板保持一致：标准表头 + 数据行。
    // 少了表头这一行，下游 parseStatementTemplateRows 会把首行数据当成表头，解析结果为 0 条。
    rows: [NORMALIZED_HEADERS, ...resultRows],
    sourceDataRowCount: totalDataRows,
    includedSheetCount,
    profile: "caizhi",
    balanceAdjustRows,
  };
}

/**
 * Detect whether the given header row matches Caizhi 8 export columns.
 */
export function detectCaizhiHeaders(headerRow: string[]): boolean {
  // 与 buildCaizhiHeaderIndex 同判据：含「对向账户」列的结构化表格不是财智原始导出。
  if (headerRow.map(normalizeHeader).includes("\u5bf9\u5411\u8d26\u6237")) return false;
  const normalized = headerRow.map(normalizeHeader);
  const hasDate = normalized.some((h) => h === "\u65e5\u671f" || h === "\u4ea4\u6613\u65e5\u671f");
  const hasInflow = normalized.some(
    (h) => h === "\u6d41\u5165" || h === "\u6d41\u5165\u91d1\u989d",
  );
  const hasOutflow = normalized.some(
    (h) => h === "\u6d41\u51fa" || h === "\u6d41\u51fa\u91d1\u989d" || h === "\u652f\u51fa",
  );
  const hasActivityType = normalized.some(
    (h) => h === "\u6d3b\u52a8\u7c7b\u578b" || h === "\u7c7b\u578b" || h === "\u4ea4\u6613\u7c7b\u578b",
  );
  // Need date + activity type + either inflow or outflow.
  return hasDate && hasActivityType && (hasInflow || hasOutflow);
}

/**
 * 财智基金账户明细模板（第二个财智模板）：
 * 表头形如 [日期, 活动类型, 基金名称, 价格, 数量, 费率, 交易金额, 余额, 标签, 备注]，
 * 活动类型含 开放式基金申购/开放式基金赎回/基金分红/基金再投资/持仓调整/转入|/转出|。
 * 导入时转换为 MMH 基金导入格式并路由到基金预览导入窗口。
 *
 * 映射（用户口径）：
 * - 开放式基金申购[|X] → 买入，资金账户 = X || 本账户（文件名账户）
 * - 开放式基金赎回[|X] → 赎回，资金账户 = X || 本账户
 * - 基金分红[|X] → 现金分红，资金账户 = X || 本账户
 * - 基金再投资 → 红利再投（无需资金账户）
 * - 持仓调整 → 买入（数量+金额，净值留空由确认金额重算），资金账户 = 本账户
 * - 转入|X / 转出|X = 资金转账（不建基金交易，由资金账户明细文件以转账入库）
 * - 余额调整 → 剔除计数（余额校准转换另行实现）
 *
 * 基金名称列：左侧 6 位为基金代码；账户名取文件名（「XXX的YYY_明细_日期」→ XXX的YYY）。
 * 账户名保留财智原名；往来/基金语义由账户类型与归属体现。
 */

const CAIZHI_FUND_IMPORT_HEADERS = [
  "\u65e5\u671f",
  "\u57fa\u91d1\u52a8\u4f5c",
  "\u8d44\u91d1\u8d26\u6237",
  "\u57fa\u91d1\u8d26\u6237",
  "\u57fa\u91d1\u4ee3\u7801",
  "\u91d1\u989d",
  "\u51c0\u503c",
  "\u4efd\u989d",
  "\u8d39\u7387",
  "\u5907\u6ce8",
];

export type CaizhiFundImportConversion = {
  /** 转换后的 MMH 基金导入行（含表头），可直接写入 xlsx 交给基金预览导入窗口 */
  rows: string[][];
  /** 参与转换的数据行数（不含余额调整剔除行） */
  rowCount: number;
  /** 余额调整剔除行数（余额校准转换另行处理） */
  excludedBalanceAdjustCount: number;
  /** 基金账户名（取自文件名） */
  accountName: string;
};

/** 判断表头是否为财智基金账户明细：同时有「活动类型」与「基金名称」列。 */
export function detectCaizhiFundDetailHeaders(headerRow: string[]): boolean {
  const normalized = headerRow.map(normalizeHeader);
  const hasActivityType = normalized.some((h) => h === "\u6d3b\u52a8\u7c7b\u578b" || h === "\u7c7b\u578b" || h === "\u4ea4\u6613\u7c7b\u578b");
  const hasFundName = normalized.includes("\u57fa\u91d1\u540d\u79f0");
  return hasActivityType && hasFundName;
}

/**
 * 尝试从文件名中提取财智8导出的账户名。
 * 财智8 导出名形如「XXX的YYY_明细_YYYY-MM-DD.xls」；账户名本身不含「的」时形如
 * 「计划帐户(姜)_明细_2026-09-02.xls」；人工改名后也可能长成「XXX的YYY_财智_2026-09-03.xls」。
 */
export function guessCaizhiAccountNameFromFilename(filename: string): string {
  const base = String(filename ?? "").replace(/\.(xls|xlsx)$/i, "");
  const withOwner = base.match(/^(.+?的.+?)_明细_/);
  if (withOwner) return withOwner[1];
  // 去掉「_明细_ / _财智_ + 日期」尾巴，避免整串文件名被当成账户名。
  const trimmed = base.replace(/_(?:明细|财智)?_?\d{4}-\d{2}-\d{2}.*$/, "");
  if (trimmed && trimmed !== base) return trimmed;
  return base || "财智账户";
}

function caizhiFundSplitFundName(value: string): { fundCode: string; fundName: string } {
  const text = cleanText(value);
  const match = text.match(/^(\d{6})\s*(.*)$/);
  if (match) return { fundCode: match[1], fundName: match[2].trim() };
  return { fundCode: "", fundName: text };
}

type CaizhiFundAction = "buy" | "redeem" | "dividend_cash" | "dividend_reinvest";

function caizhiFundActionFor(activityType: string): { action: CaizhiFundAction; cashAccount: string | null } | null {
  const [prefixRaw, counterRaw] = activityType.split("|");
  const prefix = prefixRaw?.trim() ?? "";
  const counterAccount = counterRaw?.trim() ?? "";
  const fundAccountSelf = "";
  switch (prefix) {
    case "\u5f00\u653e\u5f0f\u57fa\u91d1\u7533\u8d2d": // 开放式基金申购
    case "\u57fa\u91d1\u7533\u8d2d":
      return { action: "buy", cashAccount: counterAccount || fundAccountSelf };
    case "\u5f00\u653e\u5f0f\u57fa\u91d1\u8d4e\u56de": // 开放式基金赎回
    case "\u57fa\u91d1\u8d4e\u56de":
      return { action: "redeem", cashAccount: counterAccount || fundAccountSelf };
    case "\u57fa\u91d1\u5206\u7ea2": // 基金分红
      return { action: "dividend_cash", cashAccount: counterAccount || fundAccountSelf };
    case "\u57fa\u91d1\u518d\u6295\u8d44": // 基金再投资
      return { action: "dividend_reinvest", cashAccount: "" };
    case "\u6301\u4ed3\u8c03\u6574": // 持仓调整 → 买入（初始持仓）
      return { action: "buy", cashAccount: "" };
    default:
      // 转入|X / 转出|X = 资金（现金）转账：从 X（资金账户）转入/转出本基金账户的资金，
      // 不产生基金份额变动，不由基金模板建账——由对应资金账户明细文件以转账形式入库。
      return null;
  }
}

/**
 * 将财智基金明细 sheets 转换为 MMH 基金导入行（含 CAIZHI_FUND_IMPORT_HEADERS 表头）。
 * 未识别的活动类型行跳过并计数；余额调整行剔除计数。
 */
export function normalizeCaizhiFundImportRows(
  sheets: CaizhiWorkbookSheetRows[],
  accountName: string,
): { rows: string[][]; rowCount: number; excludedBalanceAdjustCount: number; skippedUnknownCount: number } | undefined {
  const selfAccount = cleanText(accountName) || "\u8d22\u667a\u57fa\u91d1\u8d26\u6237";
  const outputRows: string[][] = [];
  let excludedBalanceAdjustCount = 0; // 含余额调整与转入|/转出|资金转账行
  let skippedUnknownCount = 0;
  let includedSheetCount = 0;

  for (const sheet of sheets) {
    const dataRows = sheet.rows;
    if (dataRows.length === 0) continue;
    const headerRow = dataRows[0] ?? [];
    if (!detectCaizhiFundDetailHeaders(headerRow)) continue;

    includedSheetCount++;
    const idx = (name: string) => headerRow.findIndex((h) => normalizeHeader(h) === normalizeHeader(name));
    const dateIdx = idx("\u65e5\u671f");
    const actIdx = idx("\u6d3b\u52a8\u7c7b\u578b");
    const fundNameIdx = idx("\u57fa\u91d1\u540d\u79f0");
    const priceIdx = idx("\u4ef7\u683c");
    const unitsIdx = idx("\u6570\u91cf");
    const feeRateIdx = idx("\u8d39\u7387");
    const amountIdx = idx("\u4ea4\u6613\u91d1\u989d");

    for (let r = 1; r < dataRows.length; r++) {
      const row = dataRows[r];
      if (!row.some((cell) => cleanText(cell))) continue;
      const activityType = cleanText(row[actIdx]);
      if (!activityType) continue;
      if (activityType.includes("\u4f59\u989d\u8c03\u6574") || activityType.includes("\u4f59\u989d\u521d\u59cb\u5316")) {
        excludedBalanceAdjustCount++;
        continue;
      }
      // 转入|X / 转出|X = 资金（现金）转账：从 X（资金账户）转入/转出本基金账户的资金，
      // 不产生基金份额变动，不由基金模板建账——由对应资金账户明细文件以转账形式入库。
      if (activityType.startsWith("\u8f6c\u5165|") || activityType.startsWith("\u8f6c\u51fa|")) {
        excludedBalanceAdjustCount++;
        continue;
      }
      const mapped = caizhiFundActionFor(activityType);
      if (!mapped) { skippedUnknownCount++; continue; }

      const fund = caizhiFundSplitFundName(row[fundNameIdx]);
      const amount = cleanText(row[amountIdx]);
      const price = cleanText(row[priceIdx]);
      const units = cleanText(row[unitsIdx]);
      const feeRate = cleanText(row[feeRateIdx]);
      const remark = cleanText(row[idx("\u5907\u6ce8")]);
      const cashAccount = mapped.cashAccount || selfAccount;

      outputRows.push([
        normalizeDate(row[dateIdx]),
        mapped.action,
        cashAccount,
        selfAccount,
        fund.fundCode,
        amount,
        price === "0.00" ? "" : price,
        units === "0.00" ? "" : units,
        feeRate,
        remark,
      ]);
    }
  }

  if (includedSheetCount === 0) return undefined;
  return {
    rows: [CAIZHI_FUND_IMPORT_HEADERS, ...outputRows],
    rowCount: outputRows.length,
    excludedBalanceAdjustCount,
    skippedUnknownCount,
  };
}

/**
 * 尝试将财智基金明细文件转换为 MMH 基金导入文件（xlsx）。
 * 非财智基金明细（表头无「活动类型+基金名称」）返回 null。
 * 返回的 File 可直接交给基金预览导入窗口（FundImportPreviewDialog）。
 */
export async function convertCaizhiFundImportFile(
  file: File,
): Promise<{ file: File; rowCount: number; excludedBalanceAdjustCount: number; accountName: string } | null> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheets: CaizhiWorkbookSheetRows[] = workbook.SheetNames.map((sheetName) => ({
    sheetName,
    rows: XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(workbook.Sheets[sheetName], {
      header: 1,
      defval: "",
      raw: false,
      dateNF: "yyyy-mm-dd",
    }).map((row) => row.map((cell) => String(cell ?? "").trim())),
  }));
  const hasFundSheet = sheets.some((sheet) => sheet.rows.length > 0 && detectCaizhiFundDetailHeaders(sheet.rows[0] ?? []));
  if (!hasFundSheet) return null;
  const accountName = guessCaizhiAccountNameFromFilename(file.name);
  const converted = normalizeCaizhiFundImportRows(sheets, accountName);
  if (!converted || converted.rowCount === 0) return null;
  const outWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWorkbook, XLSX.utils.aoa_to_sheet(converted.rows), "\u8d22\u667a\u57fa\u91d1\u5bfc\u5165");
  const buffer = XLSX.write(outWorkbook, { type: "array", bookType: "xlsx" });
  const view = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return {
    file: new File([view as ArrayBuffer], `${accountName}\u002d\u8d22\u667a\u57fa\u91d1\u5bfc\u5165.xlsx`, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    rowCount: converted.rowCount,
    excludedBalanceAdjustCount: converted.excludedBalanceAdjustCount,
    accountName,
  };
}
