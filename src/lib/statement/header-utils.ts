/**
 * 账单模板共用的表头 / 单元格工具。
 *
 * 支付宝、京东、微信三家原本各抄一份 `cleanText + normalizeHeader + findHeaderIndex + readCell + parseAmount`，
 * 改一处要改三遍（表头扫描窗口、金额别名这类坑都只修到了其中一家）。共性实现收在这里，
 * 模板只留自己的列名与业务判定。
 *
 * 财智的同类函数语义不同（数字单元格要保留、表头不去冒号、金额允许负数），刻意没有并进来。
 */

/** 去掉 BOM 与首尾空白；null / undefined 统一成空串。 */
export function cleanStatementText(value: unknown) {
  return String(value ?? "").replace(/^\ufeff/, "").trim();
}

/** 表头归一：去掉全部空白与冒号，再小写。 */
export function normalizeStatementHeader(value: string) {
  return cleanStatementText(value).replace(/\s+/g, "").replace(/[\uff1a:]/g, "").toLowerCase();
}

/** 在一行表头里按别名顺序找列号，找不到返回 -1。 */
export function findStatementHeaderIndex(headers: readonly string[], aliases: readonly string[]) {
  const normalizedHeaders = headers.map(normalizeStatementHeader);
  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(normalizeStatementHeader(alias));
    if (index >= 0) return index;
  }
  return -1;
}

/** 读单元格：列号无效时返回空串。 */
export function readStatementCell(row: readonly string[], index: number) {
  return index >= 0 ? cleanStatementText(row[index]) : "";
}

/**
 * 金额：去掉千分位、人民币符号与空白后转数字。
 * 返回字符串（与账单标准行的金额列一致）；非正数返回空串。
 */
export function parseStatementAmount(value: unknown) {
  const amount = Number(cleanStatementText(value).replace(/[,\uff0c\uffe5\u00a5\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "";
}

/** `2026-10-28` / `2026/10/28` / `2026年10月28日`，时间部分可选。 */
const YEAR_FIRST_DATE_PATTERN =
  /^(\d{4})[/.\-\u5e74](\d{1,2})[/.\-\u6708](\d{1,2})\u65e5?(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/;

/** 旧版导出的「月/日/年」（`10/28/2026`、`6/3/26`），时间部分可选。 */
const MONTH_FIRST_DATE_PATTERN =
  /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/;

function buildStatementDate(year: number, month: number, day: number, timePart: string) {
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const datePart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return timePart ? `${datePart} ${timePart}` : datePart;
}

/**
 * 日期归一：`2026-10-28 16:34:22` / `2026/10/28` / `2026年10月28日` / `10/28/2026`
 * → `YYYY-MM-DD[ HH:mm[:ss]]`。认不出来的原样返回（宁可透传错值，也不要悄悄改成今天）。
 * `keepTime: false` 只留日期 —— 支付宝交易明细只按日入账。
 */
export function normalizeStatementDate(value: unknown, options?: { keepTime?: boolean }) {
  const keepTime = options?.keepTime !== false;
  const raw = cleanStatementText(value).replace(/\s+/g, " ");

  const yearFirst = raw.match(YEAR_FIRST_DATE_PATTERN);
  if (yearFirst) {
    return (
      buildStatementDate(
        Number(yearFirst[1]),
        Number(yearFirst[2]),
        Number(yearFirst[3]),
        keepTime ? (yearFirst[4]?.trim() ?? "") : "",
      ) || raw
    );
  }

  const monthFirst = raw.match(MONTH_FIRST_DATE_PATTERN);
  if (monthFirst) {
    const rawYear = monthFirst[3] ?? "";
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return (
      buildStatementDate(
        year,
        Number(monthFirst[1]),
        Number(monthFirst[2]),
        keepTime ? (monthFirst[4]?.trim() ?? "") : "",
      ) || raw
    );
  }

  return raw;
}
