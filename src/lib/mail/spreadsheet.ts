import {
  dropTemplateSampleRows,
  findTemplateGuideTitleRowIndex,
  findTemplateSampleColumnIndex,
  TEMPLATE_GUIDE_TITLE_HINTS,
} from "@/lib/import-template-sample";

type SpreadsheetCell = string | number | boolean | Date | null;

/**
 * 邮件附件的表格在交给 AI / 解析器之前，先按「导入模板」的约定剔噪：
 * 表头列里有「样板行」标记时丢掉被标记的示例行，并截断底部的字段说明区。
 * 普通银行/支付账单没有这些列，原样返回。
 */
function dropTemplateNoise(rows: string[][]) {
  const headerIndex = rows
    .slice(0, 6)
    .findIndex((row) => findTemplateSampleColumnIndex(row) >= 0);
  if (headerIndex < 0) {
    const guideIndex = findTemplateGuideTitleRowIndex(rows, TEMPLATE_GUIDE_TITLE_HINTS);
    return guideIndex >= 0 ? rows.slice(0, guideIndex) : rows;
  }

  const sampleColumnIndex = findTemplateSampleColumnIndex(rows[headerIndex]);
  const bodyRows = rows.slice(headerIndex + 1);
  const guideIndex = findTemplateGuideTitleRowIndex(bodyRows, TEMPLATE_GUIDE_TITLE_HINTS);
  const dataRows = dropTemplateSampleRows(
    guideIndex >= 0 ? bodyRows.slice(0, guideIndex) : bodyRows,
    sampleColumnIndex,
  );
  return [...rows.slice(0, headerIndex + 1), ...dataRows];
}

export async function extractSpreadsheetText(content: Buffer) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(content, { type: "buffer", cellDates: true });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<SpreadsheetCell[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }).map((row) => row.map((cell) => String(cell ?? "").trim()));

    const lines = dropTemplateNoise(rows)
      .map((row) => row.map((cell) => String(cell ?? "").trim()).join("\t").trimEnd())
      .filter((line) => line.trim());
    if (lines.length > 0) sections.push(`【工作表：${sheetName}】\n${lines.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}
