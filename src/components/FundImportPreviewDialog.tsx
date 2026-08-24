"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkBook } from "xlsx";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import {
  buildAccountDisplayOption,
  formatAccountTableLabel,
  formatAccountTableTitle,
  type AccountDisplayOption,
} from "@/lib/account-display";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { fetchSettingsBootstrap } from "@/lib/client/settingsCache";
import { addTradingDaysUtc } from "@/lib/date-utils";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { useI18n } from "@/lib/i18n";

export type FundImportDialogContext = {
  fundAccountId?: string;
  fundAccount?: string;
  fundCode?: string;
  fundName?: string;
};

type FundImportUploadItem = {
  rawText: string;
  date: string;
  fundSubtype: string;
  cashAccount: string;
  fundAccount: string;
  fundCode: string;
  amount: number;
  units: number | null;
  nav: number | null;
  fee: number | null;
  feeRateInput?: number | null;
  confirmDate: string | null;
  arrivalDate: string | null;
  remark: string;
};

type FundImportHeaderField = Exclude<keyof FundImportUploadItem, "rawText">;

type FundImportPreviewIssue = {
  level: "error" | "warning";
  code?: string;
  message: string;
};

type FundImportPreviewItem = FundImportUploadItem & {
  source: string;
  fundName: string | null;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  issues: FundImportPreviewIssue[];
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

type FundPreviewTableRow = FundImportPreviewItem & { idx: number };
type FundPreviewEditField = "fee" | "confirmDate" | "arrivalDate";
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

type FundPreviewAccount = {
  id: string;
  name: string;
  kind: string;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  fundUnitsDecimals?: number | null;
  tradingCalendar?: string | null;
  Institution?: { id?: string | null; name?: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name?: string | null } | null;
};

type FundImportFileParseResult = {
  rows: string[][];
  sourceDataRowCount: number;
  workbook?: {
    sheetCount: number;
    includedSheetCount: number;
  };
};

type Props = {
  open: boolean;
  file: File | null;
  context?: FundImportDialogContext | null;
  onClose: () => void;
  onImported?: (result: { count: number; accountIds: string[] }) => void;
};

const FUND_CANONICAL_HEADERS = [
  "date",
  "fundSubtype",
  "cashAccount",
  "fundAccount",
  "fundCode",
  "amount",
  "feeRateInput",
  "fee",
  "nav",
  "units",
  "confirmDate",
  "arrivalDate",
  "remark",
] as const;

const FUND_LABEL_HEADER_SET = new Set([
  "\u65e5\u671f",
  "\u57fa\u91d1\u52a8\u4f5c",
  "\u8d44\u91d1\u8d26\u6237",
  "\u57fa\u91d1\u8d26\u6237",
  "\u57fa\u91d1\u4ee3\u7801",
  "\u91d1\u989d",
  "\u624b\u7eed\u8d39\u7387",
  "\u624b\u7eed\u8d39",
  "\u51c0\u503c",
  "\u4efd\u989d",
  "\u51c0\u503c\u65e5\u671f",
  "\u5165\u8d26\u65e5\u671f",
  "\u5907\u6ce8",
]);

const FUND_FIELD_ALIASES: Record<FundImportHeaderField, string[]> = {
  date: ["date", "\u65e5\u671f", "\u4ea4\u6613\u65e5\u671f", "\u7533\u8bf7\u65e5\u671f", "Date", "\u65e5\u4ed8"],
  fundSubtype: ["fundSubtype", "\u57fa\u91d1\u52a8\u4f5c", "\u57fa\u91d1\u7c7b\u578b", "\u52a8\u4f5c", "Fund Action", "Action", "\u57fa\u91d1\u30a2\u30af\u30b7\u30e7\u30f3", "\u30d5\u30a1\u30f3\u30c9\u64cd\u4f5c", "cash dividend", "dividend reinvest", "\u73fe\u91d1\u5206\u914d", "\u5206\u914d\u91d1\u518d\u6295\u8cc7"],
  cashAccount: ["cashAccount", "\u8d44\u91d1\u8d26\u6237", "\u73b0\u91d1\u8d26\u6237", "\u4ed8\u6b3e\u8d26\u6237", "cash account", "Cash Account", "\u8cc7\u91d1\u53e3\u5ea7"],
  fundAccount: ["fundAccount", "\u57fa\u91d1\u8d26\u6237", "\u6295\u8d44\u8d26\u6237", "account", "fund account", "Fund Account", "\u30d5\u30a1\u30f3\u30c9\u53e3\u5ea7"],
  fundCode: ["fundCode", "\u57fa\u91d1\u4ee3\u7801", "\u4ee3\u7801", "fund code", "Fund Code", "\u30d5\u30a1\u30f3\u30c9\u30b3\u30fc\u30c9", "\u57fa\u91d1\u30b3\u30fc\u30c9"],
  amount: ["amount", "\u91d1\u989d", "\u53d1\u751f\u91d1\u989d", "Amount", "\u91d1\u984d"],
  feeRateInput: ["feeRateInput", "feeRate", "\u624b\u7eed\u8d39\u7387", "\u8d39\u7387", "Fee Rate", "Fee Rate (%)", "\u624b\u6570\u6599\u7387"],
  fee: ["fee", "\u624b\u7eed\u8d39", "Fee", "\u624b\u6570\u6599"],
  nav: ["nav", "\u51c0\u503c", "\u6210\u4ea4\u51c0\u503c", "NAV", "\u57fa\u6e96\u4fa1\u984d"],
  units: ["units", "\u4efd\u989d", "\u786e\u8ba4\u4efd\u989d", "Units", "\u53e3\u6570"],
  confirmDate: ["confirmDate", "\u786e\u8ba4\u65e5\u671f", "\u51c0\u503c\u65e5\u671f", "NAV Date", "\u57fa\u6e96\u4fa1\u984d\u65e5"],
  arrivalDate: ["arrivalDate", "\u5165\u8d26\u65e5\u671f", "\u5230\u8d26\u65e5\u671f", "Posting Date", "\u5165\u5e33\u65e5"],
  remark: ["remark", "\u5907\u6ce8", "\u8bf4\u660e", "Remark", "Note", "\u5099\u8003", "\u30e1\u30e2"],
};

function formatText(t: TranslateFn, key: string, values?: Record<string, string | number>) {
  let text = t(key);
  if (!values) return text;
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function normalizeFundImportContext(context?: FundImportDialogContext | null): FundImportDialogContext | null {
  const fundAccountId = String(context?.fundAccountId ?? "").trim();
  const fundAccount = String(context?.fundAccount ?? "").trim();
  const fundCode = String(context?.fundCode ?? "").trim();
  const fundName = String(context?.fundName ?? "").trim();
  if (!fundAccountId && !fundAccount && !fundCode && !fundName) return null;
  return {
    ...(fundAccountId ? { fundAccountId } : {}),
    ...(fundAccount ? { fundAccount } : {}),
    ...(fundCode ? { fundCode } : {}),
    ...(fundName ? { fundName } : {}),
  };
}

function fundIssueMessage(issue: FundImportPreviewIssue, t: TranslateFn) {
  if (issue.code === "MISSING_CASH_ACCOUNT" || issue.message === "MISSING_CASH_ACCOUNT") {
    return t("batchImport.fundPreview.missingCashAccount");
  }
  if (issue.code === "INVALID_FUND_CODE" || issue.message === "INVALID_FUND_CODE") {
    return t("batchImport.fundPreview.invalidFundCode");
  }
  return issue.message;
}

function normalizeFundHeaderText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
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

function parseLooseNumber(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseFundFeeRateInput(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  const rate = parseLooseNumber(raw.replace(/%/g, ""));
  return rate == null || rate < 0 ? null : rate;
}

function parseFundFeeInput(value: string) {
  const raw = value.trim();
  if (!raw) return { fee: null as number | null, feeRateInput: null as number | null };
  if (raw.includes("%")) {
    return {
      fee: null as number | null,
      feeRateInput: parseFundFeeRateInput(raw),
    };
  }
  const fee = parseLooseNumber(raw);
  return {
    fee: fee == null ? null : Math.abs(fee),
    feeRateInput: null as number | null,
  };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatDateParts(year: number, month: number, day: number) {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatTimeParts(hour: number, minute: number, second: number | null) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || (second != null && (second < 0 || second > 59))) return "";
  const time = `${pad2(hour)}:${pad2(minute)}`;
  return second == null ? time : `${time}:${pad2(second)}`;
}

function appendNormalizedTime(datePart: string, hourText?: string, minuteText?: string, secondText?: string) {
  if (!datePart || hourText == null || minuteText == null) return datePart;
  const timePart = formatTimeParts(Number(hourText), Number(minuteText), secondText == null ? null : Number(secondText));
  return timePart ? `${datePart} ${timePart}` : datePart;
}

function normalizeDateCell(value: string) {
  const raw = value.trim().replace(/\s+/g, " ");
  if (!raw) return "";

  const excelSerial = Number(raw);
  if (Number.isFinite(excelSerial) && excelSerial > 20000 && excelSerial < 80000) {
    const utc = Date.UTC(1899, 11, 30) + excelSerial * 86400000;
    const date = new Date(utc);
    const datePart = formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const second = date.getUTCSeconds();
    return hour || minute || second ? `${datePart} ${formatTimeParts(hour, minute, second)}` : datePart;
  }

  const normalized = raw
    .replace(/[\u5e74\u6708]/g, "-")
    .replace(/[\u65e5\u53f7]/g, "")
    .replace(/[.\/]/g, "-")
    .trim();

  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return appendNormalizedTime(formatDateParts(Number(match[1]), Number(match[2]), Number(match[3])), match[4], match[5], match[6]);
  }

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return appendNormalizedTime(formatDateParts(Number(match[3]), Number(match[1]), Number(match[2])), match[4], match[5], match[6]);
  }

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const year = Number(match[3]);
    return appendNormalizedTime(
      formatDateParts(year >= 70 ? 1900 + year : 2000 + year, Number(match[1]), Number(match[2])),
      match[4],
      match[5],
      match[6],
    );
  }

  match = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));

  return raw;
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

function hasLikelyFundHeaders(map: Map<FundImportHeaderField, number>) {
  return map.has("date") && map.has("fundAccount") && map.has("fundCode") && (map.has("amount") || map.has("units"));
}

function hasCanonicalFundHeaders(headers: string[]) {
  return headers.some((header) => FUND_CANONICAL_HEADERS.includes(header.trim() as (typeof FUND_CANONICAL_HEADERS)[number]));
}

function looksLikeFundLabelRow(headers: string[]) {
  return headers.some((header) => FUND_LABEL_HEADER_SET.has(header.trim()));
}

function normalizeFundActionText(value: string) {
  return value.trim().toLowerCase().replace(/[\s_\-（）()]+/g, "");
}

function normalizeFundImportAction(rawAction: string) {
  const action = normalizeFundActionText(rawAction);
  if (["regularinvest", "recurringinvest", "recurringbuy", "\u5b9a\u6295", "\u7a4d\u7acb"].includes(action)) return "buy";
  if (["buy", "purchase", "subscribe", "\u7533\u8d2d", "\u8cb7\u5165", "\u4e70\u5165", "\u8cfc\u5165"].includes(action)) return "buy";
  if (["redeem", "redemption", "sell", "\u8d4e\u56de", "\u8d16\u56de", "\u89e3\u7d04"].includes(action)) return "redeem";
  if (["dividendcash", "cashdividend", "\u73b0\u91d1\u5206\u7ea2", "\u914d\u5f53", "\u73fe\u91d1\u5206\u914d"].includes(action)) return "dividend_cash";
  if (["dividendreinvest", "reinvestdividend", "\u7ea2\u5229\u518d\u6295", "\u518d\u6295\u8cc7", "\u5206\u914d\u91d1\u518d\u6295\u8cc7"].includes(action)) return "dividend_reinvest";
  return "";
}

function fundHeaderScore(row: string[]) {
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

function trimWorkbookRowsToFundHeader(rows: string[][]) {
  const compactRows = rows.filter((row) => row.some((cell) => cell.trim()));
  let bestIndex = 0;
  let bestScore = fundHeaderScore(compactRows[0] ?? []);
  compactRows.slice(0, 25).forEach((row, index) => {
    const score = fundHeaderScore(row);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore > 0 ? compactRows.slice(bestIndex) : compactRows;
}

function importHeaderSignature(row: string[]) {
  return row.map(normalizeFundHeaderText).join("|");
}

function worksheetRows(XLSX: typeof import("xlsx"), workbook: WorkBook, sheetName: string): string[][] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }).map((row) => row.map((cell) => String(cell ?? "").trim()));
}

function mergeFundWorkbookRows(XLSX: typeof import("xlsx"), workbook: WorkBook): FundImportFileParseResult {
  const sheetRows = workbook.SheetNames
    .map((sheetName) => ({ sheetName, rows: trimWorkbookRowsToFundHeader(worksheetRows(XLSX, workbook, sheetName)) }))
    .filter((item) => item.rows.length > 0);

  if (sheetRows.length === 0) {
    return { rows: [], sourceDataRowCount: 0, workbook: { sheetCount: workbook.SheetNames.length, includedSheetCount: 0 } };
  }

  const groups = new Map<string, typeof sheetRows>();
  for (const item of sheetRows) {
    const signature = importHeaderSignature(item.rows[0] ?? []);
    groups.set(signature, [...(groups.get(signature) ?? []), item]);
  }
  const selectedSheets = Array.from(groups.values()).sort((a, b) => {
    const aScore = fundHeaderScore(a[0]?.rows[0] ?? []);
    const bScore = fundHeaderScore(b[0]?.rows[0] ?? []);
    if (aScore !== bScore) return bScore - aScore;
    const aRows = a.reduce((sum, item) => sum + Math.max(0, item.rows.length - 1), 0);
    const bRows = b.reduce((sum, item) => sum + Math.max(0, item.rows.length - 1), 0);
    return bRows - aRows;
  })[0] ?? [];

  const primaryRows = selectedSheets[0]?.rows ?? [];
  const primarySecondSignature = importHeaderSignature(primaryRows[1] ?? []);
  const primaryHasSecondHeader = looksLikeFundLabelRow(primaryRows[1] ?? []);
  const mergedRows = [...primaryRows];

  for (const item of selectedSheets.slice(1)) {
    const hasSameSecondHeader = primaryHasSecondHeader && importHeaderSignature(item.rows[1] ?? []) === primarySecondSignature;
    mergedRows.push(...item.rows.slice(hasSameSecondHeader ? 2 : 1));
  }

  return {
    rows: mergedRows,
    sourceDataRowCount: selectedSheets.reduce((sum, item) => {
      const hasSameSecondHeader = primaryHasSecondHeader && importHeaderSignature(item.rows[1] ?? []) === primarySecondSignature;
      return sum + Math.max(0, item.rows.length - (hasSameSecondHeader ? 2 : 1));
    }, 0),
    workbook: {
      sheetCount: workbook.SheetNames.length,
      includedSheetCount: selectedSheets.length,
    },
  };
}

async function parseFundImportFile(file: File): Promise<FundImportFileParseResult> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const data = await file.arrayBuffer();
    return mergeFundWorkbookRows(XLSX, XLSX.read(data, { type: "array", cellDates: true }));
  }
  const rows = parseCsv(await file.text());
  return { rows, sourceDataRowCount: Math.max(0, rows.length - 1) };
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

  const readField = (row: string[], field: FundImportHeaderField) => {
    const index = headerIndex.get(field);
    return index == null ? "" : String(row[index] ?? "").trim();
  };

  return dataRows
    .filter((row) => row.some((cell) => String(cell ?? "").trim()))
    .filter((row) => {
      const bodyCells = row.map((cell) => String(cell ?? "").trim());
      return !(
        bodyCells.length >= 2 &&
        bodyCells[0] &&
        !/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(bodyCells[0]) &&
        bodyCells.slice(1).every((cell) => !cell || /[A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(cell)) &&
        !bodyCells.some((cell) => /^\d+(?:\.\d+)?%?$/.test(cell) || /^(buy|redeem|dividend_cash|dividend_reinvest)$/.test(normalizeFundImportAction(cell)) || /^(buy|redeem|cashdividend|dividendreinvest)$/.test(normalizeFundActionText(cell)))
      );
    })
    .map((row) => {
      const amount = parseLooseNumber(readField(row, "amount")) ?? 0;
      const parsedFee = parseFundFeeInput(readField(row, "fee"));
      const parsedFeeRate = parseFundFeeRateInput(readField(row, "feeRateInput"));
      const fundSubtype = normalizeFundImportAction(readField(row, "fundSubtype")) || readField(row, "fundSubtype");
      return {
        rawText: row.join(" "),
        date: normalizeDateCell(readField(row, "date")),
        fundSubtype,
        cashAccount: readField(row, "cashAccount"),
        fundAccount: readField(row, "fundAccount"),
        fundCode: readField(row, "fundCode"),
        amount,
        units: parseLooseNumber(readField(row, "units")),
        nav: parseLooseNumber(readField(row, "nav")),
        fee: parsedFee.fee,
        feeRateInput: parsedFee.fee == null ? (parsedFeeRate ?? parsedFee.feeRateInput) : null,
        confirmDate: normalizeDateCell(readField(row, "confirmDate")) || null,
        arrivalDate: normalizeDateCell(readField(row, "arrivalDate")) || null,
        remark: readField(row, "remark"),
      };
    });
}

function formatOptionalNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function extractImportDatePart(value: string | null | undefined) {
  const normalized = normalizeDateCell(String(value ?? ""));
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (!match) return "";
  const datePart = formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!datePart) return "";
  const [year, month, day] = datePart.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day ? datePart : "";
}

function applyFundDateOffset(
  item: FundImportPreviewItem,
  value: string,
  tradingCalendar?: string | null,
) {
  const offset = evaluateCalcInputExpression(value, 0);
  if (offset == null || !Number.isInteger(offset) || offset < 0) return undefined;
  const baseDate = extractImportDatePart(item.date);
  if (!baseDate) return undefined;
  return addTradingDaysUtc(baseDate, offset, tradingCalendar);
}

function recalculatePreviewUnitsAfterFee(
  item: FundImportPreviewItem,
  fee: number,
  fundAccount?: FundPreviewAccount,
) {
  if (item.fundSubtype !== "buy" && item.fundSubtype !== "dividend_reinvest") return item.units;
  if (item.nav == null || !(item.nav > 0) || !(Math.abs(item.amount) > 0)) return item.units;
  const decimals = normalizeFundUnitsDecimals(fundAccount?.fundUnitsDecimals);
  return calculateConfirmedBuyUnits({
    grossAmount: Math.abs(item.amount),
    refundAmount: 0,
    fee: item.fundSubtype === "buy" ? fee : 0,
    nav: item.nav,
    roundUnits: (value) => roundFundUnits(value, decimals),
  });
}

function getFundImportSubtypeLabel(subtype: string, source: string, t: (key: string) => string) {
  if (subtype === "buy_failed" && source === "regular_invest_refund") return t("batchImport.fundSubtype.refund");
  if (subtype === "buy_failed") return t("batchImport.fundSubtype.unfilledRefund");
  if (subtype === "buy" && source === "regular_invest") return t("fund.subtype.regular_invest");
  if (subtype === "buy") return t("fund.subtype.buy");
  if (subtype === "redeem") return t("fund.subtype.redeem");
  if (subtype === "dividend_cash") return t("fund.subtype.dividend_cash");
  if (subtype === "dividend_reinvest") return t("fund.subtype.dividend_reinvest");
  return subtype || "-";
}

function buildFundRuleEditorRows(_items: FundImportPreviewItem[]) {
  return [];
}

function serializeFundRuleOverrides(rows: FundRuleEditorRow[], t: (key: string) => string) {
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
    const confirmDays = parseDays(row.confirmDays, t("batchImport.fundPreview.confirmDays"));
    const arrivalDays = parseDays(row.arrivalDays, t("batchImport.fundPreview.arrivalDays"));
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

function hasBlockingIssue(item: FundImportPreviewItem | undefined) {
  return !!item?.issues.some((issue) => issue.level === "error");
}

function selectableIndexes(items: FundImportPreviewItem[]) {
  return new Set(items.flatMap((item, index) => hasBlockingIssue(item) ? [] : [index]));
}

function buildPreviewAccountDisplayOption(account: FundPreviewAccount): AccountDisplayOption {
  return buildAccountDisplayOption({
    ...account,
    Institution: account.Institution
      ? {
          name: account.Institution.name ?? null,
          shortName: account.Institution.shortName ?? null,
        }
      : null,
    AccountGroup: account.AccountGroup
      ? {
          id: account.AccountGroup.id,
          name: account.AccountGroup.name ?? null,
        }
      : null,
  });
}

export function FundImportPreviewDialog({ open, file, context, onClose, onImported }: Props) {
  const { t } = useI18n();
  const requestContext = useMemo(() => normalizeFundImportContext(context), [context]);
  const [uploadItems, setUploadItems] = useState<FundImportUploadItem[]>([]);
  const [previewItems, setPreviewItems] = useState<FundImportPreviewItem[]>([]);
  const [bookAccounts, setBookAccounts] = useState<FundPreviewAccount[]>([]);
  const [ruleRows, setRuleRows] = useState<FundRuleEditorRow[]>([]);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [debugMessage, setDebugMessage] = useState<string | null>(null);

  const previewRows = useMemo<FundPreviewTableRow[]>(
    () => previewItems.map((item, idx) => ({ ...item, idx })),
    [previewItems],
  );
  const accountById = useMemo(() => new Map(bookAccounts.map((account) => [account.id, account] as const)), [bookAccounts]);
  const accountDisplayById = useMemo(
    () => new Map(bookAccounts.map((account) => {
      const display = buildPreviewAccountDisplayOption(account);
      return [display.id, display] as const;
    })),
    [bookAccounts],
  );
  const selectedKeys = useMemo(() => new Set(Array.from(selected).map((idx) => String(idx))), [selected]);

  const importIssues = useMemo(() => (
    Array.from(selected)
      .flatMap((idx) => (previewItems[idx]?.issues ?? []).map((issue) => ({
        idx,
        ...issue,
        message: fundIssueMessage(issue, t),
      })))
  ), [previewItems, selected, t]);
  const errorIssues = useMemo(() => importIssues.filter((issue) => issue.level === "error"), [importIssues]);
  const warningIssues = useMemo(() => importIssues.filter((issue) => issue.level === "warning"), [importIssues]);

  const warningSummary = useMemo(() => {
    const grouped = new Map<string, { message: string; count: number; rows: number[] }>();
    previewItems.forEach((item, idx) => {
      item.issues
        .filter((issue) => issue.level === "warning")
        .forEach((issue) => {
          const messageText = fundIssueMessage(issue, t);
          const current = grouped.get(messageText);
          if (current) {
            current.count += 1;
            current.rows.push(idx + 1);
          } else {
            grouped.set(messageText, { message: messageText, count: 1, rows: [idx + 1] });
          }
        });
    });
    const groups = Array.from(grouped.values()).sort((a, b) => b.count - a.count || a.rows[0] - b.rows[0]);
    if (groups.length === 0) return "";
    const main = groups
      .slice(0, 2)
      .map((group) => formatText(t, "batchImport.fundPreview.warningCompactItem", {
        message: group.message,
        count: group.count,
      }))
      .join("；");
    const moreCount = groups.length - 2;
    return moreCount > 0
      ? `${main}；${formatText(t, "batchImport.fundPreview.warningCompactMore", { count: moreCount })}`
      : main;
  }, [previewItems, t]);

  const previewAccountLabel = useCallback((accountId: string | null | undefined, fallback: string) => {
    const display = accountId ? accountDisplayById.get(accountId) : undefined;
    return display ? formatAccountTableLabel(display, fallback) : fallback.trim() || "-";
  }, [accountDisplayById]);

  const previewAccountTitle = useCallback((accountId: string | null | undefined, fallback: string) => {
    const display = accountId ? accountDisplayById.get(accountId) : undefined;
    return display ? formatAccountTableTitle(display, fallback) : fallback.trim();
  }, [accountDisplayById]);

  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<FundPreviewEditField>[]>(
    () => [
      {
        value: "fee",
        label: t("batchImport.template.fund.label.fee"),
        kind: "number",
        placeholder: t("batchImport.numberExpressionPlaceholder"),
      },
      {
        value: "confirmDate",
        label: t("batchImport.fundPreview.confirmDateOffset"),
        kind: "number",
        placeholder: t("batchImport.fundPreview.dateOffsetPlaceholder"),
      },
      {
        value: "arrivalDate",
        label: t("batchImport.fundPreview.arrivalDateOffset"),
        kind: "number",
        placeholder: t("batchImport.fundPreview.dateOffsetPlaceholder"),
      },
    ],
    [t],
  );

  const applyPreviewReplace = useCallback((field: FundPreviewEditField, value: string) => {
    const selectedIndexes = new Set(Array.from(selected).filter((idx) => previewItems[idx]));
    if (selectedIndexes.size === 0) throw new Error(t("batchImport.fundPreview.selectRowsFirst"));
    let changed = 0;
    let invalid = 0;
    const nextPreviewItems = previewItems.map((item, index) => {
      if (!selectedIndexes.has(index)) return item;
      const fundAccount = item.fundAccountId ? accountById.get(item.fundAccountId) : undefined;
      if (field === "fee") {
        const nextFee = evaluateCalcInputExpression(value, item.fee ?? 0);
        if (nextFee == null || nextFee < 0) {
          invalid += 1;
          return item;
        }
        const fee = Number(nextFee.toFixed(2));
        const units = recalculatePreviewUnitsAfterFee(item, fee, fundAccount);
        changed += 1;
        return {
          ...item,
          fee,
          feeRate: 0,
          feeRateInput: null,
          units,
        };
      }

      const nextDate = applyFundDateOffset(item, value, fundAccount?.tradingCalendar);
      if (nextDate === undefined) {
        invalid += 1;
        return item;
      }
      changed += 1;
      return {
        ...item,
        [field]: nextDate,
      };
    });
    setPreviewItems(nextPreviewItems);
    const invalidSuffix = invalid > 0
      ? t(field === "fee" ? "batchImport.fundPreview.invalidNumberSkipped" : "batchImport.fundPreview.invalidDateSkipped", { count: invalid })
      : "";
    return t("batchImport.fundPreview.batchReplaceResult", {
      count: changed,
      field: field === "confirmDate"
        ? t("batchImport.fundPreview.confirmDateOffset")
        : field === "arrivalDate"
          ? t("batchImport.fundPreview.arrivalDateOffset")
          : t("batchImport.template.fund.label.fee"),
      invalidSuffix,
    });
  }, [accountById, previewItems, selected, t]);

  const requestPreview = useCallback(async (
    sourceItems: FundImportUploadItem[],
    rows: FundRuleEditorRow[],
    preserveSelection: boolean,
    fileInfo?: string,
  ) => {
    const { overrides, invalidLabels } = serializeFundRuleOverrides(rows, t);
    if (invalidLabels.length > 0) {
      setMessage(formatText(t, "batchImport.fundPreview.invalidRules", {
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
        body: JSON.stringify({
          mode: "preview",
          items: sourceItems,
          overrides,
          ...(requestContext ? { context: requestContext } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: FundImportPreviewItem[] } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      setPreviewItems(data.items);
      setRuleRows(buildFundRuleEditorRows(data.items));
      setRulesDirty(false);
      setSelected((prev) => preserveSelection
        ? new Set(Array.from(prev).filter((idx) => idx < data.items!.length && !hasBlockingIssue(data.items![idx])))
        : selectableIndexes(data.items!));
      setDebugMessage(null);
      setMessage(null);
      return true;
    } catch (error) {
      setPreviewItems([]);
      setRuleRows([]);
      setSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setDebugMessage(formatText(t, "batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo: fileInfo || "" }));
      setMessage(formatText(t, "batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
      return false;
    } finally {
      setUploading(false);
    }
  }, [requestContext, t]);

  useEffect(() => {
    if (!open || !file) {
      setUploadItems([]);
      setPreviewItems([]);
      setBookAccounts([]);
      setRuleRows([]);
      setRulesDirty(false);
      setSelected(new Set());
      setUploading(false);
      setImporting(false);
      setMessage(null);
      setDebugMessage(null);
      return;
    }

    let cancelled = false;
    const fileInfo = formatText(t, "batchImport.fileInfo", {
      name: file.name,
      type: file.type || t("batchImport.fileTypeUnknown"),
      sizeKb: Math.round(file.size / 1024),
    });

    async function load() {
      setUploading(true);
      setImporting(false);
      setMessage(formatText(t, "batchImport.readingFileName", { name: file!.name }));
      setDebugMessage(formatText(t, "batchImport.fileSelectedStart", { fileInfo }));
      setUploadItems([]);
      setPreviewItems([]);
      setRuleRows([]);
      setRulesDirty(false);
      setSelected(new Set());
      try {
        const parseResult = await parseFundImportFile(file!);
        if (cancelled) return;
        const parsed = fundRowsToItems(parseResult.rows);
        if (parsed.length === 0) {
          const headers = parseResult.rows[0]?.join("、") || t("batchImport.headersNotRead");
          setDebugMessage(formatText(t, "batchImport.noRecordsRecognizedDebug", { headers, fileInfo }));
          setMessage(formatText(t, "batchImport.noRecordsRecognizedMessage", { name: file!.name, headers }));
          setUploading(false);
          return;
        }
        setUploadItems(parsed);
        await requestPreview(parsed, [], false, fileInfo);
      } catch (error) {
        if (cancelled) return;
        const reason = error instanceof Error ? error.message : String(error);
        setDebugMessage(formatText(t, "batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo }));
        setMessage(formatText(t, "batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
        setUploading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [file, open, requestPreview, t]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSettingsBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setBookAccounts(Array.isArray(bootstrap.accounts) ? bootstrap.accounts as FundPreviewAccount[] : []);
      })
      .catch(() => {
        if (!cancelled) setBookAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleApplyRules = useCallback(async () => {
    if (uploadItems.length === 0 || importing) return;
    await requestPreview(uploadItems, ruleRows, true);
  }, [importing, requestPreview, ruleRows, uploadItems]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
    const selectedItems = selectedIndexes.map((idx) => previewItems[idx]).filter(Boolean);
    if (selectedItems.length === 0) return;

    if (errorIssues.length > 0) {
      const preview = errorIssues
        .slice(0, 5)
        .map((issue) => formatText(t, "batchImport.issueLine", {
          index: issue.idx + 1,
          level: t("batchImport.levelError"),
          message: issue.message,
        }))
        .join("；");
      setMessage(formatText(t, "batchImport.importValidationFailed", {
        count: errorIssues.length,
        preview,
        more: errorIssues.length > 5 ? t("batchImport.importValidationMore") : "",
      }));
      setDebugMessage(
        importIssues
          .map((issue) => formatText(t, "batchImport.issueLine", {
            index: issue.idx + 1,
            level: issue.level === "error" ? t("batchImport.levelError") : t("batchImport.levelWarning"),
            message: issue.message,
          }))
          .join("\n"),
      );
      return;
    }

    setImporting(true);
    setMessage(formatText(t, "batchImport.fundImportingSelected", { count: selectedItems.length }));
    setDebugMessage(null);

    try {
      const { overrides, invalidLabels } = serializeFundRuleOverrides(ruleRows, t);
      if (invalidLabels.length > 0) {
        throw new Error(formatText(t, "batchImport.fundPreview.invalidRules", {
          items: invalidLabels.slice(0, 3).join("、"),
          more: invalidLabels.length > 3 ? t("batchImport.importValidationMore") : "",
        }));
      }
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "import",
          items: selectedItems,
          overrides,
          ...(requestContext ? { context: requestContext } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      const count = data.createdCount ?? selectedItems.length;
      const accountIds = Array.from(new Set(selectedItems.map((item) => item.fundAccountId).filter((id): id is string => Boolean(id))));
      dispatchFinanceDataChanged({ reason: "fund-excel-import", accountIds });
      onImported?.({ count, accountIds });
      onClose();
    } catch (error) {
      setMessage(formatText(t, "batchImport.importFailedRollback", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setImporting(false);
    }
  }, [errorIssues, importIssues, importing, onClose, onImported, previewItems, requestContext, ruleRows, selected, t]);

  const columns = useMemo<AdvancedDataTableColumn<FundPreviewTableRow>[]>(() => [
    {
      key: "status",
      label: "",
      width: 42,
      minWidth: 36,
      align: "center",
      filterText: (row) => row.issues.some((issue) => issue.level === "error") ? t("batchImport.levelError") : row.issues.some((issue) => issue.level === "warning") ? t("batchImport.levelWarning") : t("batchImport.levelNormal"),
      render: (row) => {
        const rowHasError = row.issues.some((issue) => issue.level === "error");
        const rowHasWarning = row.issues.some((issue) => issue.level === "warning");
        if (row.issues.length === 0) return <span className="text-[11px] text-slate-400">{row.idx + 1}</span>;
        return (
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white ${rowHasError ? "bg-red-500" : rowHasWarning ? "bg-amber-500" : "bg-slate-300"}`}
            title={row.issues.map((issue) => fundIssueMessage(issue, t)).join("；")}
          >
            !
          </span>
        );
      },
    },
    { key: "date", label: t("batchImport.template.fund.label.date"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.date || "-", sortValue: (row) => row.date || "", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.date || "-"}</span> },
    { key: "fundSubtype", label: t("batchImport.template.fund.label.fundSubtype"), width: 116, minWidth: 92, filterText: (row) => getFundImportSubtypeLabel(row.fundSubtype, row.source, t), render: (row) => <span className="whitespace-nowrap text-slate-700">{getFundImportSubtypeLabel(row.fundSubtype, row.source, t)}</span> },
    {
      key: "cashAccount",
      label: t("batchImport.template.fund.label.cashAccount"),
      width: 180,
      minWidth: 130,
      filterText: (row) => previewAccountLabel(row.cashAccountId, row.cashAccount),
      render: (row) => {
        const label = previewAccountLabel(row.cashAccountId, row.cashAccount);
        return <span className="truncate text-slate-700" title={previewAccountTitle(row.cashAccountId, row.cashAccount)}>{label}</span>;
      },
    },
    {
      key: "fundAccount",
      label: t("batchImport.template.fund.label.fundAccount"),
      width: 180,
      minWidth: 130,
      filterText: (row) => previewAccountLabel(row.fundAccountId, row.fundAccount),
      render: (row) => {
        const label = previewAccountLabel(row.fundAccountId, row.fundAccount);
        return <span className="truncate text-slate-700" title={previewAccountTitle(row.fundAccountId, row.fundAccount)}>{label}</span>;
      },
    },
    { key: "fundCode", label: t("batchImport.template.fund.label.fundCode"), width: 96, minWidth: 76, filterText: (row) => row.fundCode || "-", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.fundCode || "-"}</span> },
    { key: "fundName", label: t("batchImport.template.fund.label.fundName"), width: 220, minWidth: 150, filterText: (row) => row.fundName || "-", render: (row) => <span className="truncate text-slate-700" title={row.fundName || ""}>{row.fundName || "-"}</span> },
    { key: "amount", label: t("batchImport.template.fund.label.amount"), width: 116, minWidth: 90, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.amount, 2), filterNumber: (row) => row.amount, sortValue: (row) => row.amount, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.amount, 2)}</span> },
    { key: "feeRate", label: t("batchImport.template.fund.label.feeRate"), width: 96, minWidth: 78, align: "right", filterKind: "numberRange", filterText: (row) => row.feeRate != null ? row.feeRate.toFixed(4) : "-", filterNumber: (row) => row.feeRate, sortValue: (row) => row.feeRate ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.feeRate != null ? `${row.feeRate.toFixed(4)}%` : "-"}</span> },
    { key: "fee", label: t("batchImport.template.fund.label.fee"), width: 96, minWidth: 76, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.fee, 2), filterNumber: (row) => row.fee, sortValue: (row) => row.fee ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.fee, 2)}</span> },
    { key: "nav", label: t("batchImport.template.fund.label.nav"), width: 96, minWidth: 78, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.nav, 4), filterNumber: (row) => row.nav, sortValue: (row) => row.nav ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.nav, 4)}</span> },
    { key: "units", label: t("batchImport.template.fund.label.units"), width: 116, minWidth: 90, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.units, 2), filterNumber: (row) => row.units, sortValue: (row) => row.units ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.units, 2)}</span> },
    { key: "confirmDate", label: t("batchImport.template.fund.label.confirmDate"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.confirmDate || "-", sortValue: (row) => row.confirmDate || "", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.confirmDate || "-"}</span> },
    { key: "arrivalDate", label: t("batchImport.template.fund.label.arrivalDate"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.arrivalDate || "-", sortValue: (row) => row.arrivalDate || "", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.arrivalDate || "-"}</span> },
    { key: "remark", label: t("batchImport.template.fund.label.remark"), width: 220, minWidth: 150, filterText: (row) => row.remark || "-", render: (row) => <span className="truncate text-slate-700" title={row.remark || ""}>{row.remark || "-"}</span> },
  ], [previewAccountLabel, previewAccountTitle, t]);

  if (!open || !file) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/40 p-4">
      <div data-smart-select-boundary data-batch-popover-boundary className="flex h-[82vh] min-h-[420px] w-[80rem] min-w-[720px] max-w-[calc(100vw-2rem)] resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="shrink-0 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-base font-semibold text-slate-800">{t("batchImport.previewFundTitle")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {uploading ? t("batchImport.previewParsing") : formatText(t, "batchImport.previewFundHint", { count: previewItems.length })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={importing}
                className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={uploading || importing || selected.size === 0 || errorIssues.length > 0}
                className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importing ? t("batchImport.importing") : formatText(t, "batchImport.confirmImport", { count: selected.size })}
              </button>
            </div>
          </div>
        </div>
        {message ? (
          <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
            {message}
          </div>
        ) : null}
        {debugMessage ? (
          <div className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            {debugMessage}
          </div>
        ) : null}
        <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="font-medium text-slate-700">{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
            {errorIssues.length > 0 ? (
              <span className="font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: errorIssues.length })}</span>
            ) : null}
            {warningIssues.length > 0 ? (
              <span className="font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: warningIssues.length })}</span>
            ) : null}
          </div>
          {ruleRows.length > 0 ? (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                <div className="text-xs font-medium text-slate-700">{t("batchImport.fundPreview.ruleEditorTitle")}</div>
                <button
                  type="button"
                  onClick={() => void handleApplyRules()}
                  disabled={uploading || importing || ruleRows.length === 0}
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {rulesDirty ? t("batchImport.fundPreview.applyRulesDirty") : t("batchImport.fundPreview.applyRules")}
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
                  {ruleRows.map((row) => (
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
                            setRuleRows((prev) => prev.map((item) => item.key === row.key ? { ...item, confirmDays: value } : item));
                            setRulesDirty(true);
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
                            setRuleRows((prev) => prev.map((item) => item.key === row.key ? { ...item, arrivalDays: value } : item));
                            setRulesDirty(true);
                          }}
                          className="w-full bg-transparent text-right tabular-nums text-slate-700 outline-none"
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          {warningSummary ? (
            <div className="mt-2 text-xs text-amber-700">
              <span className="font-medium text-amber-800">{t("batchImport.fundPreview.warningSummaryTitle")}</span>
              <span className="ml-1">{warningSummary}</span>
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <AdvancedDataTable
            storageKey="mmh_fund_import_preview_dialog_table_v1"
            columns={columns}
            rows={uploading ? [] : previewRows}
            rowKey={(row) => String(row.idx)}
            emptyText={uploading ? t("batchImport.previewParsing") : t("batchImport.noRecordsForFilter")}
            minTableWidth={1760}
            selectable
            selectAllScope="renderedRows"
            selectedKeys={selectedKeys}
            onSelectionChange={(keys) => {
              setSelected(new Set(Array.from(keys).map((key) => Number(key)).filter((idx) => Number.isInteger(idx))));
            }}
            batchActionSlot={(
              <BatchReplacePopoverButton
                fields={previewReplaceFields}
                targetCount={selectedKeys.size}
                targetLabel={t("batchImport.fundPreview.batchTarget")}
                panelAlign="left"
                disabledTitle={t("batchImport.fundPreview.selectRowsFirst")}
                buttonTitle={t("batchImport.fundPreview.batchEditSelected", { count: selectedKeys.size })}
                messageClassName="max-w-52 truncate text-xs text-blue-600"
                onApply={applyPreviewReplace}
              >
                {t("batchImport.fundPreview.batchEditHint")}
              </BatchReplacePopoverButton>
            )}
            toolbarTitle={t("batchImport.previewFundTitle")}
            toolbarRightContent={(
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
                {errorIssues.length > 0 ? <span className="font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: errorIssues.length })}</span> : null}
                {warningIssues.length > 0 ? <span className="font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: warningIssues.length })}</span> : null}
              </div>
            )}
            rowClassName={(row) => {
              const rowHasError = row.issues.some((issue) => issue.level === "error");
              const rowHasWarning = row.issues.some((issue) => issue.level === "warning");
              return rowHasError ? "bg-red-50 hover:bg-red-100/80" : rowHasWarning ? "bg-amber-50 hover:bg-amber-100/80" : "hover:bg-slate-50";
            }}
            fillHeight
            compactRows
            showFilters
            sortable
            showColumnVisibilityButton={false}
          />
        </div>
      </div>
    </div>
  );
}
