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
  "\u6d41\u51fa": "skip",
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
    // Transfer: right side of "|" is the counter account, category stays blank.
    const [, counterAccountRaw] = activityType.split("|");
    const counterAccount = counterAccountRaw?.trim() ?? "";
    const outflow = hasOutflow ? String(outflowRaw) : "";
    const inflow = hasInflow ? String(inflowRaw) : "";
    return [date, "", "\u8f6c\u8d26", outflow, inflow, accountName, counterAccount, "", "", "", remark];
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
    rows: resultRows,
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
