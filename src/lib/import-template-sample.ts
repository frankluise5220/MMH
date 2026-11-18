/**
 * Shared helpers for the import templates exported by the app.
 *
 * Every exported template shares the same shape (see AccountBatchImportButton):
 * a header row, sample rows flagged in the sample-row marker column, then a
 * field guide block that starts with a guide title row. Importers must skip the
 * flagged sample rows and everything from the guide title row downwards.
 */

const TEMPLATE_SAMPLE_HEADER_ALIASES = [
  "\u6837\u677f\u884c",
  "\u6a23\u677f\u884c",
  "samplerow",
  "sample row",
  "sample",
  "\u30b5\u30f3\u30d7\u30eb\u884c",
];

const TEMPLATE_SAMPLE_ROW_VALUES = new Set([
  "yes",
  "y",
  "true",
  "1",
  "sample",
  "\u662f",
  "\u306f\u3044",
  "\u6a23\u677f",
  "\u6837\u677f",
]);

/**
 * 导出模板的说明区标题。界面语言决定模板里的文案，而服务端解析、邮件附件通道
 * 拿不到 i18n 上下文，所以这里内置三种语言的标题前缀，供没有 t() 的调用方使用。
 */
export const TEMPLATE_GUIDE_TITLE_HINTS = [
  "\u672c\u9875\u5b57\u6bb5\u8bf4\u660e",
  "sheet field guide",
  "\u3053\u306e\u30b7\u30fc\u30c8\u306e\u9805\u76ee\u8aac\u660e",
  "\u5b57\u6bb5\u8bf4\u660e",
];

/** 说明区标题：单个文案（界面 t() 结果）或多个候选文案。 */
export type TemplateGuideTitle = string | readonly string[];

function normalizeTemplateText(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeTemplateHeaderText(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

function templateGuideTitles(guideTitle: TemplateGuideTitle) {
  const titles = (typeof guideTitle === "string" ? [guideTitle] : guideTitle)
    .map((title) => normalizeTemplateText(title))
    .filter(Boolean);
  return titles;
}

/** 单个单元格是否为样板行标记（「是」/yes/1/样板…）；空白不是。 */
export function isTemplateSampleRowValue(value: unknown) {
  return TEMPLATE_SAMPLE_ROW_VALUES.has(normalizeTemplateText(value));
}

/** Column index of the sample-row marker column, or -1 when absent. */
export function findTemplateSampleColumnIndex(headers: readonly unknown[]) {
  return headers.findIndex((header) =>
    TEMPLATE_SAMPLE_HEADER_ALIASES.includes(normalizeTemplateHeaderText(header)),
  );
}

function isTemplateGuideTitleCell(value: unknown, titles: readonly string[]) {
  if (titles.length === 0) return false;
  const text = normalizeTemplateText(value);
  if (!text) return false;
  return titles.some((title) => text.startsWith(title));
}

/** Row index of the guide title row, or -1 when the sheet has no guide block. */
export function findTemplateGuideTitleRowIndex(
  rows: ReadonlyArray<readonly unknown[]>,
  guideTitle: TemplateGuideTitle,
) {
  const titles = templateGuideTitles(guideTitle);
  if (titles.length === 0) return -1;
  return rows.findIndex((row) => row.some((cell) => isTemplateGuideTitleCell(cell, titles)));
}

/** Drops rows flagged in the sample-row marker column. Expects data rows (header excluded). */
export function dropTemplateSampleRows<T extends readonly unknown[]>(rows: T[], sampleColumnIndex: number) {
  if (sampleColumnIndex < 0) return rows;
  return rows.filter((row) => !isTemplateSampleRowValue(row[sampleColumnIndex]));
}

/** Keeps only the rows above the guide title row (the guide block is not data). */
export function rowsBeforeTemplateGuide<T>(rows: T[], guideTitleRowIndex: number) {
  return guideTitleRowIndex >= 0 ? rows.slice(0, guideTitleRowIndex) : rows;
}

/**
 * 统一入口：表头已知时一次性剔除「样板行」与底部「字段说明」区块。
 * 所有把「表头 + 数据行」转成业务数据的导入解析器都应走这里，
 * 避免某条通道把模板自带的示例行当成真实数据记一笔。
 */
export function stripTemplateRows<T extends readonly unknown[]>(
  dataRows: T[],
  headers: readonly unknown[],
  guideTitle: TemplateGuideTitle = "",
): T[] {
  const sampleColumnIndex = findTemplateSampleColumnIndex(headers);
  const guideTitleRowIndex = findTemplateGuideTitleRowIndex(dataRows, guideTitle);
  return dropTemplateSampleRows(rowsBeforeTemplateGuide(dataRows, guideTitleRowIndex), sampleColumnIndex);
}
