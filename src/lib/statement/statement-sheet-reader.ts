import { decodeTextFile } from "@/lib/text/decode-text-file";

export type StatementSheetRows = {
  sheetName: string;
  rows: string[][];
};

/** 单元格统一转字符串：cellDates 读出来的日期是 Date，其余 XLSX 已按显示值给了字符串。 */
export function formatStatementCell(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const datePart = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    const hour = value.getHours();
    const minute = value.getMinutes();
    const second = value.getSeconds();
    if (hour || minute || second) {
      return `${datePart} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    }
    return datePart;
  }
  return String(value ?? "").trim();
}

function fileExtension(file: File) {
  const name = String(file?.name ?? "");
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isSpreadsheetWorkbookFile(file: File) {
  const ext = fileExtension(file);
  return ext === "xlsx" || ext === "xls";
}

/** CSV 解析（支持引号包裹和 "" 转义）：账单只有一份语法，全局共用一份实现。 */
export function parseStatementCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/**
 * 读取账单文件的唯一入口：xlsx / xls 走 XLSX，其余一律当文本 CSV。
 *
 * CSV 绝不能交给 `XLSX.read`：支付宝 / 微信在 Windows 上导出的账单是 GBK，
 * SheetJS 对 CSV 按 cp1252 解码，整张表会变成「ÆðÊ¼Ê±¼ä」这类乱码，
 * 表头别名匹配随之全失效。文本型文件统一先过 `decodeTextFile` 探测编码。
 */
export async function readStatementSheetRows(file: File): Promise<StatementSheetRows[]> {
  if (!isSpreadsheetWorkbookFile(file)) {
    return [{ sheetName: file.name, rows: parseStatementCsv(await decodeTextFile(file)) }];
  }
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return {
      sheetName,
      rows: XLSX.utils
        .sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
          header: 1,
          defval: "",
          raw: false,
          dateNF: "yyyy-mm-dd",
        })
        .map((row) => row.map(formatStatementCell).map((cell) => cell.trim())),
    };
  });
}
