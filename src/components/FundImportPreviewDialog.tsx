"use client";
import { ModalLayer } from "@/components/ModalLayer";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { WorkBook } from "xlsx";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { ImportPreviewHeader } from "@/components/ImportPreviewHeader";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import { SmartSelect } from "@/components/SmartSelect";
import {
  buildAccountDisplayOption,
  buildGroupedAccountOptions,
  formatAccountTableLabel,
  formatAccountTableTitle,
  type AccountDisplayOption,
} from "@/lib/account-display";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { recordRecentAccounts } from "@/lib/client/recentAccounts";
import { decodeTextFile } from "@/lib/client/decode-text-file";
import { fetchSettingsBootstrap } from "@/lib/client/settingsCache";
import { addTradingDaysUtc, parseFlexibleDateToYmd } from "@/lib/date-utils";
import { formatAmountDraft } from "@/lib/format";
import { NAV_BACKFILL_DELAYS_MS, mergeNavBackfillRows, shouldBackfillNav } from "@/lib/fund/previewNavMerge";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import {
  dropTemplateSampleRows,
  findTemplateGuideTitleRowIndex,
  findTemplateSampleColumnIndex,
  rowsBeforeTemplateGuide,
} from "@/lib/import-template-sample";
import { useI18n } from "@/lib/i18n";
import { parseStatementCsv } from "@/lib/statement/statement-sheet-reader";
import { readAccountDisplaySettings } from "@/lib/client/account-display-settings";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";

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
  cashAccountId?: string | null;
  fundAccountId?: string | null;
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
  tags?: string | null;
  source?: string;
};

type FundImportHeaderField = Exclude<keyof FundImportUploadItem, "rawText" | "cashAccountId" | "fundAccountId" | "source">;

type FundImportPreviewIssue = {
  level: "error" | "warning";
  code?: string;
  message: string;
};

type FundImportCalculatedField = "feeRate" | "fee" | "nav" | "units";

type FundImportPreviewItem = FundImportUploadItem & {
  source: string;
  fundName: string | null;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  calculatedFields?: FundImportCalculatedField[];
  issues: FundImportPreviewIssue[];
};

type FundPreviewTableRow = FundImportPreviewItem & { idx: number };
type FundPreviewBatchEditField =
  | "fee"
  | "feeRate"
  | "nav"
  | "fundCode"
  | "fundSubtype"
  | "date"
  | "confirmDate"
  | "arrivalDate"
  | "fundAccount"
  | "cashAccount";

/** 批量调整结果消息里的字段名：与下拉里的叫法保持一致（同一份 i18n key）。 */
const FUND_PREVIEW_BATCH_FIELD_LABEL_KEYS: Record<FundPreviewBatchEditField, string> = {
  fundAccount: "batchImport.template.fund.label.fundAccount",
  cashAccount: "batchImport.template.fund.label.cashAccount",
  fundCode: "batchImport.template.fund.label.fundCode",
  fundSubtype: "batchImport.template.fund.label.fundSubtype",
  date: "batchImport.fundPreview.applicationDateOffset",
  fee: "batchImport.template.fund.label.fee",
  feeRate: "batchImport.template.fund.label.feeRate",
  nav: "batchImport.template.fund.label.nav",
  confirmDate: "batchImport.fundPreview.confirmDateOffset",
  arrivalDate: "batchImport.fundPreview.arrivalDateOffset",
};
type FundPreviewEditField =
  | "date"
  | "fundSubtype"
  | "cashAccount"
  | "fundAccount"
  | "fundCode"
  | "amount"
  | "feeRate"
  | "fee"
  | "nav"
  | "units"
  | "confirmDate"
  | "arrivalDate"
  | "remark"
  | "tags";
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

const FUND_PREVIEW_SUBTYPES = ["buy", "redeem", "dividend_cash", "dividend_reinvest", "buy_failed"] as const;

const FUND_PREVIEW_COMPONENT_NUMBER_FIELDS = ["amount", "feeRate", "fee", "nav", "units"] as const;

const FUND_PREVIEW_FIELD_LABEL_KEYS: Record<FundPreviewEditField, string> = {
  date: "batchImport.template.fund.label.date",
  fundSubtype: "batchImport.template.fund.label.fundSubtype",
  cashAccount: "batchImport.template.fund.label.cashAccount",
  fundAccount: "batchImport.template.fund.label.fundAccount",
  fundCode: "batchImport.template.fund.label.fundCode",
  amount: "batchImport.template.fund.label.amount",
  feeRate: "batchImport.template.fund.label.feeRate",
  fee: "batchImport.template.fund.label.fee",
  nav: "batchImport.template.fund.label.nav",
  units: "batchImport.template.fund.label.units",
  confirmDate: "batchImport.template.fund.label.confirmDate",
  arrivalDate: "batchImport.template.fund.label.arrivalDate",
  remark: "batchImport.template.fund.label.remark",
  tags: "detail.column.tags",
};

type Props = {
  open: boolean;
  file: File | null;
  context?: FundImportDialogContext | null;
  /** 顶部页签条（同一张账单的「资金收支 / 基金买卖」切换）：由宿主渲染，弹窗只负责摆位置。 */
  tabs?: ReactNode;
  /**
   * 给人看的来源文件名。账单里的基金买卖是先抽出来拼成一份临时 CSV 再交给这个弹窗的，
   * 那份文件并不在磁盘上 —— 直接显示它的名字会让用户去找一个不存在的文件。
   */
  sourceLabel?: string;
  /**
   * 页签已切走：窗口**保留挂载**，只是不显示。
   * 卸载再挂载要重新解析文件、重建表格（预览先空一拍），切页签时看着整页闪一下。
   */
  hidden?: boolean;
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
  fundSubtype: ["fundSubtype", "\u5206\u7c7b", "\u4e1a\u52a1\u7c7b\u578b", "\u57fa\u91d1\u52a8\u4f5c", "\u57fa\u91d1\u7c7b\u578b", "\u52a8\u4f5c", "Fund Action", "Action", "\u57fa\u91d1\u30a2\u30af\u30b7\u30e7\u30f3", "\u30d5\u30a1\u30f3\u30c9\u64cd\u4f5c", "cash dividend", "dividend reinvest", "\u73fe\u91d1\u5206\u914d", "\u5206\u914d\u91d1\u518d\u6295\u8cc7"],
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
  tags: ["tags", "\u6807\u7b7e", "\u6a19\u7c64", "Tags", "Tag", "\u30bf\u30b0"],
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
  if (issue.code === "WILL_CREATE_INSTITUTION_CASH_ACCOUNT") {
    const accountName = String(issue.message ?? "").split(":").slice(1).join(":").trim();
    return `${t("batchImport.fundPreview.willCreateInstitutionCashAccount")}：${accountName}`;
  }
  if (issue.code === "WILL_CREATE_INSTITUTION_FUND_ACCOUNT") {
    const accountName = String(issue.message ?? "").split(":").slice(1).join(":").trim();
    return `${t("batchImport.fundPreview.willCreateInstitutionFundAccount")}：${accountName}`;
  }
  return issue.message;
}

function normalizeFundHeaderText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function parseLooseNumber(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseEditableNumber(value: string) {
  const parsed = parseLooseNumber(value.trim());
  return parsed == null ? null : parsed;
}

function parseNonNegativeEditableNumber(value: string) {
  const parsed = parseEditableNumber(value);
  return parsed == null ? null : Math.abs(parsed);
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
    const datePart = formatDateParts(Number(match[3]), Number(match[1]), Number(match[2]));
    if (datePart) {
      return appendNormalizedTime(datePart, match[4], match[5], match[6]);
    }
  }

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const year = Number(match[3]);
    const datePart = formatDateParts(year >= 70 ? 1900 + year : 2000 + year, Number(match[1]), Number(match[2]));
    if (datePart) {
      return appendNormalizedTime(datePart, match[4], match[5], match[6]);
    }
  }

  match = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));

  // Lenient fallback (e.g. "26-02-2026" day-first, "Jan 26, 2026"); the date
  // part only, since the shapes above already handled explicit time parts.
  return parseFlexibleDateToYmd(raw) ?? raw;
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
  // 红利再投 / 再投 must be checked before 分红 so reinvest is not misread as cash dividend.
  if (action.includes("\u7ea2\u5229\u518d\u6295") || action.includes("\u518d\u6295") || action.includes("\u518d\u6295\u8cc7") || action.includes("\u5206\u914d\u91d1\u518d\u6295\u8cc7")) return "dividend_reinvest";
  if (action.includes("\u73b0\u91d1\u5206\u7ea2") || action.includes("\u5206\u7ea2") || action.includes("\u914d\u5f53") || action.includes("\u73fe\u91d1\u5206\u914d")) return "dividend_cash";
  // 买入退回（定投扣款失败/退款）必须早于「买入/申购」判断，否则会被误判为买入。
  if (action.includes("\u9000\u56de") || action.includes("\u9000\u6b3e") || action.includes("\u8fd4\u9084") || action.includes("\u8fd4\u91d1")) return "buy_failed";
  if (action.includes("\u5b9a\u6295") || action.includes("\u7a4d\u7acb")) return "buy";
  if (action.includes("\u7533\u8d2d") || action.includes("\u8cb7\u5165") || action.includes("\u4e70\u5165") || action.includes("\u8cfc\u5165")) return "buy";
  if (action.includes("\u8d4e\u56de") || action.includes("\u8d16\u56de") || action.includes("\u5356\u51fa") || action.includes("\u89e3\u7d04")) return "redeem";
  if (["buyfailed", "purchasefailed", "refund", "refunded", "reversal"].includes(action)) return "buy_failed";
  if (["buy", "purchase", "subscribe", "regularinvest", "recurringinvest", "recurringbuy"].includes(action)) return "buy";
  if (["redeem", "redemption", "sell"].includes(action)) return "redeem";
  if (["dividendcash", "cashdividend"].includes(action)) return "dividend_cash";
  if (["dividendreinvest", "reinvestdividend"].includes(action)) return "dividend_reinvest";
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
  const rows = parseStatementCsv(await decodeTextFile(file));
  return { rows, sourceDataRowCount: Math.max(0, rows.length - 1) };
}

function fundRowsToItems(
  rows: string[][],
  /** 模板说明区标题行文案；传入后会截断标题行以下的所有说明行 */
  guideTitle = "",
): FundImportUploadItem[] {
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

  // The 业务类型 column (e.g. 定投申购 / 定投申购（智汇定投）) distinguishes
  // recurring buys from one-time purchases. It is not a fundSubtype header, so
  // locate it separately to derive the regular-invest source.
  const headerRow = headerIndex === firstHeaderIndex ? firstRow : secondRow;
  const normalizedHeaderRow = headerRow.map(normalizeFundHeaderText);
  const businessTypeIndex = normalizedHeaderRow.findIndex((header) => header === "\u4e1a\u52a1\u7c7b\u578b" || header === "businesstype" || header === "transactiontype");
  const readBusinessType = (row: string[]) => businessTypeIndex < 0 ? "" : String(row[businessTypeIndex] ?? "").trim();

  // 模板自带的样板行与底部字段说明区都不是真实数据。
  const sampleColumnIndex = findTemplateSampleColumnIndex(headerRow);
  const guideTitleRowIndex = findTemplateGuideTitleRowIndex(dataRows, guideTitle);
  const importRows = dropTemplateSampleRows(rowsBeforeTemplateGuide(dataRows, guideTitleRowIndex), sampleColumnIndex);

  return importRows
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
      const businessType = readBusinessType(row);
      const source = businessType.includes("\u5b9a\u6295") || businessType.includes("\u7a4d\u7acb") ? "regular_invest" : undefined;
      return {
        rawText: row.join(" "),
        date: normalizeDateCell(readField(row, "date")),
        fundSubtype,
        source,
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
        tags: readField(row, "tags") || null,
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
  // 只看 date：预览行与上传行（批量调整时用的是后者）都满足。
  item: Pick<FundImportPreviewItem, "date">,
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

function hasBlockingIssue(item: FundImportPreviewItem | undefined) {
  return !!item?.issues.some((issue) => issue.level === "error");
}

function selectableIndexes(items: FundImportPreviewItem[]) {
  // 未匹配/有 error 的行也允许勾选，便于批量改账户后再导入
  return new Set(items.map((_, index) => index));
}

function isFundCashLikeAccount(account: FundPreviewAccount) {
  return account.kind === "cash" || account.kind === "bank_debit" || account.kind === "ewallet";
}

function isFundImportAccount(account: FundPreviewAccount) {
  return account.kind === "investment" && (!account.investProductType || account.investProductType === "fund" || account.investProductType === "money");
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
  }, undefined, readAccountDisplaySettings());
}

export function FundImportPreviewDialog({ open, file, context, tabs = null, sourceLabel = "", hidden = false, onClose, onImported }: Props) {
  const { t } = useI18n();
  const requestContext = useMemo(() => normalizeFundImportContext(context), [context]);
  // 缺少账户时在同机构下自动创建：缺基金账户 → 在资金账户所属机构（支付宝）下建基金账户；
  // 缺资金账户 → 复用/创建基金账户同机构的电子钱包。
  const [autoCreateInstitutionAccounts, setAutoCreateInstitutionAccounts] = useState(false);
  const [uploadItems, setUploadItems] = useState<FundImportUploadItem[]>([]);
  const [previewItems, setPreviewItems] = useState<FundImportPreviewItem[]>([]);
  const [bookAccounts, setBookAccounts] = useState<FundPreviewAccount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploading, setUploading] = useState(false);
  // 局部行重算进行中：不整表刷新，仅禁用编辑，保持表格渲染不动
  const [rowPatching, setRowPatching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ imported: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [debugMessage, setDebugMessage] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<{ idx: number; field: FundPreviewEditField } | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [draftOriginalValue, setDraftOriginalValue] = useState("");
  const skipNextEditCommitRef = useRef(false);
  /** 已经解析过的文件：切页签回来不重跑（重跑要再等一次服务端识别）。 */
  const loadedFileRef = useRef<File | null>(null);

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
  const cashAccountDisplayOptions = useMemo<AccountDisplayOption[]>(
    () => restrictAccountsByType(bookAccounts, isFundCashLikeAccount)
      .map(buildPreviewAccountDisplayOption)
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [bookAccounts],
  );
  const fundAccountDisplayOptions = useMemo<AccountDisplayOption[]>(
    () => restrictAccountsByType(bookAccounts, isFundImportAccount)
      .map(buildPreviewAccountDisplayOption)
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [bookAccounts],
  );
  const cashAccountDisplayById = useMemo(() => new Map(cashAccountDisplayOptions.map((account) => [account.id, account])), [cashAccountDisplayOptions]);
  const fundAccountDisplayById = useMemo(() => new Map(fundAccountDisplayOptions.map((account) => [account.id, account])), [fundAccountDisplayOptions]);
  const cashAccountOptions = useMemo(() => buildGroupedAccountOptions(cashAccountDisplayOptions), [cashAccountDisplayOptions]);
  const fundAccountOptions = useMemo(() => buildGroupedAccountOptions(fundAccountDisplayOptions), [fundAccountDisplayOptions]);
  const selectedKeys = useMemo(() => new Set(Array.from(selected).map((idx) => String(idx))), [selected]);
  const importReadySelectedCount = useMemo(
    () => Array.from(selected).filter((idx) => previewItems[idx] && !hasBlockingIssue(previewItems[idx])).length,
    [previewItems, selected],
  );

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

  // 阻断原因汇总：把错误按文案归类计数，直接说明「为什么不能导入」
  const errorSummary = useMemo(() => {
    const grouped = new Map<string, { message: string; count: number; rows: number[] }>();
    previewItems.forEach((item, idx) => {
      item.issues
        .filter((issue) => issue.level === "error")
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
      .slice(0, 3)
      .map((group) => formatText(t, "batchImport.fundPreview.warningCompactItem", {
        message: group.message,
        count: group.count,
      }))
      .join("；");
    const moreCount = groups.length - 3;
    return moreCount > 0
      ? `${main}；${formatText(t, "batchImport.fundPreview.warningCompactMore", { count: moreCount })}`
      : main;
  }, [previewItems, t]);

  const previewAccountLabel = useCallback((accountId: string | null | undefined, fallback: string) => {
    const display = accountId ? accountDisplayById.get(accountId) : undefined;
    return display ? formatAccountTableLabel(display, fallback, readAccountDisplaySettings()) : fallback.trim() || "-";
  }, [accountDisplayById]);

  const previewAccountTitle = useCallback((accountId: string | null | undefined, fallback: string) => {
    const display = accountId ? accountDisplayById.get(accountId) : undefined;
    return display ? formatAccountTableTitle(display, fallback, readAccountDisplaySettings()) : fallback.trim();
  }, [accountDisplayById]);

  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<FundPreviewBatchEditField>[]>(
    () => [
      {
        value: "fundAccount",
        label: t("batchImport.template.fund.label.fundAccount"),
        kind: "smartSelect" as const,
        options: fundAccountOptions.map((option) => ({
          value: option.id,
          label: option.label,
          subLabel: option.subLabel,
          title: option.title,
          isHeader: option.isHeader,
          isGroup: option.isGroup,
          parentId: option.parentId,
        })),
        allowEmpty: true,
      },
      {
        value: "cashAccount",
        label: t("batchImport.template.fund.label.cashAccount"),
        kind: "smartSelect" as const,
        options: cashAccountOptions.map((option) => ({
          value: option.id,
          label: option.label,
          subLabel: option.subLabel,
          title: option.title,
          isHeader: option.isHeader,
          isGroup: option.isGroup,
          parentId: option.parentId,
        })),
        allowEmpty: true,
      },
      {
        value: "fundCode",
        label: t("batchImport.template.fund.label.fundCode"),
        kind: "text" as const,
      },
      {
        value: "fundSubtype",
        label: t("batchImport.template.fund.label.fundSubtype"),
        kind: "select" as const,
        options: FUND_PREVIEW_SUBTYPES.map((subtype) => ({
          value: subtype,
          label: getFundImportSubtypeLabel(subtype, "manual", t),
        })),
      },
      {
        value: "feeRate",
        label: t("batchImport.template.fund.label.feeRate"),
        kind: "number",
        placeholder: t("batchImport.numberExpressionPlaceholder"),
      },
      {
        value: "nav",
        label: t("batchImport.template.fund.label.nav"),
        kind: "number",
        placeholder: t("batchImport.numberExpressionPlaceholder"),
      },
      {
        value: "fee",
        label: t("batchImport.template.fund.label.fee"),
        kind: "number",
        placeholder: t("batchImport.numberExpressionPlaceholder"),
      },
      {
        value: "date",
        label: t("batchImport.fundPreview.applicationDateOffset"),
        kind: "number",
        placeholder: t("batchImport.fundPreview.dateOffsetPlaceholder"),
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
    [cashAccountOptions, fundAccountOptions, t],
  );


  // —— 净值异步回填 ——
  // 服务端预览最多等 1.2s 抓净值就先返回明细，剩下的继续后台抓（用户 2026-10-30：
  // 「明细要 1 秒内出来」）。这里在 3s / 9s 各静默问一次，只补「还没有净值」的行：
  // 不动勾选、不动用户已经改过的行、不改用户手填的净值/份额。
  const navBackfillTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastPreviewRequestRef = useRef<FundImportUploadItem[] | null>(null);

  const clearNavBackfillTimers = useCallback(() => {
    for (const timer of navBackfillTimersRef.current) clearTimeout(timer);
    navBackfillTimersRef.current = [];
  }, []);

  const runNavBackfill = useCallback(async () => {
    const sourceItems = lastPreviewRequestRef.current;
    if (!open || !sourceItems || sourceItems.length === 0) return;
    try {
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          items: sourceItems,
          ...(requestContext ? { context: requestContext } : {}),
          ...(autoCreateInstitutionAccounts ? { createInstitutionAccounts: true } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; items?: FundImportPreviewItem[] } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) return;
      setPreviewItems((prev) => mergeNavBackfillRows(prev, data.items!));
    } catch {
      // 回填是静默优化：失败就保持空白，用户仍可手填
    }
  }, [autoCreateInstitutionAccounts, open, requestContext]);

  const requestPreview = useCallback(async (
    sourceItems: FundImportUploadItem[],
    preserveSelection: boolean,
    fileInfo?: string,
  ) => {
    setUploading(true);
    try {
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          items: sourceItems,
          ...(requestContext ? { context: requestContext } : {}),
          ...(autoCreateInstitutionAccounts ? { createInstitutionAccounts: true } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: FundImportPreviewItem[]; navMissingCount?: number; navPending?: boolean } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      setPreviewItems(data.items);
      setSelected((prev) => preserveSelection
        ? new Set(Array.from(prev).filter((idx) => idx < data.items!.length))
        : selectableIndexes(data.items!));
      setDebugMessage(null);
      setMessage(null);
      // 明细已经出来了；还有净值在路上就排两次静默回填。
      lastPreviewRequestRef.current = sourceItems;
      clearNavBackfillTimers();
      if (shouldBackfillNav(data.navMissingCount)) {
        for (const delay of NAV_BACKFILL_DELAYS_MS) {
          navBackfillTimersRef.current.push(setTimeout(() => { void runNavBackfill(); }, delay));
        }
      }
      return true;
    } catch (error) {
      setPreviewItems([]);
      setSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setDebugMessage(formatText(t, "batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo: fileInfo || "" }));
      setMessage(formatText(t, "batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
      return false;
    } finally {
      setUploading(false);
    }
  }, [autoCreateInstitutionAccounts, clearNavBackfillTimers, requestContext, runNavBackfill, t]);

  // 局部预览：只把改动的行发给服务端重算（账户匹配/净值/份额/确认到账日都是逐行无状态计算），
  // 响应按行号写回，避免大数据量时每次单元格编辑都全表重发导致界面卡顿。
  const requestPreviewForRows = useCallback(async (patches: Array<{ index: number; item: FundImportUploadItem }>) => {
    const usable = patches.filter((entry) => entry.item);
    if (usable.length === 0) return false;
    setRowPatching(true);
    try {
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          items: usable.map((entry) => entry.item),
          ...(requestContext ? { context: requestContext } : {}),
          ...(autoCreateInstitutionAccounts ? { createInstitutionAccounts: true } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: FundImportPreviewItem[] } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      const enriched = data.items;
      setPreviewItems((prev) => {
        const next = [...prev];
        usable.forEach((entry, k) => {
          if (enriched[k]) next[entry.index] = enriched[k];
        });
        return next;
      });
      setDebugMessage(null);
      setMessage(null);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(formatText(t, "batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
      return false;
    } finally {
      setRowPatching(false);
    }
  }, [autoCreateInstitutionAccounts, requestContext, t]);

  const applyPreviewReplace = useCallback((field: FundPreviewBatchEditField, value: string) => {
    const selectedIndexes = new Set(Array.from(selected).filter((idx) => previewItems[idx]));
    if (selectedIndexes.size === 0) throw new Error(t("batchImport.fundPreview.selectRowsFirst"));

    // 账户字段（基金账户/资金账户）：批量设定后重新走服务端预览（账户变了，阻断项/确认到账日都会变）。
    // 只重发被改的行，避免大数据量时整表重算导致界面卡顿。
    if (field === "fundAccount" || field === "cashAccount") {
      const accountId = value.trim();
      const displayById = field === "fundAccount" ? fundAccountDisplayById : cashAccountDisplayById;
      const account = accountId ? displayById.get(accountId) : undefined;
      if (accountId && !account) throw new Error(t("batchImport.fundPreview.batchAccountNotFound"));
      const patches: Array<{ index: number; item: FundImportUploadItem }> = [];
      const nextUploadItems = uploadItems.map((item, index) => {
        if (!selectedIndexes.has(index)) return item;
        const nextItem = field === "fundAccount"
          ? { ...item, fundAccount: account?.name ?? "", fundAccountId: account?.id ?? null }
          : { ...item, cashAccount: account?.name ?? "", cashAccountId: account?.id ?? null };
        patches.push({ index, item: nextItem });
        return nextItem;
      });
      setUploadItems(nextUploadItems);
      void requestPreviewForRows(patches);
      return t("batchImport.fundPreview.batchReplaceResult", {
        count: selectedIndexes.size,
        field: field === "fundAccount"
          ? t("batchImport.template.fund.label.fundAccount")
          : t("batchImport.template.fund.label.cashAccount"),
        invalidSuffix: "",
      });
    }

    // 代码 / 交易类型 / 费率 / 净值 / 申请日期：改完都要重新算净值、份额、确认到账日与阻断项，
    // 只把改动的行发给服务端重算（服务端净值已按基金批量预取过，是缓存命中，不会逐行联网）。
    if (field === "fundCode" || field === "fundSubtype" || field === "feeRate" || field === "nav" || field === "date") {
      const raw = value.trim();
      const patches: Array<{ index: number; item: FundImportUploadItem }> = [];
      let invalid = 0;
      const nextUploadItems = uploadItems.map((item, index) => {
        if (!selectedIndexes.has(index)) return item;
        let nextItem: FundImportUploadItem | null = null;
        if (field === "fundCode") {
          const code = raw.replace(/\s+/g, "");
          if (!/^\d{6}$/.test(code)) {
            invalid += 1;
            return item;
          }
          // 换了基金，名称 / 净值 / 份额都不再成立，交给服务端按新代码重算。
          nextItem = { ...item, fundCode: code, nav: null, units: null };
        } else if (field === "fundSubtype") {
          if (!(FUND_PREVIEW_SUBTYPES as readonly string[]).includes(raw)) {
            invalid += 1;
            return item;
          }
          nextItem = { ...item, fundSubtype: raw };
        } else if (field === "feeRate") {
          const rate = evaluateCalcInputExpression(raw, item.feeRateInput ?? 0);
          if (rate == null || rate < 0) {
            invalid += 1;
            return item;
          }
          nextItem = { ...item, feeRateInput: rate, fee: null };
        } else if (field === "nav") {
          const nextNav = evaluateCalcInputExpression(raw, item.nav ?? 0);
          if (nextNav == null || !(nextNav > 0)) {
            invalid += 1;
            return item;
          }
          nextItem = { ...item, nav: nextNav, units: null };
        } else {
          const fundAccount = item.fundAccountId ? accountById.get(item.fundAccountId) : undefined;
          const nextDate = applyFundDateOffset(item, raw, fundAccount?.tradingCalendar);
          if (nextDate === undefined) {
            invalid += 1;
            return item;
          }
          nextItem = { ...item, date: nextDate };
        }
        patches.push({ index, item: nextItem });
        return nextItem;
      });
      setUploadItems(nextUploadItems);
      void requestPreviewForRows(patches);
      return t("batchImport.fundPreview.batchReplaceResult", {
        count: patches.length,
        field: t(FUND_PREVIEW_BATCH_FIELD_LABEL_KEYS[field]),
        invalidSuffix: invalid > 0
          ? t("batchImport.fundPreview.invalidNumberSkipped", { count: invalid })
          : "",
      });
    }

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
      field: t(FUND_PREVIEW_BATCH_FIELD_LABEL_KEYS[field]),
      invalidSuffix,
    });
  }, [accountById, cashAccountDisplayById, fundAccountDisplayById, previewItems, requestPreviewForRows, selected, t, uploadItems]);

  useEffect(() => {
    if (!file) {
      loadedFileRef.current = null;
      setUploadItems([]);
      setPreviewItems([]);
      setBookAccounts([]);
      setSelected(new Set());
      setUploading(false);
      setImporting(false);
      setMessage(null);
      setDebugMessage(null);
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      return;
    }
    // 只是切到另一个页签（open 变 false）时不要清空：切回来还要再解析 + 再请求一遍，
    // 期间表格是空的，看起来就是「数据全没了」。
    if (!open) return;
    if (loadedFileRef.current === file) return;
    loadedFileRef.current = file;

    let cancelled = false;
    const fileInfo = formatText(t, "batchImport.fileInfo", {
      name: file.name,
      type: file.type || t("batchImport.fileTypeUnknown"),
      sizeKb: Math.round(file.size / 1024),
    });

    async function load() {
      setUploading(true);
      setImporting(false);
      // 只保留这一条状态（正在读取文件：…）；「已选择文件，开始读取。文件：…；类型：…」
      // 与它重复（用户 2026-10-30），文件名/类型/大小的诊断信息留给失败时的 debug 行。
      setDebugMessage(null);
      setMessage(formatText(t, "batchImport.readingFileName", { name: sourceLabel || file!.name }));
      setUploadItems([]);
      setPreviewItems([]);
      setSelected(new Set());
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      try {
        const parseResult = await parseFundImportFile(file!);
        if (cancelled) return;
        const parsed = fundRowsToItems(parseResult.rows, t("settings.accounts.import.sheetGuideTitle"));
        if (parsed.length === 0) {
          const headers = parseResult.rows[0]?.join("、") || t("batchImport.headersNotRead");
          setDebugMessage(formatText(t, "batchImport.noRecordsRecognizedDebug", { headers, fileInfo }));
          setMessage(formatText(t, "batchImport.noRecordsRecognizedMessage", { name: sourceLabel || file!.name, headers }));
          setUploading(false);
          return;
        }
        setUploadItems(parsed);
        await requestPreview(parsed, false, fileInfo);
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
      // 换文件 / 关窗口 / 卸载：把还没跑的回填定时器清掉，别再打一遍接口。
      clearNavBackfillTimers();
    };
  }, [clearNavBackfillTimers, file, open, requestPreview, sourceLabel, t]);

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

  const patchUploadItem = useCallback(async (idx: number, patch: Partial<FundImportUploadItem>) => {
    const currentItem = uploadItems[idx];
    if (!currentItem) return;
    const nextItem = { ...currentItem, ...patch };
    setUploadItems((prev) => prev.map((item, index) => index === idx ? nextItem : item));
    setEditingCell(null);
    setDraftValue("");
    setDraftOriginalValue("");
    await requestPreviewForRows([{ index: idx, item: nextItem }]);
  }, [requestPreviewForRows, uploadItems]);

  // 同一个基金名只需要认一次：一次请求把补丁打到所有同名行，
  // 避免「逐行 PATCH」在几百行账单上刷屏。
  const patchUploadItems = useCallback(async (
    patches: Array<{ idx: number; patch: Partial<FundImportUploadItem> }>,
  ) => {
    if (patches.length === 0) return;
    const byIndex = new Map<number, FundImportUploadItem>();
    for (const entry of patches) {
      const currentItem = uploadItems[entry.idx];
      if (!currentItem) continue;
      byIndex.set(entry.idx, { ...currentItem, ...entry.patch });
    }
    if (byIndex.size === 0) return;
    setUploadItems((prev) => prev.map((item, index) => byIndex.get(index) ?? item));
    await requestPreviewForRows(Array.from(byIndex, ([index, item]) => ({ index, item })));
  }, [requestPreviewForRows, uploadItems]);

  const editFieldLabel = useCallback((field: FundPreviewEditField) => t(FUND_PREVIEW_FIELD_LABEL_KEYS[field]), [t]);

  const editTitle = useCallback(
    (field: FundPreviewEditField, extra?: string) => {
      const base = t("statementImportPreview.doubleClickEdit", { field: editFieldLabel(field) });
      return extra ? `${base}\n${extra}` : base;
    },
    [editFieldLabel, t],
  );

  function draftValueFromRow(row: FundPreviewTableRow, field: FundPreviewEditField) {
    switch (field) {
      case "date": return row.date || "";
      case "fundSubtype": return row.fundSubtype || "";
      case "cashAccount": return row.cashAccount || "";
      case "fundAccount": return row.fundAccount || "";
      case "fundCode": return row.fundCode || "";
      case "amount": return row.amount == null ? "" : formatAmountDraft(row.amount);
      case "feeRate": return row.feeRate == null ? "" : String(row.feeRate);
      case "fee": return row.fee == null ? "" : formatAmountDraft(row.fee);
      case "nav": return row.nav == null ? "" : String(row.nav);
      case "units": return row.units == null ? "" : String(row.units);
      case "confirmDate": return row.confirmDate || "";
      case "arrivalDate": return row.arrivalDate || "";
      case "remark": return row.remark || "";
      case "tags": return row.tags || "";
      default: return "";
    }
  }

  const beginCellEdit = useCallback((row: FundPreviewTableRow, field: FundPreviewEditField) => {
    if (uploading || importing || rowPatching) return;
    skipNextEditCommitRef.current = false;
    const nextDraftValue = draftValueFromRow(row, field);
    setEditingCell({ idx: row.idx, field });
    setDraftValue(nextDraftValue);
    setDraftOriginalValue(nextDraftValue);
  }, [importing, rowPatching, uploading]);

  const commitDraftEdit = useCallback(async () => {
    if (skipNextEditCommitRef.current) {
      skipNextEditCommitRef.current = false;
      return;
    }
    const current = editingCell;
    if (!current) return;
    const value = draftValue.trim();
    if (value === draftOriginalValue.trim()) {
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      return;
    }

    let patch: Partial<FundImportUploadItem> | null = null;
    switch (current.field) {
      case "date":
        patch = { date: value };
        break;
      case "fundSubtype":
        patch = { fundSubtype: value };
        break;
      case "cashAccount":
        patch = { cashAccount: value, cashAccountId: null };
        break;
      case "fundAccount":
        patch = { fundAccount: value, fundAccountId: null };
        break;
      case "fundCode": {
        patch = { fundCode: value };
        // 账单里同一只基金会出现几十次，改一次就同步到所有同名行，
        // 不用重复手填同一个代码。
        const currentRow = previewRows.find((item) => item.idx === current.idx);
        const siblings = value && currentRow?.fundName
          ? previewRows.filter((item) => item.idx !== current.idx
            && item.fundName === currentRow.fundName
            && !item.fundCode)
          : [];
        if (siblings.length > 0
          && window.confirm(formatText(t, "batchImport.fundCodeSyncConfirm", { count: siblings.length }))) {
          await patchUploadItems([
            { idx: current.idx, patch },
            ...siblings.map((item) => ({ idx: item.idx, patch: { fundCode: value } })),
          ]);
          setEditingCell(null);
          setDraftValue("");
          setDraftOriginalValue("");
          return;
        }
        break;
      }
      case "amount":
        patch = { amount: parseEditableNumber(value) ?? 0 };
        break;
      case "feeRate":
        patch = { feeRateInput: parseFundFeeRateInput(value), fee: null };
        break;
      case "fee":
        patch = { fee: parseNonNegativeEditableNumber(value), feeRateInput: null };
        break;
      case "nav":
        patch = { nav: parseNonNegativeEditableNumber(value) };
        break;
      case "units":
        patch = { units: parseNonNegativeEditableNumber(value) };
        break;
      case "confirmDate":
        patch = { confirmDate: value || null };
        break;
      case "arrivalDate":
        patch = { arrivalDate: value || null };
        break;
      case "remark":
        patch = { remark: value };
        break;
      case "tags":
        patch = { tags: value || null };
        break;
      default:
        patch = null;
    }
    if (!patch) {
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      return;
    }
    await patchUploadItem(current.idx, patch);
  }, [draftOriginalValue, draftValue, editingCell, patchUploadItem, patchUploadItems, previewRows, t]);

  function cancelDraftEdit() {
    skipNextEditCommitRef.current = true;
    setEditingCell(null);
    setDraftValue("");
    setDraftOriginalValue("");
  }

  function stopCellEvent(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function editableCellProps(row: FundPreviewTableRow, field: FundPreviewEditField) {
    return {
      "data-row-double-click-ignore": true,
      onMouseDown: stopCellEvent,
      onClick: stopCellEvent,
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        event.stopPropagation();
        beginCellEdit(row, field);
      },
    };
  }

  function editableInputProps(field: FundPreviewEditField) {
    return {
      "data-row-double-click-ignore": true,
      autoFocus: true,
      onMouseDown: stopCellEvent,
      onClick: stopCellEvent,
      onDoubleClick: stopCellEvent,
      onFocus: (event: ReactFocusEvent<HTMLInputElement>) => event.currentTarget.select(),
      onChange: (event: ReactChangeEvent<HTMLInputElement>) => setDraftValue(event.target.value),
      onBlur: () => void commitDraftEdit(),
      onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") cancelDraftEdit();
      },
      className: [
        "h-7 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none",
        field === "remark" || field === "fundCode" || field === "tags" ? "w-full" : "w-24",
        FUND_PREVIEW_COMPONENT_NUMBER_FIELDS.includes(field as typeof FUND_PREVIEW_COMPONENT_NUMBER_FIELDS[number])
          ? "text-right tabular-nums"
          : "",
      ].filter(Boolean).join(" "),
    };
  }

  function renderTextEditCell(row: FundPreviewTableRow, field: FundPreviewEditField, value: string | null | undefined, className = "text-slate-700") {
    const isEditing = editingCell?.idx === row.idx && editingCell.field === field;
    if (isEditing) {
      return (
        <input
          type={field === "date" || field === "confirmDate" || field === "arrivalDate" ? "date" : "text"}
          value={draftValue}
          {...editableInputProps(field)}
        />
      );
    }
    return (
      <span
        className={`block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100 ${className}`}
        title={editTitle(field)}
        {...editableCellProps(row, field)}
      >
        {String(value ?? "").trim() || "-"}
      </span>
    );
  }

  function renderNumberEditCell(
    row: FundPreviewTableRow,
    field: FundPreviewEditField,
    value: number | null | undefined,
    digits = 2,
    calculatedField?: FundImportCalculatedField,
    suffix = "",
  ) {
    const isEditing = editingCell?.idx === row.idx && editingCell.field === field;
    if (isEditing) {
      return (
        <input
          type="text"
          inputMode="decimal"
          value={draftValue}
          {...editableInputProps(field)}
        />
      );
    }
    const calculated = calculatedField ? row.calculatedFields?.includes(calculatedField) ?? false : false;
    const formatted = formatOptionalNumber(value, digits);
    return (
      <span
        className={`block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 text-right tabular-nums hover:bg-slate-100 ${calculated ? "italic text-slate-500" : "text-slate-700"}`}
        title={editTitle(field, calculated ? t("viewImport.calculatedValue") : undefined)}
        {...editableCellProps(row, field)}
      >
        {formatted === "-" ? formatted : `${formatted}${suffix}`}
      </span>
    );
  }

  function renderSubtypeCell(row: FundPreviewTableRow) {
    if (editingCell?.idx === row.idx && editingCell.field === "fundSubtype") {
      const subtypeOptions = Array.from(new Set([row.fundSubtype, ...FUND_PREVIEW_SUBTYPES].filter(Boolean)));
      return (
        <select
          data-row-double-click-ignore
          autoFocus
          className="h-7 w-full rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
          value={row.fundSubtype}
          onMouseDown={stopCellEvent}
          onClick={stopCellEvent}
          onDoubleClick={stopCellEvent}
          onBlur={() => setEditingCell(null)}
          onChange={(event) => void patchUploadItem(row.idx, { fundSubtype: event.target.value })}
        >
          {subtypeOptions.map((subtype) => (
            <option key={subtype} value={subtype}>{getFundImportSubtypeLabel(subtype, row.source, t)}</option>
          ))}
        </select>
      );
    }
    return renderTextEditCell(row, "fundSubtype", getFundImportSubtypeLabel(row.fundSubtype, row.source, t));
  }

  function renderAccountEditCell(row: FundPreviewTableRow, field: "cashAccount" | "fundAccount") {
    const isCashField = field === "cashAccount";
    const accountId = isCashField ? row.cashAccountId : row.fundAccountId;
    const fallback = isCashField ? row.cashAccount : row.fundAccount;
    const options = isCashField ? cashAccountOptions : fundAccountOptions;
    const displayById = isCashField ? cashAccountDisplayById : fundAccountDisplayById;
    const label = previewAccountLabel(accountId, fallback);
    const title = previewAccountTitle(accountId, fallback) || editTitle(field);
    if (editingCell?.idx === row.idx && editingCell.field === field) {
      return (
        <div data-row-double-click-ignore onMouseDown={stopCellEvent} onClick={stopCellEvent} onDoubleClick={stopCellEvent}>
          <SmartSelect
            mode="single"
            value={accountId ?? ""}
            onChange={(nextAccountId) => {
              const account = displayById.get(nextAccountId);
              void patchUploadItem(row.idx, isCashField
                ? { cashAccountId: nextAccountId || null, cashAccount: account?.selectorLabel ?? "" }
                : { fundAccountId: nextAccountId || null, fundAccount: account?.selectorLabel ?? "" });
            }}
            options={options}
            placeholder={t(isCashField ? "batchImport.template.fund.label.cashAccount" : "batchImport.template.fund.label.fundAccount")}
            behavior={{
              search: true,
              hierarchy: true,
              clearable: true,
              minDropdownWidth: 260,
              fitContent: true,
              dropdownMaxHeight: 240,
              density: "micro",
              resizableDropdown: true,
              autoOpen: true,
              onDropdownClose: () => setEditingCell(null),
            }}
          />
        </div>
      );
    }
    return (
      <span
        className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 text-slate-700 hover:bg-slate-100"
        title={title}
        {...editableCellProps(row, field)}
      >
        {label}
      </span>
    );
  }

  const handleImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
    // 允许勾选未匹配行做批量修改；确认导入时只提交无 error 的勾选行
    const selectedItems = selectedIndexes
      .map((idx) => previewItems[idx])
      .filter((item): item is FundImportPreviewItem => Boolean(item) && !hasBlockingIssue(item));
    if (selectedItems.length === 0) {
      const selectedBlocking = selectedIndexes
        .map((idx) => previewItems[idx])
        .filter((item): item is FundImportPreviewItem => Boolean(item) && hasBlockingIssue(item));
      if (selectedBlocking.length > 0) {
        setMessage(formatText(t, "batchImport.importReadyEmpty", { count: selectedBlocking.length }));
      }
      return;
    }

    setImporting(true);
    setMessage(formatText(t, "batchImport.fundImportingSelected", { count: selectedItems.length }));
    setDebugMessage(null);
    setImportProgress({ imported: 0, total: selectedItems.length });
    let created = 0;
    let importedRows = 0;

    try {
      const allAccountIds = new Set<string>();
      // Submit in sequential batches so each request finishes well before
      // reverse-proxy timeouts on slow NAS deployments; batching also keeps the
      // server-side write transaction small so it stays under the timeout.
      const IMPORT_BATCH_SIZE = Math.max(1, Math.ceil(selectedItems.length / 10));
      for (let start = 0; start < selectedItems.length; start += IMPORT_BATCH_SIZE) {
        const batchItems = selectedItems.slice(start, start + IMPORT_BATCH_SIZE);
        setImportProgress({ imported: importedRows, total: selectedItems.length });
        const res = await fetch("/api/v1/fund/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "import",
            items: batchItems,
            ...(requestContext ? { context: requestContext } : {}),
            ...(autoCreateInstitutionAccounts ? { createInstitutionAccounts: true } : {}),
          }),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number; accountIds?: string[] } | null;
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
        }
        created += data.createdCount ?? batchItems.length;
        for (const id of Array.isArray(data.accountIds) ? data.accountIds : []) allAccountIds.add(id);
        importedRows += batchItems.length;
        setImportProgress({ imported: importedRows, total: selectedItems.length });
      }
      const accountIds = allAccountIds.size > 0
        ? Array.from(allAccountIds)
        : Array.from(new Set(selectedItems.map((item) => item.fundAccountId).filter((id): id is string => Boolean(id))));
      recordRecentAccounts(accountIds);
      dispatchFinanceDataChanged({ reason: "fund-excel-import", accountIds });
      onImported?.({ count: created, accountIds });
      onClose();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (created > 0 && importedRows < selectedItems.length) {
        setMessage(formatText(t, "batchImport.fundImportPartialFailed", {
          imported: created,
          remaining: selectedItems.length - importedRows,
          reason,
        }));
      } else {
        setMessage(formatText(t, "batchImport.importFailedRollback", { reason }));
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [autoCreateInstitutionAccounts, errorIssues, importIssues, importing, onClose, onImported, previewItems, requestContext, setImportProgress, selected, t]);

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
    { key: "date", label: t("batchImport.template.fund.label.date"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.date || "-", sortValue: (row) => row.date || "", render: (row) => renderTextEditCell(row, "date", row.date, "tabular-nums text-slate-700") },
    { key: "fundSubtype", label: t("batchImport.template.fund.label.fundSubtype"), width: 116, minWidth: 92, filterText: (row) => getFundImportSubtypeLabel(row.fundSubtype, row.source, t), render: renderSubtypeCell },
    {
      key: "cashAccount",
      label: t("batchImport.template.fund.label.cashAccount"),
      width: 180,
      minWidth: 130,
      filterText: (row) => previewAccountLabel(row.cashAccountId, row.cashAccount),
      render: (row) => renderAccountEditCell(row, "cashAccount"),
    },
    {
      key: "fundAccount",
      label: t("batchImport.template.fund.label.fundAccount"),
      width: 180,
      minWidth: 130,
      filterText: (row) => previewAccountLabel(row.fundAccountId, row.fundAccount),
      render: (row) => renderAccountEditCell(row, "fundAccount"),
    },
    { key: "fundCode", label: t("batchImport.template.fund.label.fundCode"), width: 96, minWidth: 76, filterText: (row) => row.fundCode || "-", render: (row) => renderTextEditCell(row, "fundCode", row.fundCode, "tabular-nums text-slate-700") },
    { key: "fundName", label: t("batchImport.template.fund.label.fundName"), width: 220, minWidth: 150, filterText: (row) => row.fundName || "-", render: (row) => <span className="truncate text-slate-700" title={row.fundName || ""}>{row.fundName || "-"}</span> },
    { key: "amount", label: t("batchImport.template.fund.label.amount"), width: 116, minWidth: 90, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.amount, 2), filterNumber: (row) => row.amount, sortValue: (row) => row.amount, render: (row) => renderNumberEditCell(row, "amount", row.amount, 2) },
    { key: "feeRate", label: t("batchImport.template.fund.label.feeRate"), width: 96, minWidth: 78, align: "right", filterKind: "numberRange", filterText: (row) => row.feeRate != null ? row.feeRate.toFixed(4) : "-", filterNumber: (row) => row.feeRate, sortValue: (row) => row.feeRate ?? 0, render: (row) => renderNumberEditCell(row, "feeRate", row.feeRate, 4, "feeRate", "%") },
    { key: "fee", label: t("batchImport.template.fund.label.fee"), width: 96, minWidth: 76, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.fee, 2), filterNumber: (row) => row.fee, sortValue: (row) => row.fee ?? 0, render: (row) => renderNumberEditCell(row, "fee", row.fee, 2, "fee") },
    { key: "nav", label: t("batchImport.template.fund.label.nav"), width: 96, minWidth: 78, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.nav, 4), filterNumber: (row) => row.nav, sortValue: (row) => row.nav ?? 0, render: (row) => renderNumberEditCell(row, "nav", row.nav, 4, "nav") },
    { key: "units", label: t("batchImport.template.fund.label.units"), width: 116, minWidth: 90, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.units, 2), filterNumber: (row) => row.units, sortValue: (row) => row.units ?? 0, render: (row) => renderNumberEditCell(row, "units", row.units, 2, "units") },
    { key: "confirmDate", label: t("batchImport.template.fund.label.confirmDate"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.confirmDate || "-", sortValue: (row) => row.confirmDate || "", render: (row) => renderTextEditCell(row, "confirmDate", row.confirmDate, "tabular-nums text-slate-700") },
    { key: "arrivalDate", label: t("batchImport.template.fund.label.arrivalDate"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.arrivalDate || "-", sortValue: (row) => row.arrivalDate || "", render: (row) => renderTextEditCell(row, "arrivalDate", row.arrivalDate, "tabular-nums text-slate-700") },
    { key: "remark", label: t("batchImport.template.fund.label.remark"), width: 220, minWidth: 150, filterText: (row) => row.remark || "-", render: (row) => renderTextEditCell(row, "remark", row.remark) },
    { key: "tags", label: t("detail.column.tags"), width: 150, minWidth: 110, filterText: (row) => row.tags || "-", render: (row) => renderTextEditCell(row, "tags", row.tags) },
  ], [cashAccountDisplayById, cashAccountOptions, draftValue, editingCell, fundAccountDisplayById, fundAccountOptions, importing, patchUploadItem, previewAccountLabel, previewAccountTitle, t, uploading]);

  if (!open || !file) return null;

  return (
    <ModalLayer
      className="fixed inset-0 flex items-center justify-center bg-slate-900/40 p-4"
      style={hidden ? { display: "none" } : undefined}
    >
      <div data-smart-select-boundary data-batch-popover-boundary className="flex h-[82vh] min-h-[420px] w-[80rem] min-w-[720px] max-w-[calc(100vw-2rem)] resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        {/* 窗口标题栏在卡片**外面**：外框只有这一个，页签 / 卡片都在它里面。
            与账单预览共用 `ImportPreviewHeader`（原先这里的标题是 text-base、说明是 mt-1
            且不截断，切到账单页签时字号和高度都变，看起来像闪一下）。 */}
        <ImportPreviewHeader
          title={t("batchImport.previewFundTitle")}
          description={uploading ? t("batchImport.previewParsing") : formatText(t, "batchImport.previewFundHint", { count: previewItems.length })}
          onClose={onClose}
          closeDisabled={importing}
          closeLabel={t("table.close")}
        />
        {/* FT 卡片：页签条是流内元素，卡片顶边由它撑出来，活动页签的 -mb-px
            正好压在卡片 1px 上边框上（几何同 FolderTabsCard，容器是固定高度所以用
            ft-card-surface-fill）。 */}
        <div className="relative flex min-h-0 flex-1 flex-col p-3">
          <div className="relative flex min-h-0 flex-col">
            {tabs}
            <div className="ft-card-surface ft-card-surface-fill">
              <div className="flex min-h-0 flex-1 flex-col">
        {message ? (
          <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
            {message}
          </div>
        ) : null}
        {importProgress && importProgress.total > 0 ? (
          <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-blue-100">
              <div
                className="h-full bg-blue-600 transition-all duration-200"
                style={{ width: `${Math.max(2, Math.round((importProgress.imported / importProgress.total) * 100))}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-blue-700">
              {formatText(t, "batchImport.fundImportingProgress", { imported: importProgress.imported, total: importProgress.total })}
            </div>
          </div>
        ) : null}
        {debugMessage ? (
          <div className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            {debugMessage}
          </div>
        ) : null}
        {/* 卡片内首块不能带灰底：它紧贴活动页签，灰底 + border-b 看着就是「页签与
            卡片之间被一条线隔开」。留白区改用卡片底色，分区线停在它下沿。 */}
        <div className="shrink-0 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="font-medium text-slate-700">{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
            {errorIssues.length > 0 ? (
              <span className="font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: errorIssues.length })}</span>
            ) : null}
            {warningIssues.length > 0 ? (
              <span className="font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: warningIssues.length })}</span>
            ) : null}
            <span className="italic text-slate-500">{t("viewImport.calculatedValueHint")}</span>
          </div>
          {errorSummary ? (
            <div className="mt-2 text-xs text-red-700">
              <span className="font-medium text-red-800">{t("batchImport.fundPreview.blockingSummaryTitle")}</span>
              <span className="ml-1">{errorSummary}</span>
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
              setSelected(new Set(Array.from(keys)
                .map((key) => Number(key))
                .filter((idx) => Number.isInteger(idx) && previewItems[idx])));
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
                <label className="inline-flex shrink-0 items-center gap-1.5 text-slate-600">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                    checked={autoCreateInstitutionAccounts}
                    disabled={uploading || importing}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setAutoCreateInstitutionAccounts(next);
                      if (uploadItems.length > 0) void requestPreview(uploadItems, true);
                    }}
                  />
                  <span>{t("batchImport.fundPreview.createInstitutionCashAccount")}</span>
                </label>
                <span>{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
                <span className="italic">{t("viewImport.calculatedValueHint")}</span>
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
            selectAllPreferred={(row) => !hasBlockingIssue(row)}
            showColumnVisibilityButton={false}
            resetDisplayStateOnMount
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3 text-xs">
            <span className="shrink-0 text-slate-500">{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
            {errorIssues.length > 0 ? <span className="shrink-0 font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: errorIssues.length })}</span> : null}
            {warningIssues.length > 0 ? <span className="shrink-0 font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: warningIssues.length })}</span> : null}
          </div>
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={uploading || importing || rowPatching || importReadySelectedCount === 0}
              className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? t("batchImport.importing") : formatText(t, "batchImport.confirmImport", { count: importReadySelectedCount })}
            </button>
          </div>
        </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}
