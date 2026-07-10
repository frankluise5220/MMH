"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { WorkBook } from "xlsx";
import { useRouter } from "next/navigation";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { TableColumnFilter } from "@/components/TableColumnFilter";
import { useI18n } from "@/lib/i18n";

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  postedAt?: string;
  amount: number;
  outflow?: number;
  inflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  institution?: string;
  tags?: string;
  remark?: string;
  secondRemark?: string;
  counterparty?: string;
  transferDirection?: "in" | "out";
};

type FundImportUploadItem = {
  rawText: string;
  date: string;
  fundSubtype: string;
  source: string;
  cashAccount: string;
  fundAccount: string;
  fundCode: string;
  fundName: string;
  amount: number;
  units: number | null;
  nav: number | null;
  fee: number | null;
  confirmDate: string | null;
  arrivalDate: string | null;
  remark: string;
};

type FundPreviewIssue = {
  level: "error" | "warning";
  message: string;
};

type FundImportPreviewItem = FundImportUploadItem & {
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  issues: FundPreviewIssue[];
};

type FundRuleEditorRow = {
  key: string;
  fundAccountId: string | null;
  fundAccount: string;
  fundCode: string;
  fundName: string;
  confirmDays: string;
  arrivalDays: string;
};

type ImportTemplate = {
  key: "normal" | "fund" | "credit";
  title: string;
  description: string;
  status: string;
  filename: string;
  downloadFormat?: "csv" | "xlsx";
  sheetName?: string;
  headers: string[];
  exportHeaders?: string[];
  rows: string[][];
  fields: Array<{ name: string; label?: string; required: boolean; note: string }>;
};

type AccountOption = {
  id: string;
  name: string;
  kind: "cash" | "bank_debit" | "bank_credit" | string;
  isActive?: boolean;
  Institution?: { id?: string; name?: string; shortName?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type FilterColumn = "date" | "type" | "account" | "counterAccount" | "remark";
type EditableCell = "date" | "type" | "outflow" | "inflow" | "account" | "counterAccount" | "category" | "institution" | "tags" | "remark";
type ReplaceField = EditableCell;
type ImportIssue = { idx: number; level: "error" | "warning"; message: string };
type FundImportKind = "normal" | "fund" | null;

const filterColumns: FilterColumn[] = ["date", "type", "account", "counterAccount", "remark"];
const INITIAL_PREVIEW_COUNT = 200;
const PREVIEW_COUNT_STEP = 200;
const FUND_CANONICAL_HEADERS = [
  "date",
  "fundSubtype",
  "source",
  "cashAccount",
  "fundAccount",
  "fundCode",
  "fundName",
  "amount",
  "units",
  "nav",
  "fee",
  "confirmDate",
  "arrivalDate",
  "remark",
] as const;
const FUND_LABEL_HEADER_SET = new Set([
  "日期",
  "基金动作",
  "来源",
  "资金账户",
  "基金账户",
  "基金代码",
  "基金名称",
  "金额",
  "份额",
  "净值",
  "手续费",
  "净值日期",
  "入账日期",
  "备注",
]);
const FUND_FIELD_ALIASES: Record<Exclude<keyof FundImportUploadItem, "rawText">, string[]> = {
  date: ["date", "日期", "交易日期", "申请日期"],
  fundSubtype: ["fundSubtype", "基金动作", "基金类型", "动作"],
  source: ["source", "来源"],
  cashAccount: ["cashAccount", "资金账户", "现金账户", "付款账户", "cash account"],
  fundAccount: ["fundAccount", "基金账户", "投资账户", "account", "fund account"],
  fundCode: ["fundCode", "基金代码", "代码", "fund code"],
  fundName: ["fundName", "基金名称", "名称", "fund name"],
  amount: ["amount", "金额", "发生金额"],
  units: ["units", "份额", "确认份额"],
  nav: ["nav", "净值", "成交净值"],
  fee: ["fee", "手续费"],
  confirmDate: ["confirmDate", "确认日期", "净值日期"],
  arrivalDate: ["arrivalDate", "入账日期", "到账日期"],
  remark: ["remark", "备注", "说明"],
};

const replaceFieldLabelKeys: Record<ReplaceField, string> = {
  date: "batchImport.field.date",
  type: "batchImport.field.type",
  outflow: "batchImport.field.outflow",
  inflow: "batchImport.field.inflow",
  account: "batchImport.field.account",
  counterAccount: "batchImport.field.counterAccount",
  category: "batchImport.field.category",
  institution: "batchImport.field.institution",
  tags: "batchImport.field.tags",
  remark: "batchImport.field.remark",
};

function applyNumberExpression(currentValue: number, expression: string) {
  const value = expression.trim();
  if (!value) return currentValue;
  const absolute = Number(value);
  if (Number.isFinite(absolute)) return absolute;
  const match = value.match(/^([+\-*/])\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return Number.NaN;
  const operand = Number(match[2]);
  if (!Number.isFinite(operand)) return Number.NaN;
  if (match[1] === "+") return currentValue + operand;
  if (match[1] === "-") return currentValue - operand;
  if (match[1] === "*") return currentValue * operand;
  if (operand === 0) return Number.NaN;
  return currentValue / operand;
}

function buildTemplates(t: (key: string) => string): ImportTemplate[] {
  return [
  {
    key: "normal",
    title: t("batchImport.template.normal.title"),
    description: t("batchImport.template.normal.description"),
    status: t("batchImport.template.normal.status"),
    filename: "账单记录导入模板.csv",
    downloadFormat: "csv",
    sheetName: t("batchImport.sheet.template"),
    headers: ["日期", "入账时间", "收支大类", "金额", "账户", "对向账户", "分类", "收支机构", "标签", "备注"],
    rows: [
      ["2026-06-08", "2026-06-09 09:30", "支出", "32.50", "招商银行2758", "", "餐饮", "麦当劳", "午餐", "午餐"],
      ["2026-06-08", "", "收入", "1.28", "招商银行2758", "", "利息收入", "招商银行", "利息", "活期利息"],
      ["2026-06-08", "2026-06-08 23:30", "支出", "2.00", "招商银行2758", "", "利息支出", "招商银行", "手续费", "账户管理费"],
      ["2026-06-08", "", "转账", "1000.00", "招商银行2758", "现金", "", "", "现金", "取现"],
    ],
    fields: [
      { name: "日期", required: true, note: t("batchImport.template.normal.field.date") },
      { name: "入账时间", required: false, note: t("batchImport.template.normal.field.postedAt") },
      { name: "收支大类", required: true, note: t("batchImport.template.normal.field.majorType") },
      { name: "金额", required: true, note: t("batchImport.template.normal.field.amount") },
      { name: "账户", required: true, note: t("batchImport.template.normal.field.account") },
      { name: "对向账户", required: false, note: t("batchImport.template.normal.field.counterAccount") },
      { name: "分类", required: false, note: t("batchImport.template.normal.field.category") },
      { name: "收支机构", required: false, note: t("batchImport.template.normal.field.institution") },
      { name: "标签", required: false, note: t("batchImport.template.normal.field.tags") },
      { name: "备注", required: false, note: t("batchImport.template.normal.field.remark") },
    ],
  },
  {
    key: "fund",
    title: t("batchImport.template.fund.title"),
    description: t("batchImport.template.fund.description"),
    status: t("batchImport.template.normal.status"),
    filename: "基金记录导入模板.xlsx",
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: ["date", "fundSubtype", "source", "cashAccount", "fundAccount", "fundCode", "fundName", "amount", "units", "nav", "fee", "confirmDate", "arrivalDate", "remark"],
    exportHeaders: [
      t("batchImport.template.fund.label.date"),
      t("batchImport.template.fund.label.fundSubtype"),
      t("batchImport.template.fund.label.source"),
      t("batchImport.template.fund.label.cashAccount"),
      t("batchImport.template.fund.label.fundAccount"),
      t("batchImport.template.fund.label.fundCode"),
      t("batchImport.template.fund.label.fundName"),
      t("batchImport.template.fund.label.amount"),
      t("batchImport.template.fund.label.units"),
      t("batchImport.template.fund.label.nav"),
      t("batchImport.template.fund.label.fee"),
      t("batchImport.template.fund.label.confirmDate"),
      t("batchImport.template.fund.label.arrivalDate"),
      t("batchImport.template.fund.label.remark"),
    ],
    rows: [
      ["2026-06-08", "buy", "regular_invest", "招商银行2758", "招商基金账户", "000001", "示例基金", "100.00", "99.9000", "1.0010", "0.15", "2026-06-10", "2026-06-11", "定投成功部分"],
      ["2026-06-08", "refund", "regular_invest_refund", "招商银行2758", "招商基金账户", "000001", "示例基金", "100.00", "", "", "", "2026-06-10", "2026-06-11", "定投退回部分"],
      ["2026-06-12", "redeem", "manual", "招商银行2758", "招商基金账户", "000001", "示例基金", "500.00", "499.0000", "1.0020", "0.50", "2026-06-14", "2026-06-15", "赎回"],
    ],
    fields: [
      { name: "date", label: t("batchImport.template.fund.label.date"), required: true, note: t("batchImport.template.fund.field.date") },
      { name: "fundSubtype", label: t("batchImport.template.fund.label.fundSubtype"), required: true, note: t("batchImport.template.fund.field.fundSubtype") },
      { name: "source", label: t("batchImport.template.fund.label.source"), required: false, note: t("batchImport.template.fund.field.source") },
      { name: "cashAccount", label: t("batchImport.template.fund.label.cashAccount"), required: false, note: t("batchImport.template.fund.field.cashAccount") },
      { name: "fundAccount", label: t("batchImport.template.fund.label.fundAccount"), required: true, note: t("batchImport.template.fund.field.fundAccount") },
      { name: "fundCode", label: t("batchImport.template.fund.label.fundCode"), required: true, note: t("batchImport.template.fund.field.fundCode") },
      { name: "fundName", label: t("batchImport.template.fund.label.fundName"), required: false, note: t("batchImport.template.fund.field.fundName") },
      { name: "amount", label: t("batchImport.template.fund.label.amount"), required: true, note: t("batchImport.template.fund.field.amount") },
      { name: "units", label: t("batchImport.template.fund.label.units"), required: false, note: t("batchImport.template.fund.field.units") },
      { name: "nav", label: t("batchImport.template.fund.label.nav"), required: false, note: t("batchImport.template.fund.field.nav") },
      { name: "fee", label: t("batchImport.template.fund.label.fee"), required: false, note: t("batchImport.template.fund.field.fee") },
      { name: "confirmDate", label: t("batchImport.template.fund.label.confirmDate"), required: false, note: t("batchImport.template.fund.field.confirmDate") },
      { name: "arrivalDate", label: t("batchImport.template.fund.label.arrivalDate"), required: false, note: t("batchImport.template.fund.field.arrivalDate") },
      { name: "remark", label: t("batchImport.template.fund.label.remark"), required: false, note: t("batchImport.template.fund.field.remark") },
    ],
  },
  {
    key: "credit",
    title: t("batchImport.template.credit.title"),
    description: t("batchImport.template.credit.description"),
    status: t("batchImport.template.pending"),
    filename: "信用卡账单导入模板.xlsx",
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: ["statementMonth", "date", "type", "cardAccount", "amount", "category", "merchant", "remark", "installmentNo", "installmentTotal"],
    exportHeaders: [
      t("batchImport.template.credit.label.statementMonth"),
      t("batchImport.template.credit.label.date"),
      t("batchImport.template.credit.label.type"),
      t("batchImport.template.credit.label.cardAccount"),
      t("batchImport.template.credit.label.amount"),
      t("batchImport.template.credit.label.category"),
      t("batchImport.template.credit.label.merchant"),
      t("batchImport.template.credit.label.remark"),
      t("batchImport.template.credit.label.installmentNo"),
      t("batchImport.template.credit.label.installmentTotal"),
    ],
    rows: [
      ["2026-06", "2026-06-03", "expense", "招商信用卡", "128.00", "餐饮", "示例餐厅", "晚餐", "", ""],
      ["2026-06", "2026-06-05", "refund", "招商信用卡", "20.00", "餐饮", "示例餐厅", "退款", "", ""],
      ["2026-06", "2026-06-20", "repayment", "招商信用卡", "108.00", "", "", "还款", "", ""],
    ],
    fields: [
      { name: "statementMonth", label: t("batchImport.template.credit.label.statementMonth"), required: true, note: t("batchImport.template.credit.field.statementMonth") },
      { name: "date", label: t("batchImport.template.credit.label.date"), required: true, note: t("batchImport.template.credit.field.date") },
      { name: "type", label: t("batchImport.template.credit.label.type"), required: true, note: t("batchImport.template.credit.field.type") },
      { name: "cardAccount", label: t("batchImport.template.credit.label.cardAccount"), required: true, note: t("batchImport.template.credit.field.cardAccount") },
      { name: "amount", label: t("batchImport.template.credit.label.amount"), required: true, note: t("batchImport.template.credit.field.amount") },
      { name: "category", label: t("batchImport.template.credit.label.category"), required: false, note: t("batchImport.template.credit.field.category") },
      { name: "merchant", label: t("batchImport.template.credit.label.merchant"), required: false, note: t("batchImport.template.credit.field.merchant") },
      { name: "remark", label: t("batchImport.template.credit.label.remark"), required: false, note: t("batchImport.template.credit.field.remark") },
      { name: "installmentNo", label: t("batchImport.template.credit.label.installmentNo"), required: false, note: t("batchImport.template.credit.field.installmentNo") },
      { name: "installmentTotal", label: t("batchImport.template.credit.label.installmentTotal"), required: false, note: t("batchImport.template.credit.field.installmentTotal") },
    ],
  },
  ];
}

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsv(template: ImportTemplate) {
  const exportHeaders = template.exportHeaders ?? template.headers;
  return [exportHeaders, ...template.rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

async function buildTemplateWorkbook(
  template: ImportTemplate,
  t: (key: string) => string,
) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const displayHeaders = template.fields.map((field) => field.label ?? field.name);
  const exportHeaders = template.exportHeaders ?? template.headers;
  const needsLabelRow =
    exportHeaders.length !== displayHeaders.length ||
    exportHeaders.some((header, index) => header !== displayHeaders[index]);
  const templateRows = [
    exportHeaders,
    ...(needsLabelRow ? [displayHeaders] : []),
    ...template.rows,
  ];
  const templateSheet = XLSX.utils.aoa_to_sheet(templateRows);
  templateSheet["!cols"] = template.headers.map((header, index) => ({
    wch: Math.max(header.length, displayHeaders[index]?.length ?? 0, 14),
  }));
  XLSX.utils.book_append_sheet(workbook, templateSheet, template.sheetName ?? t("batchImport.sheet.template"));

  const noteRows = [
    [t("batchImport.sheet.noteTitle"), t("batchImport.sheet.noteContent")],
    [],
    [
      t("batchImport.sheet.fieldKey"),
      t("batchImport.sheet.displayLabel"),
      t("batchImport.sheet.requiredColumn"),
      t("batchImport.sheet.ruleColumn"),
    ],
    ...template.fields.map((field) => [
      field.name,
      field.label ?? field.name,
      field.required ? t("batchImport.required") : t("batchImport.optional"),
      field.note,
    ]),
  ];
  const noteSheet = XLSX.utils.aoa_to_sheet(noteRows);
  noteSheet["!cols"] = [{ wch: 20 }, { wch: 18 }, { wch: 10 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, noteSheet, t("batchImport.sheet.instructions"));
  return { XLSX, workbook };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
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

function parseMoney(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return 0;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function parseLooseNumber(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeFundHeaderText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeAccountMatchKey(value?: string) {
  return String(value ?? "")
    .trim()
    .replace(/[·•\-—\s]/g, "")
    .toLowerCase();
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatDateParts(year: number, month: number, day: number) {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizeDateCell(value: string) {
  const raw = value.trim();
  if (!raw) return "";

  const excelSerial = Number(raw);
  if (Number.isFinite(excelSerial) && excelSerial > 20000 && excelSerial < 80000) {
    const utc = Date.UTC(1899, 11, 30) + excelSerial * 86400000;
    const date = new Date(utc);
    return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const normalized = raw
    .replace(/[年月]/g, "-")
    .replace(/[日号]/g, "")
    .replace(/[.\/]/g, "-")
    .replace(/\s+.*/, "")
    .trim();

  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) return formatDateParts(Number(match[3]), Number(match[1]), Number(match[2]));

  match = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));

  return raw;
}

function inferBillType(source: string, inflow: number, outflow: number, counterAccount: string): ParsedItem["type"] {
  if (/转入|转进|他行转入|账户转入|转出|转账|转给|转到|汇款|跨行转账|取现|还款/.test(source)) return "transfer";
  if (/结息|利息|派息|收入|工资|报销|退款|退货|返现|返利/.test(source)) return "income";
  if (counterAccount) return "transfer";
  if (inflow > 0 && outflow <= 0) return "income";
  return "expense";
}

function parseMajorType(value: string): ParsedItem["type"] | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^(支出|expense|outflow)$/.test(raw)) return "expense";
  if (/^(收入|income|inflow)$/.test(raw)) return "income";
  if (/^(转账|transfer)$/.test(raw)) return "transfer";
  if (/^(投资|investment)$/.test(raw)) return "investment";
  return null;
}

function inferTransferDirection(source: string, inflow: number, outflow: number): "in" | "out" {
  if (/转入|转进|他行转入|账户转入|收款/.test(source)) return "in";
  if (/转出|转账|转给|转到|汇款|跨行转账|取现|还款/.test(source)) return "out";
  if (inflow > 0 && outflow <= 0) return "in";
  return "out";
}

function normalizeFlowFields(
  type: ParsedItem["type"],
  amountValue: number,
  inflowValue: number,
  outflowValue: number,
  transferDirection?: "in" | "out",
) {
  const amount = Math.abs(Number(amountValue || inflowValue || outflowValue) || 0);
  const inflow = Math.abs(Number(inflowValue) || 0);
  const outflow = Math.abs(Number(outflowValue) || 0);

  if (type === "income") {
    const nextAmount = amount || inflow;
    return { amount: nextAmount, inflow: nextAmount, outflow: 0 };
  }
  if (type === "expense") {
    const nextAmount = amount || outflow;
    return { amount: nextAmount, inflow: 0, outflow: nextAmount };
  }
  if (type === "transfer") {
    const nextAmount = amount || inflow || outflow;
    if (transferDirection === "in") return { amount: nextAmount, inflow: nextAmount, outflow: 0 };
    if (transferDirection === "out") return { amount: nextAmount, inflow: 0, outflow: nextAmount };
  }
  return { amount, inflow, outflow };
}

function worksheetRows(XLSX: typeof import("xlsx"), workbook: WorkBook): string[][] {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }).map((row) => row.map((cell) => String(cell ?? "").trim()));
}

async function parseImportFile(file: File): Promise<string[][]> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const data = await file.arrayBuffer();
    return worksheetRows(XLSX, XLSX.read(data, { type: "array", cellDates: true }));
  }
  return parseCsv(await file.text());
}

function buildFundHeaderIndex(headers: string[]) {
  const normalizedHeaders = headers.map(normalizeFundHeaderText);
  const map = new Map<Exclude<keyof FundImportUploadItem, "rawText">, number>();
  (Object.entries(FUND_FIELD_ALIASES) as Array<[Exclude<keyof FundImportUploadItem, "rawText">, string[]]>).forEach(([field, aliases]) => {
    const index = normalizedHeaders.findIndex((header) => aliases.some((alias) => normalizeFundHeaderText(alias) === header));
    if (index >= 0) map.set(field, index);
  });
  return map;
}

function hasLikelyFundHeaders(map: Map<Exclude<keyof FundImportUploadItem, "rawText">, number>) {
  return map.has("date") && map.has("fundAccount") && map.has("fundCode") && map.has("amount");
}

function hasCanonicalFundHeaders(headers: string[]) {
  return headers.some((header) => FUND_CANONICAL_HEADERS.includes(header.trim() as (typeof FUND_CANONICAL_HEADERS)[number]));
}

function looksLikeFundLabelRow(headers: string[]) {
  return headers.some((header) => FUND_LABEL_HEADER_SET.has(header.trim()));
}

function fundRowsToItems(rows: string[][]): FundImportUploadItem[] {
  const firstRow = rows[0] ?? [];
  const secondRow = rows[1] ?? [];
  const firstHeaderIndex = buildFundHeaderIndex(firstRow);
  const secondHeaderIndex = buildFundHeaderIndex(secondRow);

  let headerIndex = firstHeaderIndex;
  let dataRows = rows.slice(1);

  if (hasCanonicalFundHeaders(firstRow)) {
    headerIndex = firstHeaderIndex;
    dataRows = rows.slice(looksLikeFundLabelRow(secondRow) ? 2 : 1);
  } else if (hasLikelyFundHeaders(firstHeaderIndex)) {
    headerIndex = firstHeaderIndex;
    dataRows = rows.slice(1);
  } else if (hasLikelyFundHeaders(secondHeaderIndex)) {
    headerIndex = secondHeaderIndex;
    dataRows = rows.slice(2);
  }

  const readField = (row: string[], field: Exclude<keyof FundImportUploadItem, "rawText">) => {
    const index = headerIndex.get(field);
    return index == null ? "" : String(row[index] ?? "").trim();
  };

  return dataRows
    .filter((row) => row.some((cell) => String(cell ?? "").trim()))
    .map((row) => ({
      rawText: row.join(" "),
      date: normalizeDateCell(readField(row, "date")),
      fundSubtype: readField(row, "fundSubtype"),
      source: readField(row, "source"),
      cashAccount: readField(row, "cashAccount"),
      fundAccount: readField(row, "fundAccount"),
      fundCode: readField(row, "fundCode"),
      fundName: readField(row, "fundName"),
      amount: parseLooseNumber(readField(row, "amount")) ?? 0,
      units: parseLooseNumber(readField(row, "units")),
      nav: parseLooseNumber(readField(row, "nav")),
      fee: parseLooseNumber(readField(row, "fee")),
      confirmDate: normalizeDateCell(readField(row, "confirmDate")) || null,
      arrivalDate: normalizeDateCell(readField(row, "arrivalDate")) || null,
      remark: readField(row, "remark"),
    }));
}

function formatOptionalNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function getFundImportSubtypeLabel(subtype: string, source: string, t: (key: string) => string) {
  if (subtype === "buy_failed" && source === "regular_invest_refund") return t("batchImport.fundSubtype.refund");
  if (subtype === "buy_failed") return t("batchImport.fundSubtype.unfilledRefund");
  if (subtype === "buy") return t("fund.subtype.buy");
  if (subtype === "redeem") return t("fund.subtype.redeem");
  if (subtype === "dividend_cash") return t("fund.subtype.dividend_cash");
  if (subtype === "dividend_reinvest") return t("fund.subtype.dividend_reinvest");
  return subtype || "-";
}

function getFundImportSourceLabel(source: string, t: (key: string) => string) {
  if (source === "regular_invest") return t("batchImport.fundSource.regularInvest");
  if (source === "regular_invest_refund") return t("batchImport.fundSource.regularInvest");
  if (source === "manual") return t("batchImport.fundSource.manual");
  if (source === "dividend") return t("batchImport.fundSource.dividend");
  return source || "-";
}

function buildFundRuleEditorRows(items: FundImportPreviewItem[]) {
  const map = new Map<string, FundRuleEditorRow>();
  for (const item of items) {
    const fundCode = item.fundCode.trim();
    const accountKey = item.fundAccountId || item.fundAccount.trim();
    if (!fundCode || !accountKey) continue;
    const key = `${accountKey}::${fundCode}`;
    if (map.has(key)) continue;
    map.set(key, {
      key,
      fundAccountId: item.fundAccountId,
      fundAccount: item.fundAccount,
      fundCode,
      fundName: item.fundName || fundCode,
      confirmDays: item.confirmDays != null ? String(item.confirmDays) : "",
      arrivalDays: item.arrivalDays != null ? String(item.arrivalDays) : "",
    });
  }
  return Array.from(map.values()).sort((a, b) =>
    a.fundAccount.localeCompare(b.fundAccount, "zh-Hans-CN") || a.fundCode.localeCompare(b.fundCode, "zh-Hans-CN"),
  );
}

function serializeFundRuleOverrides(rows: FundRuleEditorRow[]) {
  const invalidLabels: string[] = [];
  const overrides = rows.flatMap((row) => {
    const parseDays = (value: string, label: string) => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) {
        invalidLabels.push(`${row.fundCode} ${label}`);
        return null;
      }
      return Math.trunc(num);
    };
    const confirmDays = parseDays(row.confirmDays, "确认天数");
    const arrivalDays = parseDays(row.arrivalDays, "入账天数");
    if (!row.fundCode || (!row.fundAccountId && !row.fundAccount.trim())) return [];
    return [{
      fundAccountId: row.fundAccountId,
      fundAccount: row.fundAccount,
      fundCode: row.fundCode,
      confirmDays,
      arrivalDays,
    }];
  });
  return { overrides, invalidLabels };
}

function normalRowsToItems(rows: string[][]): ParsedItem[] {
  const [headers = [], ...dataRows] = rows;
  const headerIndex = new Map(headers.map((header, idx) => [header.trim(), idx]));
  const read = (row: string[], key: string) => row[headerIndex.get(key) ?? -1]?.trim() ?? "";
  const readAny = (row: string[], keys: string[]) => keys.map((key) => read(row, key)).find(Boolean) ?? "";

  return dataRows.map((row) => {
    const date = normalizeDateCell(readAny(row, ["日期", "交易日期", "记账日期", "入账日期", "账单日期", "date"]));
    const postedAt = readAny(row, ["入账时间", "入账日期时间", "实际入账时间", "postedAt", "postingTime"]);
    const rawOutflowText = readAny(row, ["流出", "支出", "转出", "借方金额", "支出金额", "outflow"]);
    const rawInflowText = readAny(row, ["流入", "收入", "转入", "贷方金额", "收入金额", "inflow"]);
    const rawAmountText = readAny(row, ["金额", "交易金额", "发生额", "本币金额", "人民币金额", "amount"]);
    const rawOutflow = parseMoney(rawOutflowText);
    const rawInflow = parseMoney(rawInflowText);
    const rawAmountSigned = parseLooseNumber(rawAmountText) ?? 0;
    const rawAmount = Math.abs(rawAmountSigned);
    const account = readAny(row, ["账户", "本方账户", "交易账户", "账号", "account", "fromAccount"]);
    const counterAccount = readAny(row, ["对向账户", "流向账户", "转入账户", "转出账户", "对方账户", "对手账户", "对方户名", "toAccount", "fromAccount"]);
    const remark = readAny(row, ["备注", "remark", "摘要", "说明", "交易摘要", "交易说明", "用途"]);
    const category = readAny(row, ["分类", "category"]);
    const institution = readAny(row, ["收支机构", "机构", "商户", "merchant", "institution"]);
    const tags = readAny(row, ["标签", "tags"]);
    const majorType = parseMajorType(readAny(row, ["收支大类", "大类", "收支", "方向", "majorType"]));
    const explicitType = readAny(row, ["类型", "原始类型", "交易类型", "业务类型", "收支类型", "借贷标志", "借贷方向", "type"]);
    const secondRemark = readAny(row, ["第二备注", "对方备注", "转入备注", "toNote", "secondRemark"]);
    const source = `${majorType ?? ""} ${explicitType} ${category} ${remark}`;
    const amountLooksIncome = /结息|利息|派息|收入|工资|报销|退款|退货|返现|返利|贷方|贷记|入账|存入/.test(source);
    const amountLooksExpense = /支出|消费|扣款|付款|转出|借方|借记|取现/.test(source);
    const hasExplicitFlow = rawInflow > 0 || rawOutflow > 0 || !!rawInflowText || !!rawOutflowText;
    const inferredType = majorType ?? inferBillType(
      source,
      rawInflow || (!hasExplicitFlow && rawAmountSigned > 0 && amountLooksIncome ? rawAmount : 0),
      rawOutflow || (!hasExplicitFlow && rawAmountSigned < 0 ? rawAmount : 0),
      counterAccount,
    );
    const type = inferredType;
    const onlyAmountFlow = !hasExplicitFlow && rawAmount > 0
      ? normalizeFlowFields(type, rawAmount, type === "income" ? rawAmount : 0, type === "income" ? 0 : rawAmount, type === "transfer" ? "out" : undefined)
      : null;
    const inflow = onlyAmountFlow?.inflow ?? rawInflow;
    const outflow = onlyAmountFlow?.outflow ?? rawOutflow;
    const transferDirection = type === "transfer" ? (onlyAmountFlow ? "out" : inferTransferDirection(source, inflow, outflow)) : undefined;
    const flow = normalizeFlowFields(
      type,
      onlyAmountFlow?.amount ?? (inflow > 0 ? inflow : outflow || rawAmount),
      inflow,
      outflow,
      transferDirection,
    );

    return {
      rawText: row.join(" "),
      type,
      date,
      postedAt: type === "expense" ? postedAt : "",
      amount: flow.amount,
      outflow: flow.outflow,
      inflow: flow.inflow,
      account: type === "transfer" ? "" : account,
      fromAccount: type === "transfer" ? (majorType === "transfer" ? account : (transferDirection === "in" ? counterAccount : account)) : "",
      toAccount: type === "transfer" ? (majorType === "transfer" ? counterAccount : (transferDirection === "in" ? account : counterAccount)) : "",
      category,
      institution,
      tags,
      remark,
      secondRemark: type === "transfer" ? (secondRemark || remark) : "",
      transferDirection: type === "transfer" && majorType === "transfer" ? "out" : transferDirection,
    };
  }).filter((item) => item.date && item.amount > 0);
}

function normalizeForStorage(item: ParsedItem): ParsedItem {
  const flow = normalizeFlowFields(
    item.type,
    item.amount || 0,
    item.inflow || 0,
    item.outflow || 0,
    item.transferDirection,
  );
  const outflow = flow.outflow;
  const inflow = flow.inflow;
  const amount = flow.amount;
  if (item.type !== "transfer") {
    return {
      ...item,
      amount,
      outflow,
      inflow,
      account: item.account || item.fromAccount || item.toAccount || "",
      fromAccount: "",
      toAccount: "",
      secondRemark: "",
      transferDirection: undefined,
    };
  }

  const billAccount = (item.account || (item.transferDirection === "in" ? item.toAccount : item.fromAccount) || "").trim();
  const counterAccount = (item.transferDirection === "in" ? item.fromAccount : item.toAccount)?.trim() ?? "";
  const isBillInflow = inflow > 0 && outflow <= 0;
  const isBillOutflow = outflow > 0 && inflow <= 0;
  const direction = isBillInflow ? "in" : isBillOutflow ? "out" : item.transferDirection;
  const fromAccount = direction === "in" ? counterAccount : billAccount;
  const toAccount = direction === "in" ? billAccount : counterAccount;

  return {
    ...item,
    type: "transfer",
    amount,
    account: fromAccount,
    fromAccount,
    toAccount,
    secondRemark: item.secondRemark || item.remark || "",
    transferDirection: direction,
  };
}

export default function BatchImportPage() {
  const router = useRouter();
  const { t } = useI18n();
  const formatText = useCallback((key: Parameters<typeof t>[0], values?: Record<string, string | number>) => {
    let text = t(key) as string;
    if (!values) return text;
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }, [t]);
  const replaceFieldLabels = useMemo<Record<ReplaceField, string>>(() => ({
    date: t(replaceFieldLabelKeys.date),
    type: t(replaceFieldLabelKeys.type),
    outflow: t(replaceFieldLabelKeys.outflow),
    inflow: t(replaceFieldLabelKeys.inflow),
    account: t(replaceFieldLabelKeys.account),
    counterAccount: t(replaceFieldLabelKeys.counterAccount),
    category: t(replaceFieldLabelKeys.category),
    institution: t(replaceFieldLabelKeys.institution),
    tags: t(replaceFieldLabelKeys.tags),
    remark: t(replaceFieldLabelKeys.remark),
  }), [t]);
  const templates = useMemo(() => buildTemplates(t), [t]);
  const typeOptions = useMemo(
    () => [
      { value: "", label: t("batchImport.selectType") },
      { value: "expense", label: t("transaction.type.expense") },
      { value: "income", label: t("transaction.type.income") },
      { value: "transfer", label: t("transaction.type.transfer") },
    ],
    [t],
  );
  const getTypeLabel = useCallback(
    (type: ParsedItem["type"]) =>
      type === "income"
        ? t("transaction.type.income")
        : type === "transfer"
          ? t("transaction.type.transfer")
          : type === "investment"
            ? t("transaction.type.investment")
            : t("transaction.type.expense"),
    [t],
  );
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [fundUploadItems, setFundUploadItems] = useState<FundImportUploadItem[]>([]);
  const [fundPreviewItems, setFundPreviewItems] = useState<FundImportPreviewItem[]>([]);
  const [fundRuleRows, setFundRuleRows] = useState<FundRuleEditorRow[]>([]);
  const [fundRulesDirty, setFundRulesDirty] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fundSelected, setFundSelected] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<number, Partial<ParsedItem>>>({});
  const [activeImportKind, setActiveImportKind] = useState<FundImportKind>(null);
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadDebug, setUploadDebug] = useState<string | null>(null);
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([]);
  const [editingCell, setEditingCell] = useState<{ idx: number; field: EditableCell } | null>(null);
  const [activeFilterColumn, setActiveFilterColumn] = useState<FilterColumn | null>(null);
  const [columnFilters, setColumnFilters] = useState<Partial<Record<FilterColumn, string[]>>>({});
  const [showImportErrorsOnly, setShowImportErrorsOnly] = useState(false);
  const [previewCount, setPreviewCount] = useState(INITIAL_PREVIEW_COUNT);

  useEffect(() => {
    try {
      const data = sessionStorage.getItem("batchImportItems");
      const storedItems = data ? JSON.parse(data) as ParsedItem[] : [];
      if (Array.isArray(storedItems) && storedItems.length > 0) {
        setActiveImportKind("normal");
        setItems(storedItems);
        setSelected(new Set(storedItems.map((_, idx) => idx)));
      }
    } catch {
      sessionStorage.removeItem("batchImportItems");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/accounts/internal?balances=false")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok || !Array.isArray(data.accounts)) return;
        setAccountOptions(data.accounts);
      })
      .catch((error) => {
        if (!cancelled) {
          setUploadDebug(formatText("batchImport.accountLoadFailed", { reason: error instanceof Error ? error.message : String(error) }));
        }
      });
    return () => { cancelled = true; };
  }, [formatText]);

  const accountDisplayLabel = useCallback((account: AccountOption) => {
    const institutionName = account.Institution?.shortName?.trim() || account.Institution?.name?.trim();
    return institutionName ? `${institutionName}·${account.name}` : account.name;
  }, []);

  const accountMatchKeys = useCallback((account: AccountOption): string[] => {
    const keys = new Set<string>();
    keys.add(normalizeAccountMatchKey(account.name));
    keys.add(normalizeAccountMatchKey(accountDisplayLabel(account)));
    // Full institution name variant
    const fullInst = account.Institution?.name?.trim();
    if (fullInst) {
      keys.add(normalizeAccountMatchKey(`${fullInst}·${account.name}`));
      keys.add(normalizeAccountMatchKey(`${fullInst}${account.name}`));
    }
    // Short institution name variant
    const shortInst = account.Institution?.shortName?.trim();
    if (shortInst) {
      keys.add(normalizeAccountMatchKey(`${shortInst}·${account.name}`));
      keys.add(normalizeAccountMatchKey(`${shortInst}${account.name}`));
    }
    // Aliases
    if (account.AccountAlias) {
      for (const al of account.AccountAlias) {
        keys.add(normalizeAccountMatchKey(al.alias));
      }
    }
    return Array.from(keys).filter(Boolean);
  }, [accountDisplayLabel]);

  const findMatchedAccountId = useCallback((value: string): string | null => {
    const targetKey = normalizeAccountMatchKey(value);
    if (!targetKey) return null;
    // Exact match first
    for (const account of accountOptions) {
      for (const key of accountMatchKeys(account)) {
        if (key === targetKey) return account.id;
      }
    }
    // Partial match: target contains account key or vice versa
    for (const account of accountOptions) {
      for (const key of accountMatchKeys(account)) {
        if (key && (targetKey.includes(key) || key.includes(targetKey))) {
          // Avoid false positive on very short keys (e.g. "9447" matching "9447" is fine, but "卡" is too short)
          if (key.length >= 3 || targetKey.length >= 3) return account.id;
        }
      }
    }
    return null;
  }, [accountOptions, accountMatchKeys]);

  const accountSmartSelectOptions = useMemo<SmartSelectOption[]>(
    () =>
      accountOptions.map((account) => ({
        id: account.id,
        label: accountDisplayLabel(account),
        subLabel: [account.kind, account.Institution?.name].filter(Boolean).join(" · "),
      })),
    [accountOptions, accountDisplayLabel],
  );
  const accountById = useMemo(() => new Map(accountOptions.map((account) => [account.id, account])), [accountOptions]);

  const accountSelectValue = useCallback((currentValue: string) => {
    const current = currentValue.trim();
    return current ? (findMatchedAccountId(current) ?? `unmatched:${current}`) : "";
  }, [findMatchedAccountId]);

  const accountSmartSelectOptionsFor = useCallback((currentValue: string) => {
    const current = currentValue.trim();
    const matchedId = findMatchedAccountId(current);
    if (!current || matchedId) return accountSmartSelectOptions;
    return [{
      id: `unmatched:${current}`,
      label: formatText("batchImport.unmatchedAccount", { value: current }),
      subLabel: t("batchImport.originalImportedValue"),
    }, ...accountSmartSelectOptions];
  }, [accountSmartSelectOptions, findMatchedAccountId, formatText, t]);

  const accountSelectTextById = useCallback((selectedId: string) => {
    if (!selectedId) return "";
    if (selectedId.startsWith("unmatched:")) return selectedId.slice("unmatched:".length);
    const account = accountById.get(selectedId);
    return account ? accountDisplayLabel(account) : "";
  }, [accountById, accountDisplayLabel]);

  const downloadTemplate = useCallback(async (template: ImportTemplate) => {
    if (template.downloadFormat === "xlsx") {
      const { XLSX, workbook } = await buildTemplateWorkbook(template, t);
      XLSX.writeFile(workbook, template.filename, { compression: true });
      return;
    }
    const csv = `\uFEFF${buildCsv(template)}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = template.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, [t]);

  const requestFundPreview = useCallback(async (
    sourceItems: FundImportUploadItem[],
    ruleRows: FundRuleEditorRow[],
    preserveSelection: boolean,
    fileInfo?: string,
  ) => {
    const { overrides, invalidLabels } = serializeFundRuleOverrides(ruleRows);
    if (invalidLabels.length > 0) {
      setMessage(formatText("batchImport.fundPreview.invalidRules", {
        items: invalidLabels.slice(0, 3).join("、"),
        more: invalidLabels.length > 3 ? t("batchImport.importValidationMore") : "",
      }));
      return false;
    }

    setUploading(true);
    try {
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preview", items: sourceItems, overrides }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: FundImportPreviewItem[] } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      setFundPreviewItems(data.items);
      setFundRuleRows(buildFundRuleEditorRows(data.items));
      setFundRulesDirty(false);
      if (preserveSelection) {
        setFundSelected((prev) => new Set(Array.from(prev).filter((idx) => idx < data.items!.length)));
      } else {
        setFundSelected(new Set());
      }
      setUploadDebug(null);
      setMessage(null);
      return true;
    } catch (error) {
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setUploadDebug(formatText("batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo: fileInfo || "" }));
      setMessage(formatText("batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
      return false;
    } finally {
      setUploading(false);
    }
  }, [formatText, t]);

  const handleNormalCsvFile = useCallback(async (file: File) => {
    const fileInfo = formatText("batchImport.fileInfo", {
      name: file.name,
      type: file.type || t("batchImport.fileTypeUnknown"),
      sizeKb: Math.round(file.size / 1024),
    });
    setActiveImportKind("normal");
    setUploadDebug(formatText("batchImport.fileSelectedStart", { fileInfo }));
    setMessage(formatText("batchImport.readingFileName", { name: file.name }));
    setImportedCount(0);
    setUploading(true);
    setItems([]);
    setFundUploadItems([]);
    setFundPreviewItems([]);
    setFundRuleRows([]);
    setFundRulesDirty(false);
    setDrafts({});
    setSelected(new Set());
    setFundSelected(new Set());
    setColumnFilters({});
    setActiveFilterColumn(null);
    setShowImportErrorsOnly(false);
    setPreviewCount(INITIAL_PREVIEW_COUNT);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const rows = await parseImportFile(file);
      setUploadDebug(formatText("batchImport.rowsRead", { count: rows.length, fileInfo }));
      const parsed = normalRowsToItems(rows);
      if (parsed.length === 0) {
        const headers = rows[0]?.join("、") || t("batchImport.headersNotRead");
        setItems([]);
        setDrafts({});
        setSelected(new Set());
        setFundUploadItems([]);
        setFundPreviewItems([]);
        setFundRuleRows([]);
        setFundSelected(new Set());
        setShowImportErrorsOnly(false);
        setUploadDebug(formatText("batchImport.noRecordsRecognizedDebug", { headers, fileInfo }));
        setMessage(formatText("batchImport.noRecordsRecognizedMessage", { name: file.name, headers }));
        return;
      }
      sessionStorage.setItem("batchImportItems", JSON.stringify(parsed));
      setItems(parsed);
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setDrafts({});
      setSelected(new Set());
      setFundSelected(new Set());
      setEditingCell(null);
      setShowImportErrorsOnly(false);
      setUploadDebug(formatText("batchImport.previewRecognized", { count: parsed.length, fileInfo }));
      setMessage(formatText("batchImport.previewRecognizedMessage", { count: parsed.length }));
    } catch (error) {
      setItems([]);
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setDrafts({});
      setSelected(new Set());
      setFundSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setUploadDebug(formatText("batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo }));
      setMessage(formatText("batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
    } finally {
      setUploading(false);
    }
  }, [formatText, t]);

  const handleFundFile = useCallback(async (file: File) => {
    const fileInfo = formatText("batchImport.fileInfo", {
      name: file.name,
      type: file.type || t("batchImport.fileTypeUnknown"),
      sizeKb: Math.round(file.size / 1024),
    });
    setActiveImportKind("fund");
    setUploadDebug(formatText("batchImport.fileSelectedStart", { fileInfo }));
    setMessage(formatText("batchImport.readingFileName", { name: file.name }));
    setUploading(true);
    setImporting(false);
    setImportedCount(0);
    setItems([]);
    setFundUploadItems([]);
    setDrafts({});
    setSelected(new Set());
    setFundPreviewItems([]);
    setFundRuleRows([]);
    setFundRulesDirty(false);
    setFundSelected(new Set());
    setEditingCell(null);
    setColumnFilters({});
    setActiveFilterColumn(null);
    setShowImportErrorsOnly(false);
    setPreviewCount(INITIAL_PREVIEW_COUNT);

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let previewRequested = false;
    try {
      const rows = await parseImportFile(file);
      const parsed = fundRowsToItems(rows);
      if (parsed.length === 0) {
        setUploadDebug(formatText("batchImport.noRecordsRecognizedDebug", {
          headers: rows[0]?.join("、") || t("batchImport.headersNotRead"),
          fileInfo,
        }));
        setMessage(formatText("batchImport.noRecordsRecognizedMessage", {
          name: file.name,
          headers: rows[0]?.join("、") || t("batchImport.headersNotRead"),
        }));
        return;
      }

      setFundUploadItems(parsed);
      previewRequested = true;
      await requestFundPreview(parsed, [], false, fileInfo);
    } catch (error) {
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setFundSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setUploadDebug(formatText("batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo }));
      setMessage(formatText("batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
    } finally {
      if (!previewRequested) setUploading(false);
    }
  }, [formatText, requestFundPreview, t]);

  const handleApplyFundRules = useCallback(async () => {
    if (fundUploadItems.length === 0 || importing) return;
    await requestFundPreview(fundUploadItems, fundRuleRows, true);
  }, [fundUploadItems, fundRuleRows, importing, requestFundPreview]);

  const openCellEdit = useCallback((idx: number, field: EditableCell) => {
    setEditingCell({ idx, field });
  }, []);

  const closeCellEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  const toggleSelect = useCallback((idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const toggleFundSelect = useCallback((idx: number) => {
    setFundSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const toggleAllFund = useCallback(() => {
    setFundSelected((prev) => {
      const allSelected = fundPreviewItems.length > 0 && fundPreviewItems.every((_, idx) => prev.has(idx));
      if (allSelected) return new Set<number>();
      return new Set(fundPreviewItems.map((_, idx) => idx));
    });
  }, [fundPreviewItems]);


  const updateDraft = useCallback((idx: number, field: string, value: unknown) => {
    setDrafts((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], [field]: value },
    }));
  }, []);

  const getItem = useCallback((idx: number): ParsedItem => {
    const item = items[idx];
    const draft = drafts[idx] ?? {};
    const type = draft.type ?? item.type ?? "expense";
    const transferDirection = draft.transferDirection ?? item.transferDirection;
    const flow = normalizeFlowFields(
      type,
      Number(draft.amount ?? item.amount ?? 0),
      Number(draft.inflow ?? item.inflow ?? 0),
      Number(draft.outflow ?? item.outflow ?? 0),
      transferDirection,
    );
    return {
      ...item,
      ...draft,
      type,
      date: draft.date ?? item.date ?? "",
      account: draft.account ?? item.account ?? "",
      fromAccount: draft.fromAccount ?? item.fromAccount ?? "",
      toAccount: draft.toAccount ?? item.toAccount ?? "",
      amount: flow.amount,
      outflow: flow.outflow,
      inflow: flow.inflow,
      category: draft.category ?? item.category ?? "",
      institution: draft.institution ?? item.institution ?? "",
      tags: draft.tags ?? item.tags ?? "",
      remark: draft.remark ?? item.remark ?? "",
      secondRemark: type === "transfer" ? (draft.secondRemark ?? item.secondRemark ?? item.remark ?? "") : "",
      counterparty: draft.counterparty ?? item.counterparty ?? "",
      transferDirection,
    };
  }, [items, drafts]);

  const getFilterColumnValue = useCallback((idx: number, column: FilterColumn) => {
    const item = getItem(idx);
    const direction = item.transferDirection;
    const account = item.type === "transfer"
      ? (direction === "in" ? item.toAccount : item.fromAccount) || ""
      : item.account || "";
    const counterAccount = item.type === "transfer"
      ? (direction === "in" ? item.fromAccount : item.toAccount) || ""
      : "";
    if (column === "date") return item.date || t("batchImport.emptyValue");
    if (column === "type") return getTypeLabel(item.type);
    if (column === "account") return account.trim() || t("batchImport.emptyValue");
    if (column === "counterAccount") return counterAccount.trim() || t("batchImport.emptyValue");
    return (item.remark || item.counterparty || "").trim() || t("batchImport.emptyValue");
  }, [getItem, getTypeLabel, t]);

  const columnFilterOptions = useMemo(() => {
    if (!activeFilterColumn) return [];
    return Array.from(new Set(items.map((_, idx) => getFilterColumnValue(idx, activeFilterColumn))))
      .sort((a, b) => (a === t("batchImport.emptyValue") ? 1 : b === t("batchImport.emptyValue") ? -1 : a.localeCompare(b, "zh-CN")));
  }, [items, activeFilterColumn, getFilterColumnValue, t]);

  const filteredIndexes = useMemo(() => {
    return items
      .map((_, idx) => idx)
      .filter((idx) => filterColumns.every((column) => {
        const allowedValues = columnFilters[column];
        return !allowedValues?.length || allowedValues.includes(getFilterColumnValue(idx, column));
      }));
  }, [items, columnFilters, getFilterColumnValue]);

  const visibleIndexes = useMemo(() => filteredIndexes.slice(0, previewCount), [filteredIndexes, previewCount]);

  const toggleAllFiltered = useCallback(() => {
    setSelected((prev) => {
      const allFilteredSelected = filteredIndexes.length > 0 && filteredIndexes.every((idx) => prev.has(idx));
      const next = new Set(prev);
      for (const idx of filteredIndexes) {
        if (allFilteredSelected) next.delete(idx);
        else next.add(idx);
      }
      return next;
    });
  }, [filteredIndexes]);

  const batchTargetIndexes = useMemo(() => Array.from(selected).filter((idx) => filteredIndexes.includes(idx)), [selected, filteredIndexes]);

  const accountNameSet = useMemo(() => {
    const set = new Set<string>();
    for (const account of accountOptions) {
      for (const key of accountMatchKeys(account)) {
        set.add(key);
      }
    }
    return set;
  }, [accountOptions, accountMatchKeys]);

  const importIssues = useMemo(() => {
    const issues: ImportIssue[] = [];
    for (const idx of selected) {
      const item = normalizeForStorage(getItem(idx));
      const direction = item.transferDirection ?? ((item.inflow ?? 0) > 0 && (item.outflow ?? 0) <= 0 ? "in" : "out");
      const account = item.type === "transfer"
        ? (direction === "in" ? item.toAccount : item.fromAccount) || ""
        : item.account || "";
      const counterAccount = item.type === "transfer"
        ? (direction === "in" ? item.fromAccount : item.toAccount) || ""
        : "";
      if (!account.trim()) issues.push({ idx, level: "error", message: t("batchImport.issue.accountMissing") });
      else {
        const matchedId = findMatchedAccountId(account);
        if (!matchedId) issues.push({ idx, level: "error", message: formatText("batchImport.issue.accountUnmatched", { account: account.trim() }) });
      }
      if (!Number.isFinite(item.amount) || item.amount <= 0) issues.push({ idx, level: "error", message: t("batchImport.issue.amountInvalid") });
      if (item.type === "transfer" && counterAccount.trim()) {
        const counterMatchedId = findMatchedAccountId(counterAccount);
        if (!counterMatchedId) {
          issues.push({ idx, level: "warning", message: formatText("batchImport.issue.counterAccountUnmatched", { account: counterAccount.trim() }) });
        }
      } else if (item.type === "transfer" && !counterAccount.trim()) {
        issues.push({ idx, level: "warning", message: t("batchImport.issue.counterAccountMissing") });
      }
    }
    return issues;
  }, [selected, getItem, accountNameSet, findMatchedAccountId, formatText, t]);

  const importErrorIssues = useMemo(() => importIssues.filter((issue) => issue.level === "error"), [importIssues]);
  const importWarningIssues = useMemo(() => importIssues.filter((issue) => issue.level === "warning"), [importIssues]);
  const importIssuesByRow = useMemo(() => {
    const map = new Map<number, ImportIssue[]>();
    for (const issue of importIssues) map.set(issue.idx, [...(map.get(issue.idx) ?? []), issue]);
    return map;
  }, [importIssues]);
  const importErrorRowIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const issue of importErrorIssues) set.add(issue.idx);
    return set;
  }, [importErrorIssues]);
  const displayedFilteredIndexes = useMemo(() => {
    const source = showImportErrorsOnly
      ? filteredIndexes.filter((idx) => importErrorRowIndexes.has(idx))
      : filteredIndexes;
    return [...source].sort((a, b) => {
      const aError = importErrorRowIndexes.has(a);
      const bError = importErrorRowIndexes.has(b);
      if (aError !== bError) return aError ? -1 : 1;
      return a - b;
    });
  }, [filteredIndexes, importErrorRowIndexes, showImportErrorsOnly]);
  const displayedVisibleIndexes = useMemo(
    () => displayedFilteredIndexes.slice(0, previewCount),
    [displayedFilteredIndexes, previewCount],
  );
  const importErrorPreviewText = useMemo(() => (
    importErrorIssues
      .slice(0, 6)
      .map((issue) => `第 ${issue.idx + 1} 行：${issue.message}`)
      .join("；")
  ), [importErrorIssues]);

  const fundImportIssues = useMemo(() => (
    Array.from(fundSelected)
      .flatMap((idx) => (fundPreviewItems[idx]?.issues ?? []).map((issue) => ({ idx, ...issue })))
  ), [fundSelected, fundPreviewItems]);
  const fundImportErrorIssues = useMemo(() => fundImportIssues.filter((issue) => issue.level === "error"), [fundImportIssues]);
  const fundImportWarningIssues = useMemo(() => fundImportIssues.filter((issue) => issue.level === "warning"), [fundImportIssues]);
  const fundPreviewWarningGroups = useMemo(() => {
    const grouped = new Map<string, { message: string; count: number; rows: number[] }>();
    fundPreviewItems.forEach((item, idx) => {
      item.issues
        .filter((issue) => issue.level === "warning")
        .forEach((issue) => {
          const current = grouped.get(issue.message);
          if (current) {
            current.count += 1;
            current.rows.push(idx + 1);
          } else {
            grouped.set(issue.message, { message: issue.message, count: 1, rows: [idx + 1] });
          }
        });
    });
    return Array.from(grouped.values()).sort((a, b) => b.count - a.count || a.rows[0] - b.rows[0]);
  }, [fundPreviewItems]);
  const fundPreviewWarningSummary = useMemo(() => {
    if (fundPreviewWarningGroups.length === 0) return "";
    const confirmRuleWarnings = fundPreviewWarningGroups.filter((group) => /^未找到\s+\S+\s+的确认天数配置/.test(group.message));
    if (confirmRuleWarnings.length > 0 && confirmRuleWarnings.length === fundPreviewWarningGroups.length) {
      const items = confirmRuleWarnings.map((group) => {
        const match = group.message.match(/^未找到\s+(\S+)\s+的确认天数配置/);
        return `${match?.[1] ?? group.message}（${group.count}条）`;
      }).join("、");
      return formatText("batchImport.fundPreview.warningMissingConfirmRules", { items });
    }
    const main = fundPreviewWarningGroups
      .slice(0, 2)
      .map((group) => formatText("batchImport.fundPreview.warningCompactItem", {
        message: group.message,
        count: group.count,
      }))
      .join("；");
    const moreCount = fundPreviewWarningGroups.length - 2;
    return moreCount > 0
      ? `${main}；${formatText("batchImport.fundPreview.warningCompactMore", { count: moreCount })}`
      : main;
  }, [fundPreviewWarningGroups, formatText]);

  const applyReplaceToTargets = useCallback((replaceField: ReplaceField, replaceValue: string) => {
    if (batchTargetIndexes.length === 0) throw new Error(t("batchImport.batchReplaceNoTarget"));
    const value = replaceValue.trim();
    if (!value && replaceField !== "counterAccount") throw new Error(t("batchImport.batchReplaceEmptyValue"));

    const nextDrafts = { ...drafts };
    let changed = 0;
    let invalid = 0;

    for (const idx of batchTargetIndexes) {
      const item = { ...getItem(idx), ...(nextDrafts[idx] ?? {}) };
      const patch: Partial<ParsedItem> = {};
      const type = item.type ?? "expense";
      const direction = item.transferDirection ?? ((item.inflow ?? 0) > 0 && (item.outflow ?? 0) <= 0 ? "in" : "out");
      if (replaceField === "date") patch.date = value;
      else if (replaceField === "type") {
        const nextType = value as ParsedItem["type"];
        patch.type = nextType;
        if (nextType === "transfer") patch.transferDirection = direction;
        const flow = normalizeFlowFields(nextType, item.amount ?? 0, item.inflow ?? 0, item.outflow ?? 0, patch.transferDirection ?? direction);
        patch.amount = flow.amount;
        patch.inflow = flow.inflow;
        patch.outflow = flow.outflow;
      } else if (replaceField === "outflow" || replaceField === "inflow") {
        const currentNumber = replaceField === "outflow" ? item.outflow ?? 0 : item.inflow ?? 0;
        const nextNumber = applyNumberExpression(currentNumber, value);
        if (!Number.isFinite(nextNumber)) {
          invalid++;
          continue;
        }
        patch[replaceField] = nextNumber;
        if (type === "transfer" && nextNumber > 0) patch.transferDirection = replaceField === "inflow" ? "in" : "out";
        else if (replaceField === "inflow" && nextNumber > 0) patch.type = "income";
        else if (replaceField === "outflow" && nextNumber > 0) patch.type = "expense";
        const flow = normalizeFlowFields(
          patch.type ?? type,
          nextNumber || 0,
          replaceField === "inflow" ? nextNumber : item.inflow ?? 0,
          replaceField === "outflow" ? nextNumber : item.outflow ?? 0,
          patch.transferDirection ?? direction,
        );
        patch.amount = flow.amount;
        patch.inflow = flow.inflow;
        patch.outflow = flow.outflow;
      } else if (replaceField === "account") {
        patch.account = value;
        if (type === "transfer") {
          if (direction === "in") patch.toAccount = value;
          else patch.fromAccount = value;
        }
      } else if (replaceField === "counterAccount") {
        if (type === "transfer") {
          patch.transferDirection = direction;
          if (direction === "in") patch.fromAccount = value;
          else patch.toAccount = value;
        } else {
          patch.type = "transfer";
          patch.transferDirection = "out";
          patch.fromAccount = item.account || value;
          patch.toAccount = value;
        }
      } else if (replaceField === "institution") patch.institution = value;
      else if (replaceField === "remark") patch.remark = value;
      nextDrafts[idx] = { ...(nextDrafts[idx] ?? {}), ...patch };
      changed++;
    }

    setDrafts(nextDrafts);
    const invalidSuffix = invalid > 0 ? formatText("batchImport.batchReplaceInvalidCount", { count: invalid }) : "";
    const resultMessage = formatText("batchImport.batchReplaceResult", {
      count: changed,
      field: replaceFieldLabels[replaceField],
      invalidSuffix,
    });
    setMessage(resultMessage);
    setEditingCell(null);
    return resultMessage;
  }, [batchTargetIndexes, drafts, formatText, getItem, replaceFieldLabels, t]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(selected);
    const selectedItems = selectedIndexes.map((idx) => normalizeForStorage(getItem(idx)));
    const missingCounterAccountCount = selectedItems.filter((item) => item.type === "transfer" && (!item.fromAccount?.trim() || !item.toAccount?.trim())).length;
    if (importErrorIssues.length > 0) {
      const preview = importErrorIssues
        .slice(0, 5)
        .map((issue) => formatText("batchImport.issueLine", { index: issue.idx + 1, level: issue.level === "error" ? t("batchImport.levelError") : t("batchImport.levelWarning"), message: issue.message }))
        .join("；");
      setMessage(formatText("batchImport.importValidationFailed", {
        count: importErrorIssues.length,
        preview,
        more: importErrorIssues.length > 5 ? t("batchImport.importValidationMore") : "",
      }));
      setUploadDebug(
        importIssues
          .map((issue) => formatText("batchImport.issueLine", { index: issue.idx + 1, level: issue.level === "error" ? t("batchImport.levelError") : t("batchImport.levelWarning"), message: issue.message }))
          .join("\n"),
      );
      return;
    }
    setImporting(true);
    setImportedCount(0);
    setMessage(formatText("batchImport.importingSelected", { count: selectedItems.length }));
    setUploadDebug(null);

    try {
      const res = await fetch("/api/v1/record/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Import": "batch-import" },
        body: JSON.stringify({ items: selectedItems }),
      });
      const data = await res.json().catch(() => null) as { error?: string; createdCount?: number; trace?: string[] } | null;
      if (!res.ok || !data || data.error) {
        setImportedCount(0);
        setImporting(false);
        setMessage(formatText("batchImport.importFailedRollback", { reason: data?.error || res.statusText || `HTTP ${res.status}` }));
        setUploadDebug(data?.trace?.join("\n") ?? data?.error ?? null);
        return;
      }
      const success = data.createdCount ?? selectedItems.length;
      setImportedCount(success);
      setImporting(false);
      setMessage(formatText("batchImport.importSuccess", {
        count: success,
        missingCounterAccountNote: missingCounterAccountCount > 0
          ? formatText("batchImport.importSuccessMissingCounterAccounts", { count: missingCounterAccountCount })
          : "",
        redirectNote: t("batchImport.openingDetailList"),
      }));
    } catch (error) {
      setImportedCount(0);
      setImporting(false);
      setMessage(formatText("batchImport.importFailedRollback", { reason: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (selectedItems.length > 0) {
      setTimeout(() => {
        sessionStorage.removeItem("batchImportItems");
        router.push("/?view=detail");
      }, 1500);
    }
  }, [importing, selected, getItem, router, importErrorIssues, importIssues]);

  const handleFundImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(fundSelected);
    const selectedItems = selectedIndexes.map((idx) => fundPreviewItems[idx]).filter(Boolean);
    if (selectedItems.length === 0) return;

    if (fundImportErrorIssues.length > 0) {
      const preview = fundImportErrorIssues
        .slice(0, 5)
        .map((issue) => formatText("batchImport.issueLine", {
          index: issue.idx + 1,
          level: t("batchImport.levelError"),
          message: issue.message,
        }))
        .join("；");
      setMessage(formatText("batchImport.importValidationFailed", {
        count: fundImportErrorIssues.length,
        preview,
        more: fundImportErrorIssues.length > 5 ? t("batchImport.importValidationMore") : "",
      }));
      setUploadDebug(
        fundImportIssues
          .map((issue) => formatText("batchImport.issueLine", {
            index: issue.idx + 1,
            level: issue.level === "error" ? t("batchImport.levelError") : t("batchImport.levelWarning"),
            message: issue.message,
          }))
          .join("\n"),
      );
      return;
    }

    setImporting(true);
    setMessage(formatText("batchImport.fundImportingSelected", { count: selectedItems.length }));
    setUploadDebug(null);

    try {
      const { overrides, invalidLabels } = serializeFundRuleOverrides(fundRuleRows);
      if (invalidLabels.length > 0) {
        throw new Error(formatText("batchImport.fundPreview.invalidRules", {
          items: invalidLabels.slice(0, 3).join("、"),
          more: invalidLabels.length > 3 ? t("batchImport.importValidationMore") : "",
        }));
      }
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "import", items: selectedItems, overrides }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      const success = data.createdCount ?? selectedItems.length;
      setMessage(formatText("batchImport.fundImportSuccess", {
        count: success,
        redirectNote: t("batchImport.openingInvestmentList"),
      }));
      setTimeout(() => {
        setFundUploadItems([]);
        setFundPreviewItems([]);
        setFundRuleRows([]);
        setFundRulesDirty(false);
        setFundSelected(new Set());
        setActiveImportKind(null);
        router.push("/?view=invest");
      }, 1500);
    } catch (error) {
      setMessage(formatText("batchImport.importFailedRollback", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setImporting(false);
    }
  }, [importing, fundSelected, fundPreviewItems, fundImportErrorIssues, fundImportIssues, fundRuleRows, formatText, t, router]);

  const handleCancel = useCallback(() => {
    sessionStorage.removeItem("batchImportItems");
    setActiveImportKind(null);
    setImporting(false);
    setUploading(false);
    setImportedCount(0);
    setItems([]);
    setFundUploadItems([]);
    setFundPreviewItems([]);
    setFundRuleRows([]);
    setFundRulesDirty(false);
    setSelected(new Set());
    setFundSelected(new Set());
    setDrafts({});
    setEditingCell(null);
    setActiveFilterColumn(null);
    setColumnFilters({});
    setShowImportErrorsOnly(false);
    setMessage(null);
    setUploadDebug(null);
  }, []);

  const renderColumnFilter = (column: FilterColumn, label: string) => {
    const selectedValues = columnFilters[column] ?? [];
    const isOpen = activeFilterColumn === column;
    const options = isOpen ? columnFilterOptions : [];

    return (
      <TableColumnFilter
        label={label}
        options={options}
        selectedValues={selectedValues}
        open={isOpen}
        onToggleOpen={() => setActiveFilterColumn((current) => current === column ? null : column)}
        onClose={() => setActiveFilterColumn(null)}
        onChange={(values) => setColumnFilters((prev) => ({ ...prev, [column]: values }))}
      />
    );
  };

  const accountReplaceOptions = useMemo<BatchReplaceOption[]>(() => [
    { value: "", label: t("batchImport.unselected") },
    ...accountOptions.map((account) => {
      const label = accountDisplayLabel(account);
      return { value: label, label };
    }),
  ], [accountOptions, accountDisplayLabel, t]);

  const replaceFields = useMemo<BatchReplaceFieldConfig<ReplaceField>[]>(() => [
    { value: "date", label: replaceFieldLabels.date, kind: "date" },
    {
      value: "type",
      label: replaceFieldLabels.type,
      kind: "select",
      options: typeOptions,
    },
    { value: "outflow", label: replaceFieldLabels.outflow, kind: "number", placeholder: t("batchImport.numberExpressionPlaceholder") },
    { value: "inflow", label: replaceFieldLabels.inflow, kind: "number", placeholder: t("batchImport.numberExpressionPlaceholder") },
    { value: "account", label: replaceFieldLabels.account, kind: "smartSelect", options: accountReplaceOptions },
    { value: "counterAccount", label: replaceFieldLabels.counterAccount, kind: "smartSelect", options: accountReplaceOptions, allowEmpty: true },
    { value: "institution", label: replaceFieldLabels.institution, kind: "text", placeholder: t("batchImport.institutionPlaceholder") },
    { value: "remark", label: replaceFieldLabels.remark, kind: "text", placeholder: t("batchImport.replaceContentPlaceholder") },
  ], [accountReplaceOptions, replaceFieldLabels, t, typeOptions]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-800">{t("batchImport.pageTitle")}</h1>
          {items.length > 0 && (
            <span className="text-sm text-slate-500">
              {formatText("batchImport.selectedSummary", { selected: selected.size, total: items.length })}
              {importErrorIssues.length > 0 && <span className="ml-2 font-medium text-red-600">{formatText("batchImport.errorCount", { count: importErrorIssues.length })}</span>}
              {importWarningIssues.length > 0 && <span className="ml-2 font-medium text-amber-600">{formatText("batchImport.warningCount", { count: importWarningIssues.length })}</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-md"
            >
              {t("batchImport.clear")}
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={handleImport}
              disabled={importing || selected.size === 0 || importErrorIssues.length > 0}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? t("batchImport.importing") : formatText("batchImport.confirmImport", { count: selected.size })}
            </button>
          )}
        </div>
      </div>

      {activeImportKind !== "fund" && message && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700 text-sm">
          {message}
        </div>
      )}

      {activeImportKind !== "fund" && uploadDebug && (
        <div className="mx-4 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-sm">
          <div className="font-medium">{t("batchImport.uploadDebugTitle")}</div>
          <div className="mt-1 break-all">{uploadDebug}</div>
        </div>
      )}

      {uploading && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700 text-sm">
          {t("batchImport.loadingOverlay")}
        </div>
      )}

      {importedCount > 0 && (
        <div className="mx-4 mt-4 p-3 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm">
          {formatText("batchImport.importSuccessRedirect", { count: importedCount })}
        </div>
      )}

      <div className="p-4 space-y-4">
        <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {templates.map((template) => (
            <div key={template.key} className="bg-white rounded-lg border border-slate-200 p-4 flex flex-col gap-3">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-semibold text-slate-800">{template.title}</h2>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{template.status}</span>
                </div>
                <p className="mt-2 text-sm text-slate-500 leading-6">{template.description}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => downloadTemplate(template)}
                  className="px-3 py-1.5 text-sm rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                >
                  {template.downloadFormat === "xlsx" ? t("batchImport.downloadXlsxTemplate") : t("batchImport.downloadCsvTemplate")}
                </button>
                {template.key === "normal" && (
                  <label className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer inline-flex items-center">
                    {t("batchImport.uploadBillFile")}
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="sr-only"
                      onClick={() => {
                        setUploadDebug(t("batchImport.uploadControlClicked"));
                        setMessage(t("batchImport.filePickerOpened"));
                      }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          setUploadDebug(t("batchImport.filePickerClosedNoFile"));
                          setMessage(t("batchImport.noFileSelected"));
                          return;
                        }
                        void handleNormalCsvFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                )}
                {template.key === "fund" && (
                  <label className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer inline-flex items-center">
                    {t("batchImport.uploadFundFile")}
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="sr-only"
                      onClick={() => {
                        setUploadDebug(t("batchImport.uploadControlClicked"));
                        setMessage(t("batchImport.filePickerOpened"));
                      }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          setUploadDebug(t("batchImport.filePickerClosedNoFile"));
                          setMessage(t("batchImport.noFileSelected"));
                          return;
                        }
                        void handleFundFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
              <div className="text-xs text-slate-500">
                <div className="mb-1 font-medium text-slate-600">{t("batchImport.fieldNotes")}</div>
                <div className="space-y-1">
                  {template.fields.map((field) => (
                    <div key={field.name}>
                      <span className="font-mono text-slate-700">{field.name}</span>
                      {field.label && field.label !== field.name && <span className="ml-1 text-slate-500">({field.label})</span>}
                      {field.required && <span className="ml-1 text-red-500">{t("batchImport.required")}</span>}
                      <span className="ml-1">{field.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-6 text-sm text-slate-600 leading-7">
          <h2 className="text-base font-semibold text-slate-800 mb-2">{t("batchImport.guideTitle")}</h2>
          <p>{t("batchImport.guide.currentSupport")}</p>
          <p>{t("batchImport.guide.fundSubtypeSource")}</p>
          <p>{t("batchImport.guide.normalBill")}</p>
        </section>
      </div>

      {activeImportKind === "normal" && (items.length > 0 || uploading) && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4 flex items-center justify-center">
          <div className="w-full max-w-7xl h-[82vh] bg-white rounded-xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="shrink-0 px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-800">{t("batchImport.previewTitle")}</div>
                <div className="text-xs text-slate-500 mt-1">{uploading ? t("batchImport.previewParsing") : t("batchImport.previewHint").replace("{count}", String(items.length))}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-md"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleImport}
                  disabled={uploading || importing || selected.size === 0 || importErrorIssues.length > 0}
                  className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importing ? t("batchImport.importing") : t("batchImport.confirmImport").replace("{count}", String(selected.size))}
                </button>
              </div>
            </div>
            {message && (
              <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                {message}
              </div>
            )}
            {uploadDebug && (
              <div className="shrink-0 max-h-24 overflow-auto border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 whitespace-pre-wrap">
                {uploadDebug}
              </div>
            )}
            <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-medium text-slate-700">{t("batchImport.filterResult")}</span>
                <span>{formatText("batchImport.filteredCount", { filtered: displayedFilteredIndexes.length, total: items.length })}</span>
                {importErrorIssues.length > 0 && (
                  <span className="rounded bg-red-50 px-2 py-0.5 font-medium text-red-700">
                    阻断错误 {importErrorIssues.length} 条，已置顶
                  </span>
                )}
                <span className="text-slate-400">{t("batchImport.filterHint")}</span>
                {importErrorIssues.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowImportErrorsOnly((value) => !value);
                      setPreviewCount(INITIAL_PREVIEW_COUNT);
                    }}
                    className="h-8 px-2 rounded border border-red-200 bg-white text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    {showImportErrorsOnly ? "显示全部" : "只看错误"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setActiveFilterColumn(null);
                    setColumnFilters({});
                    setShowImportErrorsOnly(false);
                  }}
                  className="ml-auto h-8 px-2 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                >
                  {t("batchImport.clearAllFilters")}
                </button>
              </div>
              {importErrorIssues.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <div className="font-semibold">确认导入按钮灰掉，是因为选中记录里还有阻断错误。</div>
                  <div className="mt-1 leading-5">
                    {importErrorPreviewText}
                    {importErrorIssues.length > 6 ? `；还有 ${importErrorIssues.length - 6} 条` : ""}
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-xs border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="w-24 px-2 py-1 text-left">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={displayedFilteredIndexes.length > 0 && displayedFilteredIndexes.every((idx) => selected.has(idx))}
                        onChange={toggleAllFiltered}
                        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
                        title={t("batchImport.selectFiltered")}
                      />
                      <BatchReplacePopoverButton
                        fields={replaceFields}
                        targetCount={batchTargetIndexes.length}
                        targetLabel={t("batchImport.selectedTargetLabel")}
                        panelAlign="left"
                        disabledTitle={t("batchImport.selectFirstHint")}
                        buttonTitle={formatText("batchImport.batchEditTitle", { count: batchTargetIndexes.length })}
                        messageClassName="sr-only"
                        onApply={applyReplaceToTargets}
                      />
                    </div>
                  </th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("date", t("batchImport.field.date"))}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("type", t("batchImport.field.type"))}</th>
                  <th className="px-2 py-1 text-right text-xs font-medium text-slate-600">{t("batchImport.field.outflow")}</th>
                  <th className="px-2 py-1 text-right text-xs font-medium text-slate-600">{t("batchImport.field.inflow")}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("account", t("batchImport.field.account"))}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("counterAccount", t("batchImport.field.counterAccount"))}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{t("batchImport.field.category")}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{t("batchImport.field.tags")}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("remark", t("batchImport.field.remark"))}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {uploading ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-sm text-blue-600">
                      {t("batchImport.previewParsing")}
                    </td>
                  </tr>
                ) : displayedFilteredIndexes.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">
                      {t("batchImport.noRecordsForFilter")}
                    </td>
                  </tr>
                ) : displayedVisibleIndexes.map((idx) => {
                  const item = items[idx];
                  const draft = drafts[idx] ?? {};
                  const date = draft.date ?? item.date ?? "";
                  const type = draft.type ?? item.type ?? "expense";
                  const direction = draft.transferDirection ?? item.transferDirection;
                  const flow = normalizeFlowFields(
                    type,
                    Number(draft.amount ?? item.amount ?? 0),
                    Number(draft.inflow ?? item.inflow ?? 0),
                    Number(draft.outflow ?? item.outflow ?? 0),
                    direction,
                  );
                  const amount = flow.amount;
                  const outflow = flow.outflow;
                  const inflow = flow.inflow;
                  const account = type === "transfer"
                    ? (direction === "in" ? (draft.toAccount ?? item.toAccount ?? "") : (draft.fromAccount ?? item.fromAccount ?? ""))
                    : (draft.account ?? item.account ?? "");
                  const counterAccount = type === "transfer"
                    ? (direction === "in" ? (draft.fromAccount ?? item.fromAccount ?? "") : (draft.toAccount ?? item.toAccount ?? ""))
                    : "";
                  const category = draft.category ?? item.category ?? "";
                  const institution = draft.institution ?? item.institution ?? "";
                  const tags = draft.tags ?? item.tags ?? "";
                  const remark = draft.remark ?? item.remark ?? item.counterparty ?? "";
                  const isSelected = selected.has(idx);
                  const editingField = editingCell?.idx === idx ? editingCell.field : null;
                  const typeLabel = getTypeLabel(type);
                  const rowIssues = importIssuesByRow.get(idx) ?? [];
                  const rowHasError = rowIssues.some((issue) => issue.level === "error");
                  const rowHasWarning = rowIssues.some((issue) => issue.level === "warning");

                  return (
                    <tr key={idx} className={`${isSelected ? "" : "opacity-50"} ${rowHasError ? "bg-red-50" : rowHasWarning ? "bg-amber-50" : ""}`}>
                      <td className="px-2 py-1">
                        <span className="inline-flex h-3.5 items-center gap-1 align-middle">
                          {rowIssues.length > 0 ? (
                            <span
                              className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white ${rowHasError ? "bg-red-500" : "bg-amber-500"}`}
                              title={rowIssues.map((issue) => issue.message).join("；")}
                            >
                              !
                            </span>
                          ) : (
                            <span className="h-3.5 w-3.5" />
                          )}
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(idx)}
                            className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
                          />
                        </span>
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "date")} title={t("batchImport.doubleClickToEdit")}>
                        {editingField === "date" ? (
                          <input
                            type="date"
                            value={date}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => updateDraft(idx, "date", e.target.value)}
                            className="h-6 w-28 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          />
                        ) : date}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-slate-700" onDoubleClick={() => openCellEdit(idx, "type")} title={t("batchImport.doubleClickToEdit")}>
                        {editingField === "type" ? (
                          <select
                            value={type}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => {
                              const nextType = e.target.value as ParsedItem["type"];
                              updateDraft(idx, "type", nextType);
                              if (nextType === "transfer") updateDraft(idx, "transferDirection", inflow > 0 && outflow <= 0 ? "in" : "out");
                            }}
                            className="h-6 w-20 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          >
                            <option value="expense">{t("transaction.type.expense")}</option>
                            <option value="income">{t("transaction.type.income")}</option>
                            <option value="transfer">{t("transaction.type.transfer")}</option>
                          </select>
                        ) : typeLabel}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-right text-xs tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "outflow")} title={t("batchImport.doubleClickToEdit")}>
                        {editingField === "outflow" ? (
                          <input
                            type="number"
                            value={outflow || ""}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => {
                              const next = parseFloat(e.target.value) || 0;
                              updateDraft(idx, "outflow", next);
                              updateDraft(idx, "amount", next || 0);
                              if (type === "transfer" && next > 0) updateDraft(idx, "transferDirection", "out");
                              else if (next > 0) updateDraft(idx, "type", "expense");
                            }}
                            className="h-6 w-24 px-1.5 text-xs text-right border border-blue-300 rounded focus:outline-none tabular-nums"
                            step="0.01"
                          />
                        ) : (outflow ? outflow.toFixed(2) : "-")}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-right text-xs tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "inflow")} title={t("batchImport.doubleClickToEdit")}>
                        {editingField === "inflow" ? (
                          <input
                            type="number"
                            value={inflow || ""}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => {
                              const next = parseFloat(e.target.value) || 0;
                              updateDraft(idx, "inflow", next);
                              updateDraft(idx, "amount", next || 0);
                              if (type === "transfer" && next > 0) updateDraft(idx, "transferDirection", "in");
                              else if (next > 0) updateDraft(idx, "type", "income");
                            }}
                            className="h-6 w-24 px-1.5 text-xs text-right border border-blue-300 rounded focus:outline-none tabular-nums"
                            step="0.01"
                          />
                        ) : (inflow ? inflow.toFixed(2) : "-")}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-slate-700" onDoubleClick={() => openCellEdit(idx, "account")} title={t("batchImport.doubleClickToEdit")}>
                        {editingField === "account" ? (
                          <div className="w-80">
                            <SmartSelect
                              mode="single"
                              value={accountSelectValue(account)}
                              onChange={(selectedId) => {
                                const value = accountSelectTextById(selectedId);
                                updateDraft(idx, "account", value);
                                if (type === "transfer") {
                                  if (direction === "in") updateDraft(idx, "toAccount", value);
                                  else updateDraft(idx, "fromAccount", value);
                                }
                                closeCellEdit();
                              }}
                              options={accountSmartSelectOptionsFor(account)}
                              placeholder={t("batchImport.unselected")}
                              behavior={{ hierarchy: false, search: true, clearable: true }}
                            />
                          </div>
                        ) : (account || <span className="text-red-500">{t("batchImport.unrecognized")}</span>)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-slate-700" onDoubleClick={() => openCellEdit(idx, "counterAccount")} title={t("batchImport.doubleClickToEdit")}>
                        {editingField === "counterAccount" ? (
                          <div className="w-80">
                            <SmartSelect
                              mode="single"
                              value={accountSelectValue(counterAccount)}
                              onChange={(selectedId) => {
                                const value = accountSelectTextById(selectedId);
                                if (direction === "in") updateDraft(idx, "fromAccount", value);
                                else updateDraft(idx, "toAccount", value);
                                if (value.trim()) updateDraft(idx, "type", "transfer");
                                closeCellEdit();
                              }}
                              options={accountSmartSelectOptionsFor(counterAccount)}
                              placeholder={t("batchImport.unselected")}
                              behavior={{ hierarchy: false, search: true, clearable: true }}
                            />
                          </div>
                        ) : (counterAccount || <span className="text-slate-400">-</span>)}
                      </td>
                      <td className="max-w-[180px] truncate px-2 py-1 text-xs text-slate-700" title={category || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "category")}>
                        {editingField === "category" ? (
                          <input
                            type="text"
                            value={category}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => updateDraft(idx, "category", e.target.value)}
                            placeholder={t("batchImport.categoryPlaceholder")}
                            className="h-6 w-36 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          />
                        ) : (category || <span className="text-slate-400">-</span>)}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1 text-xs text-slate-700" title={tags || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "tags")}>
                        {editingField === "tags" ? (
                          <input
                            type="text"
                            value={tags}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => updateDraft(idx, "tags", e.target.value)}
                            placeholder={t("batchImport.tagsPlaceholder")}
                            className="h-6 w-44 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          />
                        ) : (tags || <span className="text-slate-400">-</span>)}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1 text-xs text-slate-700" title={remark || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "remark")}>
                        {editingField === "remark" ? (
                          <input
                            type="text"
                            value={remark}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => updateDraft(idx, "remark", e.target.value)}
                            placeholder={t("batchImport.remarkPlaceholder")}
                            className="h-6 w-48 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          />
                        ) : (remark || <span className="text-slate-400">-</span>)}
                      </td>
                    </tr>
                  );
                })}
                {!uploading && displayedFilteredIndexes.length > displayedVisibleIndexes.length && (
                  <tr>
                    <td colSpan={12} className="px-4 py-2 text-center text-xs text-slate-500">
                      {formatText("batchImport.currentVisibleCount", { visible: displayedVisibleIndexes.length, total: displayedFilteredIndexes.length })}
                      <button
                        type="button"
                        onClick={() => setPreviewCount((count) => count + PREVIEW_COUNT_STEP)}
                        className="ml-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                      >
                        {formatText("batchImport.loadMore", { count: Math.min(PREVIEW_COUNT_STEP, displayedFilteredIndexes.length - displayedVisibleIndexes.length) })}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}

      {activeImportKind === "fund" && (fundPreviewItems.length > 0 || uploading) && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4 flex items-center justify-center">
          <div className="w-full max-w-7xl h-[82vh] bg-white rounded-xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="shrink-0 px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-800">{t("batchImport.previewFundTitle")}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {uploading ? t("batchImport.previewParsing") : formatText("batchImport.previewFundHint", { count: fundPreviewItems.length })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-md"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleFundImport}
                  disabled={uploading || importing || fundSelected.size === 0 || fundImportErrorIssues.length > 0}
                  className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importing ? t("batchImport.importing") : formatText("batchImport.confirmImport", { count: fundSelected.size })}
                </button>
              </div>
            </div>
            {message && (
              <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                {message}
              </div>
            )}
            {uploadDebug && (
              <div className="shrink-0 max-h-24 overflow-auto border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 whitespace-pre-wrap">
                {uploadDebug}
              </div>
            )}
            <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span className="font-medium text-slate-700">{formatText("batchImport.selectedSummary", { selected: fundSelected.size, total: fundPreviewItems.length })}</span>
                {fundImportErrorIssues.length > 0 && (
                  <span className="font-medium text-red-600">{formatText("batchImport.errorCount", { count: fundImportErrorIssues.length })}</span>
                )}
                {fundImportWarningIssues.length > 0 && (
                  <span className="font-medium text-amber-600">{formatText("batchImport.warningCount", { count: fundImportWarningIssues.length })}</span>
                )}
              </div>
              {fundRuleRows.length > 0 && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                    <div className="text-xs font-medium text-slate-700">{t("batchImport.fundPreview.ruleEditorTitle")}</div>
                    <button
                      type="button"
                      onClick={handleApplyFundRules}
                      disabled={uploading || importing || fundRuleRows.length === 0}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {fundRulesDirty ? t("batchImport.fundPreview.applyRulesDirty") : t("batchImport.fundPreview.applyRules")}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-auto">
                    <div className="grid grid-cols-[minmax(140px,1.2fr)_96px_minmax(160px,1fr)_110px_110px] gap-x-3 gap-y-2 px-3 py-2 text-[11px] text-slate-500">
                      <div>{t("batchImport.template.fund.label.fundAccount")}</div>
                      <div>{t("batchImport.template.fund.label.fundCode")}</div>
                      <div>{t("batchImport.template.fund.label.fundName")}</div>
                      <div>{t("batchImport.fundPreview.confirmRuleHeader")}</div>
                      <div>{t("batchImport.fundPreview.arrivalRuleHeader")}</div>
                    </div>
                    <div className="space-y-2 border-t border-slate-100 px-3 py-2">
                      {fundRuleRows.map((row) => (
                        <div key={row.key} className="grid grid-cols-[minmax(140px,1.2fr)_96px_minmax(160px,1fr)_110px_110px] items-center gap-x-3 gap-y-2">
                          <div className="truncate text-xs text-slate-700" title={row.fundAccount}>{row.fundAccount}</div>
                          <div className="text-xs tabular-nums text-slate-700">{row.fundCode}</div>
                          <div className="truncate text-xs text-slate-700" title={row.fundName}>{row.fundName}</div>
                          <label className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            <span>T+</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={row.confirmDays}
                              onChange={(event) => {
                                const value = event.target.value;
                                setFundRuleRows((prev) => prev.map((item) => item.key === row.key ? { ...item, confirmDays: value } : item));
                                setFundRulesDirty(true);
                              }}
                              className="w-full bg-transparent text-right tabular-nums text-slate-700 outline-none"
                            />
                          </label>
                          <label className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            <span>T+</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={row.arrivalDays}
                              onChange={(event) => {
                                const value = event.target.value;
                                setFundRuleRows((prev) => prev.map((item) => item.key === row.key ? { ...item, arrivalDays: value } : item));
                                setFundRulesDirty(true);
                              }}
                              className="w-full bg-transparent text-right tabular-nums text-slate-700 outline-none"
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {fundPreviewWarningSummary && (
                <div className="mt-2 text-xs text-amber-700">
                  <span className="font-medium text-amber-800">{t("batchImport.fundPreview.warningSummaryTitle")}</span>
                  <span className="ml-1">{fundPreviewWarningSummary}</span>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-xs border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="w-16 px-2 py-1 text-left">
                      <span className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={fundPreviewItems.length > 0 && fundPreviewItems.every((_, idx) => fundSelected.has(idx))}
                          onChange={toggleAllFund}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
                        />
                      </span>
                    </th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.date")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.fundSubtype")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.source")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.cashAccount")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.fundAccount")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.fundCode")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.fundName")}</th>
                    <th className="px-2 py-1 text-right font-medium text-slate-600">{t("batchImport.template.fund.label.amount")}</th>
                    <th className="px-2 py-1 text-right font-medium text-slate-600">{t("batchImport.fundPreview.feeRate")}</th>
                    <th className="px-2 py-1 text-right font-medium text-slate-600">{t("batchImport.template.fund.label.fee")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.confirmDate")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.arrivalDate")}</th>
                    <th className="px-2 py-1 text-left font-medium text-slate-600">{t("batchImport.template.fund.label.remark")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {uploading ? (
                    <tr>
                      <td colSpan={14} className="px-4 py-8 text-center text-sm text-blue-600">
                        {t("batchImport.previewParsing")}
                      </td>
                    </tr>
                  ) : fundPreviewItems.length === 0 ? (
                    <tr>
                      <td colSpan={14} className="px-4 py-8 text-center text-sm text-slate-500">
                        {t("batchImport.noRecordsForFilter")}
                      </td>
                    </tr>
                  ) : fundPreviewItems.map((item, idx) => {
                    const rowHasError = item.issues.some((issue) => issue.level === "error");
                    const rowHasWarning = item.issues.some((issue) => issue.level === "warning");
                    const rowIssues = item.issues.map((issue) => issue.message).join("；");
                    return (
                      <tr key={`${item.rawText}-${idx}`} className={`${fundSelected.has(idx) ? "" : "opacity-50"} ${rowHasError ? "bg-red-50" : rowHasWarning ? "bg-amber-50" : ""}`}>
                        <td className="px-2 py-1">
                          <span className="inline-flex h-3.5 items-center gap-1 align-middle">
                            {item.issues.length > 0 ? (
                              <span
                                className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white ${rowHasError ? "bg-red-500" : "bg-amber-500"}`}
                                title={rowIssues}
                              >
                                !
                              </span>
                            ) : (
                              <span className="h-3.5 w-3.5" />
                            )}
                            <input
                              type="checkbox"
                              checked={fundSelected.has(idx)}
                              onChange={() => toggleFundSelect(idx)}
                              className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
                            />
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-2 py-1 tabular-nums text-slate-700">{item.date || "-"}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-slate-700">{getFundImportSubtypeLabel(item.fundSubtype, item.source, t)}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-slate-700">{getFundImportSourceLabel(item.source, t)}</td>
                        <td className="max-w-[160px] truncate px-2 py-1 text-slate-700" title={item.cashAccount || ""}>{item.cashAccount || "-"}</td>
                        <td className="max-w-[160px] truncate px-2 py-1 text-slate-700" title={item.fundAccount || ""}>{item.fundAccount || "-"}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-slate-700">{item.fundCode || "-"}</td>
                        <td className="max-w-[180px] truncate px-2 py-1 text-slate-700" title={item.fundName || ""}>{item.fundName || "-"}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-700">{formatOptionalNumber(item.amount, 2)}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-700">{item.feeRate != null ? `${item.feeRate.toFixed(4)}%` : "-"}</td>
                        <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-700">{formatOptionalNumber(item.fee, 2)}</td>
                        <td className="whitespace-nowrap px-2 py-1 tabular-nums text-slate-700">{item.confirmDate || "-"}</td>
                        <td className="whitespace-nowrap px-2 py-1 tabular-nums text-slate-700">{item.arrivalDate || "-"}</td>
                        <td className="max-w-[180px] truncate px-2 py-1 text-slate-700" title={item.remark || ""}>{item.remark || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
