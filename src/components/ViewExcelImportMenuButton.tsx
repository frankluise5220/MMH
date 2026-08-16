"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Download, FileSpreadsheet, MailSearch, Upload } from "lucide-react";
import { CreditBillMailImportDialog } from "@/components/CreditBillMailImportButton";
import { StatementImportPreviewDialog, type StatementImportPreviewItem } from "@/components/StatementImportPreviewDialog";
import {
  BATCH_IMPORT_PENDING_FILE_STORAGE_KEY,
  fileToBatchImportPayload,
} from "@/lib/batch-import-transfer";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import {
  buildStatementImportFieldHeaders,
  type StatementFieldRecognitionSample,
} from "@/lib/statement/header-catalog";
import {
  hasImportableStatementRows,
  parseStatementExcelFile,
} from "@/lib/statement/excel-preview";

type ViewExcelImportExportItem = {
  label: string;
  href?: string;
  download?: string;
  onClick?: () => void;
};

type ExportCellValue = string | number | boolean | null | undefined;

type ViewExcelImportMailImportSpec = {
  accountId?: string;
  accountName: string;
};

type ViewExcelRangeExportSpec = {
  rows: ExportCellValue[][];
  filename: string;
  sheetName?: string;
  title?: string;
  description?: string;
  dateColumnIndex?: number;
};

type ViewExcelImportMenuButtonBaseProps = {
  exportItems?: ViewExcelImportExportItem[];
  className?: string;
  dataBasicDetailImport?: boolean;
  mailImport?: ViewExcelImportMailImportSpec;
  excelExport?: ViewExcelRangeExportSpec;
};

type ViewExcelImportMenuButtonProps =
  | ({
      kind: "normal";
      accountId: string;
      accountName: string;
    } & ViewExcelImportMenuButtonBaseProps)
  | ({
      kind: "fund";
      accountId: string;
      fundAccountName: string;
      fundCode?: string;
      fundName?: string;
    } & ViewExcelImportMenuButtonBaseProps);

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

type TemplateSpec = {
  filename: string;
  sheetName: string;
  noteSheetName: string;
  headers: string[];
  labelRow?: string[];
  rows: string[][];
  notes: string[][];
};

const NORMAL_HEADERS = ["日期", "入账日期", "收支大类", "流出", "流入", "账户", "对向账户", "分类", "收支机构", "标签", "备注"];
const FUND_HEADERS = ["date", "fundSubtype", "source", "cashAccount", "fundAccount", "fundCode", "fundName", "amount", "units", "nav", "fee", "confirmDate", "arrivalDate", "remark"];

function safeFileNamePart(value: string, fallback: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").trim() || fallback;
}

function templateFor(props: ViewExcelImportMenuButtonProps, t: TranslateFn): TemplateSpec {
  if (props.kind === "fund") {
    const fundAccountName = props.fundAccountName || t("viewImport.fundAccount");
    const fundCode = props.fundCode || "000001";
    const fundName = props.fundName || t("viewImport.sampleFund");
    return {
      filename: `${t("viewImport.fundTemplateFile", { name: safeFileNamePart(fundAccountName, t("viewImport.import")) })}.xlsx`,
      sheetName: t("viewImport.sheetFundTransactions"),
      noteSheetName: t("viewImport.sheetNotes"),
      headers: FUND_HEADERS,
      labelRow: [
        t("detail.column.date"),
        t("viewImport.fundSubtype"),
        t("viewImport.source"),
        t("viewImport.cashAccount"),
        t("viewImport.fundAccount"),
        t("viewImport.fundCode"),
        t("viewImport.fundName"),
        t("viewImport.amount"),
        t("viewImport.units"),
        t("viewImport.nav"),
        t("viewImport.fee"),
        t("viewImport.navDate"),
        t("detail.column.postedAt"),
        t("detail.column.remark"),
      ],
      rows: [
        ["2026-06-03", "buy", "manual", "", fundAccountName, fundCode, fundName, "1000.00", "738.99", "1.3521", "1.00", "2026-06-04", "2026-06-04", "申购"],
        ["2026-06-20", "redeem", "manual", "", fundAccountName, fundCode, fundName, "500.00", "360.00", "1.3889", "0.50", "2026-06-21", "2026-06-23", "赎回"],
      ],
      notes: [
        [t("viewImport.notesIntroLabel"), t("viewImport.notesIntroFund")],
        [t("viewImport.notesRecognitionLabel"), t("viewImport.notesRecognitionFund")],
        ["fundSubtype", t("viewImport.notesFundSubtype")],
        ["source", t("viewImport.notesSource")],
        ["cashAccount", t("viewImport.notesCashAccount")],
        ["fundAccount", t("viewImport.notesFundAccount")],
        ["fundCode", t("viewImport.notesFundCode")],
        ["amount", t("viewImport.notesFundAmount")],
        ["units/nav/fee", t("viewImport.notesUnitsNavFee")],
        ["confirmDate/arrivalDate", t("viewImport.notesConfirmArrival")],
        ["remark", t("viewImport.notesRemark")],
      ],
    };
  }

  const accountName = props.accountName || t("viewImport.currentAccount");
  const isCreditCardTemplate = /信用卡|贷记卡|credit\s*card/i.test(accountName);
  return {
    filename: `${t("viewImport.billTemplateFile", { name: safeFileNamePart(accountName, t("viewImport.import")) })}.xlsx`,
    sheetName: t("viewImport.sheetBillRecords"),
    noteSheetName: t("viewImport.sheetNotes"),
    headers: NORMAL_HEADERS,
    rows: isCreditCardTemplate
      ? [
        ["2026-06-08", "2026-06-09", "支出", "32.50", "", accountName, "", "餐饮", "麦当劳", "午餐", "信用卡消费"],
        ["2026-06-05", "2026-06-06", "支出", "", "20.00", accountName, "", "餐饮", "示例餐厅", "", "信用卡退款"],
        ["2026-06-20", "2026-06-20", "转账", "", "108.00", accountName, "招商银行2758", "", "", "", "信用卡还款"],
      ]
      : [
        ["2026-06-08", "2026-06-09", "支出", "32.50", "", accountName, "", "餐饮", "麦当劳", "午餐", "午餐"],
        ["2026-06-08", "", "收入", "", "1.28", accountName, "", "利息收入", "", "利息", "活期利息"],
        ["2026-06-20", "", "转账", "1000.00", "", accountName, "现金", "", "", "", "转账"],
      ],
    notes: [
      [t("viewImport.notesIntroLabel"), t("viewImport.notesIntroNormal")],
      [t("viewImport.notesRecognitionLabel"), t("viewImport.notesRecognitionNormal")],
      [t("detail.column.date"), t("viewImport.notesDate")],
      [t("detail.column.postedAt"), t("viewImport.notesPostedAt")],
      [t("viewImport.activityType"), t("viewImport.notesActivityType")],
      [t("detail.column.outflow"), t("viewImport.notesOutflow")],
      [t("detail.column.inflow"), t("viewImport.notesInflow")],
      [t("viewImport.account"), t("viewImport.notesAccount")],
      [t("viewImport.counterAccount"), t("viewImport.notesCounterAccount")],
      [t("detail.column.category"), t("viewImport.notesCategory")],
      [t("detail.column.counterparty"), t("viewImport.notesCounterparty")],
      [t("detail.column.tags"), t("viewImport.notesTags")],
      [t("detail.column.remark"), t("viewImport.notesRemark")],
    ],
  };
}

export async function exportViewImportTemplate(spec: TemplateSpec) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const rows = [spec.headers, ...(spec.labelRow ? [spec.labelRow] : []), ...spec.rows];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = spec.headers.map((header, index) => ({
    wch: Math.max(header.length, spec.labelRow?.[index]?.length ?? 0, 14),
  }));
  XLSX.utils.book_append_sheet(workbook, sheet, spec.sheetName);

  const noteSheet = XLSX.utils.aoa_to_sheet(spec.notes);
  noteSheet["!cols"] = [{ wch: 18 }, { wch: 72 }];
  XLSX.utils.book_append_sheet(workbook, noteSheet, spec.noteSheetName);
  XLSX.writeFile(workbook, spec.filename, { compression: true });
}

export async function exportRowsToXlsx(rows: ExportCellValue[][], filename: string, sheetName: string) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => cell ?? "")));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  sheet["!cols"] = Array.from({ length: columnCount }, (_, columnIndex) => {
    const width = Math.max(
      10,
      Math.min(
        36,
        ...rows.map((row) => String(row[columnIndex] ?? "").length + 2),
      ),
    );
    return { wch: width };
  });
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename, { compression: true });
}

export async function exportNormalAccountImportTemplate(accountName: string, t: TranslateFn) {
  await exportViewImportTemplate(templateFor({ kind: "normal", accountId: "", accountName }, t));
}

function parseExportDate(value: unknown) {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function exportDateBounds(rows: ExportCellValue[][], dateColumnIndex: number) {
  const dates = rows.slice(1).map((row) => parseExportDate(row[dateColumnIndex])).filter(Boolean).sort();
  return {
    start: dates[0] ?? "",
    end: dates[dates.length - 1] ?? "",
  };
}

function filenameWithDateRange(filename: string, start: string, end: string, fallback: string) {
  const suffix = start && end ? `${start}_${end}` : start || end || fallback;
  return filename.replace(/\.xlsx$/i, `-${suffix}.xlsx`);
}

export function ViewExcelImportMenuButton(props: ViewExcelImportMenuButtonProps) {
  const { t } = useI18n();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mailImportOpen, setMailImportOpen] = useState(false);
  const [excelExportOpen, setExcelExportOpen] = useState(false);
  const [excelExportStart, setExcelExportStart] = useState("");
  const [excelExportEnd, setExcelExportEnd] = useState("");
  const [excelExportError, setExcelExportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItems, setPreviewItems] = useState<StatementImportPreviewItem[]>([]);
  const [recognitionSamples, setRecognitionSamples] = useState<StatementFieldRecognitionSample[]>([]);
  const statementFieldHeaders = useMemo(
    () => buildStatementImportFieldHeaders(recognitionSamples),
    [recognitionSamples],
  );

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (props.kind !== "normal") return;
    let cancelled = false;
    fetch("/api/v1/statement/recognition-rules")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRecognitionSamples(Array.isArray(data?.samples) ? data.samples : []);
      })
      .catch(() => {
        if (!cancelled) setRecognitionSamples([]);
      });
    return () => { cancelled = true; };
  }, [props.kind]);

  async function handleExportTemplate() {
    setOpen(false);
    setBusy(true);
    try {
      await exportViewImportTemplate(templateFor(props, t));
    } catch (error) {
      setStatus(t("viewImport.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportFile(file: File) {
    setOpen(false);
    setBusy(true);
    setStatus(t("viewImport.importing"));
    try {
      if (props.kind === "normal") {
        const { localItems, preferServerRecognition, text } = await parseStatementExcelFile(file, props.accountName, statementFieldHeaders);
        let serverError: unknown = null;
        const serverItems = preferServerRecognition || !hasImportableStatementRows(localItems)
          ? await parseByServer(text).catch((error) => {
            serverError = error;
            return [] as StatementImportPreviewItem[];
          })
          : [];
        const parsedItems = hasImportableStatementRows(serverItems)
          ? serverItems
          : hasImportableStatementRows(localItems)
            ? localItems
            : [];
        if (parsedItems.length === 0 && serverError) throw serverError;
        const items = parsedItems
          .filter((item) => item.date && Number(item.amount) > 0)
          .map((item) => {
            if (item.type === "transfer") {
              return {
                ...item,
                account: item.account || props.accountName,
                toAccount: item.toAccount || item.account || props.accountName,
              };
            }
            return {
              ...item,
              account: item.account || props.accountName,
            };
          });
        if (items.length === 0) throw new Error(t("viewImport.noRows"));
        setPreviewItems(items);
        setPreviewOpen(true);
        setStatus(t("viewImport.recognizedCount", { count: items.length }));
        return;
      }

      const payload = await fileToBatchImportPayload(file, props.kind === "fund" ? "fund" : "normal");
      sessionStorage.setItem(BATCH_IMPORT_PENDING_FILE_STORAGE_KEY, JSON.stringify(payload));
      router.push("/batch-import");
    } catch (error) {
      setStatus(t("viewImport.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function parseByServer(text: string) {
    const res = await fetch("/api/v1/statement/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: StatementImportPreviewItem[] } | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error || t("viewImport.recognitionFailed"));
    return Array.isArray(data.items) ? data.items : [];
  }

  async function confirmImport(items: StatementImportPreviewItem[]) {
    if (items.length === 0 || props.kind !== "normal") return;
    setBusy(true);
    setStatus(t("viewImport.importingBills"));
    try {
      const res = await fetch("/api/v1/statement/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          defaultAccountName: props.accountName,
          autoCreateAccounts: false,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number; skippedCount?: number; errors?: Array<{ error?: string }> } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error || data?.errors?.[0]?.error || t("creditBill.importFailed"));
      const createdCount = data.createdCount ?? 0;
      const skippedCount = data.skippedCount ?? 0;
      setStatus(t("creditBill.importExcelSuccess", { created: createdCount, skipped: skippedCount }));
      setPreviewOpen(false);
      setPreviewItems([]);
      dispatchFinanceDataChanged({ reason: "statement-excel-import", accountIds: [props.accountId] });
    } catch (error) {
      setStatus(t("viewImport.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }

  function openExcelExportDialog() {
    const spec = props.excelExport;
    if (!spec) return;
    const dateColumnIndex = spec.dateColumnIndex ?? 0;
    const bounds = exportDateBounds(spec.rows, dateColumnIndex);
    setOpen(false);
    setExcelExportStart(bounds.start);
    setExcelExportEnd(bounds.end);
    setExcelExportError("");
    setExcelExportOpen(true);
  }

  async function handleExcelExport() {
    const spec = props.excelExport;
    if (!spec || busy) return;
    const dateColumnIndex = spec.dateColumnIndex ?? 0;
    if (excelExportStart && excelExportEnd && excelExportStart > excelExportEnd) {
      setExcelExportError(t("viewImport.dateRangeInvalid"));
      return;
    }
    const [header = [], ...bodyRows] = spec.rows;
    const filteredRows = bodyRows.filter((row) => {
      const date = parseExportDate(row[dateColumnIndex]);
      if (!date) return false;
      if (excelExportStart && date < excelExportStart) return false;
      if (excelExportEnd && date > excelExportEnd) return false;
      return true;
    });
    if (filteredRows.length === 0) {
      setExcelExportError(t("viewImport.noRowsInRange"));
      return;
    }
    setBusy(true);
    setExcelExportError("");
    try {
      await exportRowsToXlsx(
        [header, ...filteredRows],
        filenameWithDateRange(spec.filename, excelExportStart, excelExportEnd, t("creditBill.all")),
        spec.sheetName ?? t("viewImport.details"),
      );
      setExcelExportOpen(false);
      setStatus(t("viewImport.exportedCount", { count: filteredRows.length }));
    } catch (error) {
      setExcelExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={menuRef} className={["relative inline-flex items-center", props.className ?? ""].filter(Boolean).join(" ")}>
      <button
        type="button"
        data-basic-detail-import={props.dataBasicDetailImport ? true : undefined}
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        title={t("viewImport.title")}
      >
        <Upload className="h-3.5 w-3.5" />
        {t("creditBill.importMenu")}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div className="absolute right-0 top-8 z-50 w-44 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {props.excelExport ? (
            <button
              type="button"
              onClick={openExcelExportDialog}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {t("viewImport.exportExcel")}
            </button>
          ) : null}
          {props.exportItems?.map((item) => item.href ? (
            <a
              key={`${item.label}:${item.href}`}
              href={item.href}
              download={item.download}
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" />
              {item.label}
            </a>
          ) : (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false);
                item.onClick?.();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" />
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void handleExportTemplate()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            {t("creditBill.exportTemplate")}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              inputRef.current?.click();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {t("creditBill.importExcel")}
          </button>
          {props.mailImport ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setMailImportOpen(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <MailSearch className="h-3.5 w-3.5" />
              {t("creditBill.importMail")}
            </button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImportFile(file);
        }}
      />
      {props.mailImport ? (
        <CreditBillMailImportDialog
          open={mailImportOpen}
          onClose={() => setMailImportOpen(false)}
          accountId={props.mailImport.accountId ?? props.accountId}
          accountName={props.mailImport.accountName}
        />
      ) : null}
      {props.kind === "normal" ? (
        <StatementImportPreviewDialog
          open={previewOpen}
          title={t("viewImport.previewTitle")}
          description={t("viewImport.previewDescription")}
          items={previewItems}
          defaultAccountName={props.accountName}
          busy={busy}
          onClose={() => setPreviewOpen(false)}
          onConfirm={confirmImport}
        />
      ) : null}
      {props.excelExport && excelExportOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-900/25 px-4">
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{props.excelExport.title ?? t("viewImport.exportExcel")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {props.excelExport.description ?? t("viewImport.exportDescription")}
              </div>
            </div>
            <div className="space-y-3 px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("viewImport.exportStartDate")}</span>
                <input
                  type="date"
                  value={excelExportStart}
                  onChange={(event) => setExcelExportStart(event.target.value)}
                  className="form-input"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("viewImport.exportEndDate")}</span>
                <input
                  type="date"
                  value={excelExportEnd}
                  onChange={(event) => setExcelExportEnd(event.target.value)}
                  className="form-input"
                />
              </label>
              {excelExportError ? <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{excelExportError}</div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button type="button" onClick={() => setExcelExportOpen(false)} className="secondary-button h-8 px-3 text-xs" disabled={busy}>
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => void handleExcelExport()} className="primary-button h-8 px-3 text-xs" disabled={busy}>
                {busy ? t("viewImport.exporting") : t("viewImport.export")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {status ? <span className="ml-2 max-w-64 truncate text-xs text-slate-500" title={status}>{status}</span> : null}
    </div>
  );
}
