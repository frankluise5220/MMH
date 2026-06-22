"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { WorkBook } from "xlsx";
import { useRouter } from "next/navigation";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { TableColumnFilter } from "@/components/TableColumnFilter";

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  outflow?: number;
  inflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
  transferDirection?: "in" | "out";
};

type ImportTemplate = {
  key: "normal" | "fund" | "credit";
  title: string;
  description: string;
  status: string;
  filename: string;
  headers: string[];
  rows: string[][];
  fields: Array<{ name: string; required: boolean; note: string }>;
};

type AccountOption = {
  id: string;
  name: string;
  kind: "cash" | "bank_debit" | "bank_credit" | string;
  isActive?: boolean;
  Institution?: { id?: string; name?: string } | null;
};

type FilterColumn = "date" | "type" | "account" | "counterAccount" | "remark";
type EditableCell = "date" | "type" | "outflow" | "inflow" | "account" | "counterAccount" | "remark";
type ReplaceField = EditableCell;
type ImportIssue = { idx: number; level: "error" | "warning"; message: string };

const filterColumns: FilterColumn[] = ["date", "type", "account", "counterAccount", "remark"];
const INITIAL_PREVIEW_COUNT = 200;
const PREVIEW_COUNT_STEP = 200;

const replaceFieldLabels: Record<ReplaceField, string> = {
  date: "日期",
  type: "类型",
  outflow: "流出",
  inflow: "流入",
  account: "账户",
  counterAccount: "对向账户",
  remark: "备注",
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

const templates: ImportTemplate[] = [
  {
    key: "normal",
    title: "账单记录模板",
    description: "用于现金、借记卡、电子钱包等普通账单。模板用中文字段：日期、类型、流出、流入、账户、对向账户、备注；上传后先按类型/备注/流入/流出做初级判断。",
    status: "可上传导入",
    filename: "账单记录导入模板.csv",
    headers: ["日期", "类型", "流出", "流入", "账户", "对向账户", "备注"],
    rows: [
      ["2026-06-08", "消费", "32.50", "", "招商银行2758", "", "午餐"],
      ["2026-06-08", "结息", "", "1.28", "招商银行2758", "", "活期利息"],
      ["2026-06-08", "转出", "1000.00", "", "招商银行2758", "现金", "取现"],
      ["2026-06-08", "转账", "500.00", "", "招商银行2758", "", "账单未注明对方账户，待补"],
    ],
    fields: [
      { name: "日期", required: true, note: "交易日期，格式 YYYY-MM-DD。" },
      { name: "类型", required: false, note: "账单原始类型，如消费、转入、转出、转账、结息、退款；用于初级识别。" },
      { name: "流出", required: false, note: "账户流出金额；类型为转账/转出或有流向账户时判断为转账，否则通常判断为支出。" },
      { name: "流入", required: false, note: "账户流入金额；类型为转入时判断为转账流入，类型为结息/收入/退款时判断为收入。" },
      { name: "账户", required: true, note: "账单所属账户；支出/收入为发生账户，转账时先按账单视角显示，入库前会统一转换为资金发出方。" },
      { name: "对向账户", required: false, note: "转账另一方账户；账单没写清时可留空，上传后在确认表补。" },
      { name: "备注", required: false, note: "账单备注；会与类型一起参与识别，例如转入、转出、转账、结息、退款等。" },
    ],
  },
  {
    key: "fund",
    title: "基金记录模板",
    description: "用于基金买入、卖出、分红、手续费、净值、份额等明细。当前仅提供模板，后续需要走基金专用导入校验。",
    status: "模板已提供，导入待专用流程",
    filename: "基金记录导入模板.csv",
    headers: ["date", "action", "account", "fundCode", "fundName", "amount", "units", "nav", "fee", "confirmDate", "remark"],
    rows: [
      ["2026-06-08", "buy", "招商银行2758", "000001", "示例基金", "1000.00", "999.0000", "1.0010", "1.50", "2026-06-10", "申购"],
      ["2026-06-12", "redeem", "招商银行2758", "000001", "示例基金", "500.00", "499.0000", "1.0020", "0.50", "2026-06-14", "赎回"],
    ],
    fields: [
      { name: "date", required: true, note: "交易申请日期，格式 YYYY-MM-DD。" },
      { name: "action", required: true, note: "buy、redeem、dividend、reinvest 等。" },
      { name: "account", required: true, note: "基金所在账户名称。" },
      { name: "fundCode", required: true, note: "基金代码，后续用于净值和持仓联动。" },
      { name: "fundName", required: false, note: "基金名称，可用于补全显示。" },
      { name: "amount", required: true, note: "发生金额。" },
      { name: "units", required: false, note: "确认份额。" },
      { name: "nav", required: false, note: "成交净值。" },
      { name: "fee", required: false, note: "手续费。" },
      { name: "confirmDate", required: false, note: "确认日期，未填时按确认天数库计算。" },
      { name: "remark", required: false, note: "备注。" },
    ],
  },
  {
    key: "credit",
    title: "信用卡账单模板",
    description: "用于信用卡账单周期内的消费、退款、还款、分期等记录。当前仅提供模板，后续需要走账单专用导入校验。",
    status: "模板已提供，导入待专用流程",
    filename: "信用卡账单导入模板.csv",
    headers: ["statementMonth", "date", "type", "cardAccount", "amount", "category", "merchant", "remark", "installmentNo", "installmentTotal"],
    rows: [
      ["2026-06", "2026-06-03", "expense", "招商信用卡", "128.00", "餐饮", "示例餐厅", "晚餐", "", ""],
      ["2026-06", "2026-06-05", "refund", "招商信用卡", "20.00", "餐饮", "示例餐厅", "退款", "", ""],
      ["2026-06", "2026-06-20", "repayment", "招商信用卡", "108.00", "", "", "还款", "", ""],
    ],
    fields: [
      { name: "statementMonth", required: true, note: "账单月，格式 YYYY-MM。" },
      { name: "date", required: true, note: "入账或交易日期，格式 YYYY-MM-DD。" },
      { name: "type", required: true, note: "expense、refund、repayment、installment。" },
      { name: "cardAccount", required: true, note: "信用卡账户名称。" },
      { name: "amount", required: true, note: "账单金额，正数。退款和还款用 type 区分。" },
      { name: "category", required: false, note: "分类名称。" },
      { name: "merchant", required: false, note: "商户或交易对方。" },
      { name: "remark", required: false, note: "备注。" },
      { name: "installmentNo", required: false, note: "分期期数序号。" },
      { name: "installmentTotal", required: false, note: "分期总期数。" },
    ],
  },
];

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsv(template: ImportTemplate) {
  return [template.headers, ...template.rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
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

function inferTransferDirection(source: string, inflow: number, outflow: number): "in" | "out" {
  if (/转入|转进|他行转入|账户转入|收款/.test(source)) return "in";
  if (/转出|转账|转给|转到|汇款|跨行转账|取现|还款/.test(source)) return "out";
  if (inflow > 0 && outflow <= 0) return "in";
  return "out";
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

function normalRowsToItems(rows: string[][]): ParsedItem[] {
  const [headers = [], ...dataRows] = rows;
  const headerIndex = new Map(headers.map((header, idx) => [header.trim(), idx]));
  const read = (row: string[], key: string) => row[headerIndex.get(key) ?? -1]?.trim() ?? "";
  const readAny = (row: string[], keys: string[]) => keys.map((key) => read(row, key)).find(Boolean) ?? "";

  return dataRows.map((row) => {
    const date = normalizeDateCell(readAny(row, ["日期", "交易日期", "记账日期", "入账日期", "账单日期", "date"]));
    const rawOutflow = parseMoney(readAny(row, ["流出", "支出", "转出", "借方金额", "支出金额", "outflow"]));
    const rawInflow = parseMoney(readAny(row, ["流入", "收入", "转入", "贷方金额", "收入金额", "inflow"]));
    const rawAmount = parseMoney(readAny(row, ["金额", "交易金额", "发生额", "本币金额", "人民币金额", "amount"]));
    const account = readAny(row, ["账户", "本方账户", "交易账户", "账号", "account", "fromAccount"]);
    const counterAccount = readAny(row, ["对向账户", "流向账户", "转入账户", "转出账户", "对方账户", "对手账户", "对方户名", "toAccount", "fromAccount"]);
    const remark = readAny(row, ["备注", "remark", "摘要", "说明", "交易摘要", "交易说明", "用途"]);
    const category = readAny(row, ["分类", "category"]);
    const explicitType = readAny(row, ["类型", "交易类型", "业务类型", "收支类型", "借贷标志", "借贷方向", "type"]);
    const source = `${explicitType} ${remark}`;
    const amountLooksIncome = /结息|利息|派息|收入|工资|报销|退款|退货|返现|返利|贷方|贷记|入账|存入/.test(source);
    const amountLooksExpense = /支出|消费|扣款|付款|转出|借方|借记|取现/.test(source);
    const inflow = rawInflow || (!rawOutflow && rawAmount && amountLooksIncome ? rawAmount : 0);
    const outflow = rawOutflow || (!rawInflow && rawAmount && amountLooksExpense ? rawAmount : 0);
    const fallbackInflow = !inflow && !outflow && rawAmount && !amountLooksExpense ? rawAmount : inflow;
    const type = inferBillType(source, fallbackInflow, outflow, counterAccount);
    const transferDirection = type === "transfer" ? inferTransferDirection(source, fallbackInflow, outflow) : undefined;
    const amount = fallbackInflow > 0 ? fallbackInflow : outflow || rawAmount;

    return {
      rawText: row.join(" "),
      type,
      date,
      amount,
      outflow,
      inflow: fallbackInflow,
      account: type === "transfer" ? "" : account,
      fromAccount: type === "transfer" ? (transferDirection === "in" ? counterAccount : account) : "",
      toAccount: type === "transfer" ? (transferDirection === "in" ? account : counterAccount) : "",
      category,
      remark,
      transferDirection,
    };
  }).filter((item) => item.date && item.amount > 0);
}

function normalizeForStorage(item: ParsedItem): ParsedItem {
  const outflow = item.outflow || 0;
  const inflow = item.inflow || 0;
  const amount = item.amount || outflow || inflow || 0;
  if (item.type !== "transfer") {
    return {
      ...item,
      amount,
      account: item.account || item.fromAccount || item.toAccount || "",
      fromAccount: "",
      toAccount: "",
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
    transferDirection: direction,
  };
}

export default function BatchImportPage() {
  const router = useRouter();
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<number, Partial<ParsedItem>>>({});
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadDebug, setUploadDebug] = useState<string | null>(null);
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([]);
  const [editingCell, setEditingCell] = useState<{ idx: number; field: EditableCell } | null>(null);
  const [activeFilterColumn, setActiveFilterColumn] = useState<FilterColumn | null>(null);
  const [columnFilters, setColumnFilters] = useState<Partial<Record<FilterColumn, string[]>>>({});
  const [previewCount, setPreviewCount] = useState(INITIAL_PREVIEW_COUNT);

  useEffect(() => {
    try {
      const data = sessionStorage.getItem("batchImportItems");
      const storedItems = data ? JSON.parse(data) as ParsedItem[] : [];
      if (Array.isArray(storedItems) && storedItems.length > 0) {
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
        const allowedKinds = new Set(["cash", "bank_debit", "bank_credit"]);
        setAccountOptions(data.accounts.filter((account: AccountOption) => allowedKinds.has(account.kind)));
      })
      .catch((error) => {
        if (!cancelled) setUploadDebug(`账户列表加载失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => { cancelled = true; };
  }, []);

  const accountDisplayLabel = useCallback((account: AccountOption) => {
    const institutionName = account.Institution?.name?.trim();
    return institutionName ? `${institutionName}·${account.name}` : account.name;
  }, []);

  const renderAccountOptions = useCallback((currentValue: string) => {
    const current = currentValue.trim();
    const hasCurrent = current && accountOptions.some((account) => account.name === current);
    return (
      <>
        <option value="">未选择</option>
        {current && !hasCurrent && <option value={current}>{current}（未匹配）</option>}
        {accountOptions.map((account) => (
          <option key={account.id} value={account.name}>{accountDisplayLabel(account)}</option>
        ))}
      </>
    );
  }, [accountOptions, accountDisplayLabel]);

  const downloadTemplate = useCallback((template: ImportTemplate) => {
    const csv = `\uFEFF${buildCsv(template)}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = template.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleNormalCsvFile = useCallback(async (file: File) => {
    const fileInfo = `文件：${file.name}；类型：${file.type || "未知"}；大小：${Math.round(file.size / 1024)} KB`;
    setUploadDebug(`已选择文件，开始读取。${fileInfo}`);
    setMessage(`正在读取文件：${file.name} ...`);
    setImportedCount(0);
    setUploading(true);
    setItems([]);
    setDrafts({});
    setSelected(new Set());
    setColumnFilters({});
    setActiveFilterColumn(null);
    setPreviewCount(INITIAL_PREVIEW_COUNT);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const rows = await parseImportFile(file);
      setUploadDebug(`文件读取完成，共 ${rows.length} 行。${fileInfo}`);
      const parsed = normalRowsToItems(rows);
      if (parsed.length === 0) {
        const headers = rows[0]?.join("、") || "未读取到表头";
        setItems([]);
        setDrafts({});
        setSelected(new Set());
        setUploadDebug(`读取成功但未识别到记录。表头：${headers}。${fileInfo}`);
        setMessage(`已读取文件 ${file.name}，但未识别到可导入的账单记录。当前读取到的表头是：${headers}。请确认首行表头包含“日期、流出、流入、账户”等字段，并且明细行填写了日期以及流出或流入金额。支持 CSV、XLSX、XLS 文件。`);
        return;
      }
      sessionStorage.setItem("batchImportItems", JSON.stringify(parsed));
      setItems(parsed);
      setDrafts({});
      setSelected(new Set());
      setEditingCell(null);
      setUploadDebug(`识别完成，共 ${parsed.length} 条可预览记录。${fileInfo}`);
      setMessage(`已读取 ${parsed.length} 条账单记录，并已按类型/备注/流入流出做初级判断。请先在弹窗预览确认并勾选需要导入的记录。`);
    } catch (error) {
      setItems([]);
      setDrafts({});
      setSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setUploadDebug(`读取失败：${reason || "未知错误"}。${fileInfo}`);
      setMessage(`读取文件失败：${reason || "未知错误"}。请确认文件不是加密文件，且格式为 CSV、XLSX 或 XLS。`);
    } finally {
      setUploading(false);
    }
  }, []);

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


  const updateDraft = useCallback((idx: number, field: string, value: unknown) => {
    setDrafts((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], [field]: value },
    }));
  }, []);

  const getItem = useCallback((idx: number): ParsedItem => {
    const item = items[idx];
    const draft = drafts[idx] ?? {};
    return {
      ...item,
      ...draft,
      date: draft.date ?? item.date ?? "",
      account: draft.account ?? item.account ?? "",
      fromAccount: draft.fromAccount ?? item.fromAccount ?? "",
      toAccount: draft.toAccount ?? item.toAccount ?? "",
      amount: draft.amount ?? item.amount ?? 0,
      outflow: draft.outflow ?? item.outflow ?? 0,
      inflow: draft.inflow ?? item.inflow ?? 0,
      remark: draft.remark ?? item.remark ?? "",
      counterparty: draft.counterparty ?? item.counterparty ?? "",
      transferDirection: draft.transferDirection ?? item.transferDirection,
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
    if (column === "date") return item.date || "(空)";
    if (column === "type") return item.type === "income" ? "收入" : item.type === "transfer" ? "转账" : "支出";
    if (column === "account") return account.trim() || "(空)";
    if (column === "counterAccount") return counterAccount.trim() || "(空)";
    return (item.remark || item.counterparty || "").trim() || "(空)";
  }, [getItem]);

  const columnFilterOptions = useMemo(() => {
    if (!activeFilterColumn) return [];
    return Array.from(new Set(items.map((_, idx) => getFilterColumnValue(idx, activeFilterColumn))))
      .sort((a, b) => (a === "(空)" ? 1 : b === "(空)" ? -1 : a.localeCompare(b, "zh-CN")));
  }, [items, activeFilterColumn, getFilterColumnValue]);

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

  const accountNameSet = useMemo(() => new Set(accountOptions.map((account) => account.name)), [accountOptions]);

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
      if (!account.trim()) issues.push({ idx, level: "error", message: "本账户未识别，不能导入" });
      else if (!accountNameSet.has(account.trim())) issues.push({ idx, level: "error", message: `本账户“${account.trim()}”未匹配到账户库` });
      if (!Number.isFinite(item.amount) || item.amount <= 0) issues.push({ idx, level: "error", message: "金额为空或无效" });
      if (item.type === "transfer" && counterAccount.trim() && !accountNameSet.has(counterAccount.trim())) {
        issues.push({ idx, level: "warning", message: `对向账户“${counterAccount.trim()}”未匹配，将按空值写库` });
      } else if (item.type === "transfer" && !counterAccount.trim()) {
        issues.push({ idx, level: "warning", message: "转账缺少对方账户，将空值写库" });
      }
    }
    return issues;
  }, [selected, getItem, accountNameSet]);

  const importErrorIssues = useMemo(() => importIssues.filter((issue) => issue.level === "error"), [importIssues]);
  const importWarningIssues = useMemo(() => importIssues.filter((issue) => issue.level === "warning"), [importIssues]);
  const importIssuesByRow = useMemo(() => {
    const map = new Map<number, ImportIssue[]>();
    for (const issue of importIssues) map.set(issue.idx, [...(map.get(issue.idx) ?? []), issue]);
    return map;
  }, [importIssues]);

  const applyReplaceToTargets = useCallback((replaceField: ReplaceField, replaceValue: string) => {
    if (batchTargetIndexes.length === 0) throw new Error("请先勾选记录，或切换为应用到当前筛选结果");
    const value = replaceValue.trim();
    if (!value && replaceField !== "counterAccount") throw new Error("请输入修改值");

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
      } else if (replaceField === "outflow" || replaceField === "inflow") {
        const currentNumber = replaceField === "outflow" ? item.outflow ?? 0 : item.inflow ?? 0;
        const nextNumber = applyNumberExpression(currentNumber, value);
        if (!Number.isFinite(nextNumber)) {
          invalid++;
          continue;
        }
        patch[replaceField] = nextNumber;
        patch.amount = nextNumber || (replaceField === "outflow" ? item.inflow ?? 0 : item.outflow ?? 0) || 0;
        if (type === "transfer" && nextNumber > 0) patch.transferDirection = replaceField === "inflow" ? "in" : "out";
        else if (replaceField === "inflow" && nextNumber > 0) patch.type = "income";
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
      } else if (replaceField === "remark") patch.remark = value;
      nextDrafts[idx] = { ...(nextDrafts[idx] ?? {}), ...patch };
      changed++;
    }

    setDrafts(nextDrafts);
    const resultMessage = `已批量修改已勾选的 ${changed} 条记录：${replaceFieldLabels[replaceField]}${invalid > 0 ? `；${invalid} 条数字表达式无效未修改。` : "。"}`;
    setMessage(resultMessage);
    setEditingCell(null);
    return resultMessage;
  }, [batchTargetIndexes, drafts, getItem]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(selected);
    const selectedItems = selectedIndexes.map((idx) => normalizeForStorage(getItem(idx)));
    const missingCounterAccountCount = selectedItems.filter((item) => item.type === "transfer" && (!item.fromAccount?.trim() || !item.toAccount?.trim())).length;
    if (importErrorIssues.length > 0) {
      const preview = importErrorIssues.slice(0, 5).map((issue) => `第 ${issue.idx + 1} 条：${issue.message}`).join("；");
      setMessage(`导入前校验未通过：发现 ${importErrorIssues.length} 条阻断错误，已停止导入，未写入任何记录。${preview}${importErrorIssues.length > 5 ? "；其余请查看上传诊断。" : ""}`);
      setUploadDebug(importIssues.map((issue) => `第 ${issue.idx + 1} 条${issue.level === "error" ? "错误" : "警告"}：${issue.message}`).join("\n"));
      return;
    }
    setImporting(true);
    setImportedCount(0);
    setMessage(`正在导入 ${selectedItems.length} 条记录...`);
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
        setMessage(`导入失败：已整批回滚，未写入任何记录。${data?.error || res.statusText || `HTTP ${res.status}`}`);
        setUploadDebug(data?.trace?.join("\n") ?? data?.error ?? null);
        return;
      }
      const success = data.createdCount ?? selectedItems.length;
      setImportedCount(success);
      setImporting(false);
      setMessage(`导入完成：成功 ${success} 条。${missingCounterAccountCount > 0 ? `其中 ${missingCounterAccountCount} 条转账缺少对方账户，已空值写库，请导入后修改。` : ""}即将打开明细列表...`);
    } catch (error) {
      setImportedCount(0);
      setImporting(false);
      setMessage(`导入失败：已整批回滚，未写入任何记录。${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (selectedItems.length > 0) {
      setTimeout(() => {
        sessionStorage.removeItem("batchImportItems");
        router.push("/?view=detail");
      }, 1500);
    }
  }, [importing, selected, getItem, router, importErrorIssues, importIssues]);

  const handleCancel = useCallback(() => {
    sessionStorage.removeItem("batchImportItems");
    setItems([]);
    setSelected(new Set());
    setDrafts({});
    setEditingCell(null);
    setActiveFilterColumn(null);
    setColumnFilters({});
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
    { value: "", label: "未选择" },
    ...accountOptions.map((account) => ({ value: account.name, label: accountDisplayLabel(account) })),
  ], [accountOptions, accountDisplayLabel]);

  const replaceFields = useMemo<BatchReplaceFieldConfig<ReplaceField>[]>(() => [
    { value: "date", label: replaceFieldLabels.date, kind: "date" },
    {
      value: "type",
      label: replaceFieldLabels.type,
      kind: "select",
      options: [
        { value: "", label: "选择类型" },
        { value: "expense", label: "支出" },
        { value: "income", label: "收入" },
        { value: "transfer", label: "转账" },
      ],
    },
    { value: "outflow", label: replaceFieldLabels.outflow, kind: "number", placeholder: "如 100、*2、+10、-5、/2" },
    { value: "inflow", label: replaceFieldLabels.inflow, kind: "number", placeholder: "如 100、*2、+10、-5、/2" },
    { value: "account", label: replaceFieldLabels.account, kind: "select", options: accountReplaceOptions },
    { value: "counterAccount", label: replaceFieldLabels.counterAccount, kind: "select", options: accountReplaceOptions, allowEmpty: true },
    { value: "remark", label: replaceFieldLabels.remark, kind: "text", placeholder: "输入替换内容" },
  ], [accountReplaceOptions]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-800">账簿导入</h1>
          {items.length > 0 && (
            <span className="text-sm text-slate-500">
              已选 <span className="font-medium text-blue-600">{selected.size}</span> / {items.length} 条
              {importErrorIssues.length > 0 && <span className="ml-2 font-medium text-red-600">阻断错误 {importErrorIssues.length} 条</span>}
              {importWarningIssues.length > 0 && <span className="ml-2 font-medium text-amber-600">警告 {importWarningIssues.length} 条</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-md"
            >
              清空
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={handleImport}
              disabled={importing || selected.size === 0 || importErrorIssues.length > 0}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? "导入中..." : `导入 ${selected.size} 条`}
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700 text-sm">
          {message}
        </div>
      )}

      {uploadDebug && (
        <div className="mx-4 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-sm">
          <div className="font-medium">上传诊断</div>
          <div className="mt-1 break-all">{uploadDebug}</div>
        </div>
      )}

      {uploading && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700 text-sm">
          正在读取并解析文件，请稍候。大 Excel 文件首次加载解析库可能需要几秒钟。
        </div>
      )}

      {importedCount > 0 && (
        <div className="mx-4 mt-4 p-3 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm">
          ✓ 已成功导入 {importedCount} 条记录，即将返回首页...
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
                  下载 CSV 模板
                </button>
                {template.key === "normal" && (
                  <label className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer inline-flex items-center">
                    上传账单文件
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="sr-only"
                      onClick={() => {
                        setUploadDebug("已点击上传控件，等待选择文件。");
                        setMessage("已打开文件选择，请选择 CSV、XLSX 或 XLS 文件。");
                      }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          setUploadDebug("文件选择窗口已关闭，但没有选择文件。");
                          setMessage("没有选择文件，请重新点击上传账单文件。");
                          return;
                        }
                        void handleNormalCsvFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
              <div className="text-xs text-slate-500">
                <div className="mb-1 font-medium text-slate-600">字段说明</div>
                <div className="space-y-1">
                  {template.fields.map((field) => (
                    <div key={field.name}>
                      <span className="font-mono text-slate-700">{field.name}</span>
                      {field.required && <span className="ml-1 text-red-500">必填</span>}
                      <span className="ml-1">{field.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="bg-white rounded-lg border border-slate-200 p-6 text-sm text-slate-600 leading-7">
          <h2 className="text-base font-semibold text-slate-800 mb-2">导入说明</h2>
          <p>当前入口先支持“账单记录模板”的 CSV、XLSX、XLS 上传、弹窗预览确认和导入；基金记录、信用卡账单已给出模板字段，但需要后续专用校验流程，暂不直接写库。</p>
          <p>账单记录按中文字段导入：类型/备注出现转入、转出、转账、汇款、取现、还款等会初判为转账；出现结息、利息、收入、工资、退款等会初判为收入；没有类型线索时再按流入/流出金额判断。转账只有“转账”一个库类型，转入/转出只作为识别方向；写库前按金额列归一：流出时模板账户写入资金发出方，流入时模板账户写入转入账户。</p>
        </section>
      </div>

      {(items.length > 0 || uploading) && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4 flex items-center justify-center">
          <div className="w-full max-w-7xl h-[82vh] bg-white rounded-xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="shrink-0 px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-800">导入预览确认</div>
                <div className="text-xs text-slate-500 mt-1">{uploading ? "正在解析文件，完成后会显示预览。" : `已识别 ${items.length} 条，默认全不选。请检查日期、类型、账户和金额后勾选需要导入的记录。`}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-md"
                >
                  取消
                </button>
                <button
                  onClick={handleImport}
                  disabled={uploading || importing || selected.size === 0 || importErrorIssues.length > 0}
                  className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importing ? "导入中..." : `确认导入 ${selected.size} 条`}
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
                <span className="font-medium text-slate-700">筛选结果</span>
                <span>{filteredIndexes.length} / {items.length} 条</span>
                <span className="text-slate-400">点击表头 ▼ 按列筛选，效果类似 Excel。</span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveFilterColumn(null);
                    setColumnFilters({});
                  }}
                  className="ml-auto h-8 px-2 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                >
                  清空全部筛选
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-xs border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="w-24 px-2 py-1 text-left">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={filteredIndexes.length > 0 && filteredIndexes.every((idx) => selected.has(idx))}
                        onChange={toggleAllFiltered}
                        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
                        title="选择当前筛选结果"
                      />
                      <BatchReplacePopoverButton
                        fields={replaceFields}
                        targetCount={batchTargetIndexes.length}
                        targetLabel="已勾选"
                        panelAlign="left"
                        disabledTitle="请先勾选记录，可先按表头筛选后全选"
                        buttonTitle={`批量修改已勾选 ${batchTargetIndexes.length} 条记录`}
                        messageClassName="sr-only"
                        onApply={applyReplaceToTargets}
                      />
                    </div>
                  </th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("date", "日期")}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("type", "类型")}</th>
                  <th className="px-2 py-1 text-right text-xs font-medium text-slate-600">流出</th>
                  <th className="px-2 py-1 text-right text-xs font-medium text-slate-600">流入</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("account", "账户")}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("counterAccount", "对向账户")}</th>
                  <th className="px-2 py-1 text-left text-xs font-medium text-slate-600">{renderColumnFilter("remark", "备注")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {uploading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-blue-600">
                      正在解析文件，预览会在完成后显示...
                    </td>
                  </tr>
                ) : filteredIndexes.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-500">
                      没有符合筛选条件的记录。
                    </td>
                  </tr>
                ) : visibleIndexes.map((idx) => {
                  const item = items[idx];
                  const draft = drafts[idx] ?? {};
                  const date = draft.date ?? item.date ?? "";
                  const amount = draft.amount ?? item.amount ?? 0;
                  const outflow = draft.outflow ?? item.outflow ?? (item.type === "income" ? 0 : amount);
                  const inflow = draft.inflow ?? item.inflow ?? (item.type === "income" ? amount : 0);
                  const type = draft.type ?? item.type ?? "expense";
                  const direction = draft.transferDirection ?? item.transferDirection;
                  const account = type === "transfer"
                    ? (direction === "in" ? (draft.toAccount ?? item.toAccount ?? "") : (draft.fromAccount ?? item.fromAccount ?? ""))
                    : (draft.account ?? item.account ?? "");
                  const counterAccount = type === "transfer"
                    ? (direction === "in" ? (draft.fromAccount ?? item.fromAccount ?? "") : (draft.toAccount ?? item.toAccount ?? ""))
                    : "";
                  const remark = draft.remark ?? item.remark ?? item.counterparty ?? "";
                  const isSelected = selected.has(idx);
                  const editingField = editingCell?.idx === idx ? editingCell.field : null;
                  const typeLabel = type === "income" ? "收入" : type === "transfer" ? "转账" : "支出";
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
                      <td className="px-2 py-1 whitespace-nowrap text-xs tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "date")} title="双击修改">
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
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-slate-700" onDoubleClick={() => openCellEdit(idx, "type")} title="双击修改">
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
                            <option value="expense">支出</option>
                            <option value="income">收入</option>
                            <option value="transfer">转账</option>
                          </select>
                        ) : typeLabel}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-right text-xs tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "outflow")} title="双击修改">
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
                              updateDraft(idx, "amount", next || inflow || 0);
                              if (type === "transfer" && next > 0) updateDraft(idx, "transferDirection", "out");
                            }}
                            className="h-6 w-24 px-1.5 text-xs text-right border border-blue-300 rounded focus:outline-none tabular-nums"
                            step="0.01"
                          />
                        ) : (outflow ? outflow.toFixed(2) : "-")}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-right text-xs tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "inflow")} title="双击修改">
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
                              updateDraft(idx, "amount", next || outflow || 0);
                              if (type === "transfer" && next > 0) updateDraft(idx, "transferDirection", "in");
                              else if (next > 0) updateDraft(idx, "type", "income");
                            }}
                            className="h-6 w-24 px-1.5 text-xs text-right border border-blue-300 rounded focus:outline-none tabular-nums"
                            step="0.01"
                          />
                        ) : (inflow ? inflow.toFixed(2) : "-")}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-slate-700" onDoubleClick={() => openCellEdit(idx, "account")} title="双击修改">
                        {editingField === "account" ? (
                          <select
                            value={account}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => {
                              updateDraft(idx, "account", e.target.value);
                              if (type === "transfer") {
                                if (direction === "in") updateDraft(idx, "toAccount", e.target.value);
                                else updateDraft(idx, "fromAccount", e.target.value);
                              }
                            }}
                            className="h-6 w-36 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          >
                            {renderAccountOptions(account)}
                          </select>
                        ) : (account || <span className="text-red-500">未识别</span>)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-slate-700" onDoubleClick={() => openCellEdit(idx, "counterAccount")} title="双击修改">
                        {editingField === "counterAccount" ? (
                          <select
                            value={counterAccount}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => {
                              const value = e.target.value;
                              if (direction === "in") updateDraft(idx, "fromAccount", value);
                              else updateDraft(idx, "toAccount", value);
                              if (value.trim()) updateDraft(idx, "type", "transfer");
                            }}
                            className="h-6 w-36 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          >
                            {renderAccountOptions(counterAccount)}
                          </select>
                        ) : (counterAccount || <span className="text-slate-400">-</span>)}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1 text-xs text-slate-700" title={remark || "双击修改"} onDoubleClick={() => openCellEdit(idx, "remark")}>
                        {editingField === "remark" ? (
                          <input
                            type="text"
                            value={remark}
                            autoFocus
                            onBlur={closeCellEdit}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") closeCellEdit(); }}
                            onChange={(e) => updateDraft(idx, "remark", e.target.value)}
                            placeholder="备注"
                            className="h-6 w-48 px-1.5 text-xs border border-blue-300 rounded focus:outline-none"
                          />
                        ) : (remark || <span className="text-slate-400">-</span>)}
                      </td>
                    </tr>
                  );
                })}
                {!uploading && filteredIndexes.length > visibleIndexes.length && (
                  <tr>
                    <td colSpan={8} className="px-4 py-2 text-center text-xs text-slate-500">
                      当前显示 {visibleIndexes.length} / {filteredIndexes.length} 条。
                      <button
                        type="button"
                        onClick={() => setPreviewCount((count) => count + PREVIEW_COUNT_STEP)}
                        className="ml-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                      >
                        继续加载 {Math.min(PREVIEW_COUNT_STEP, filteredIndexes.length - visibleIndexes.length)} 条
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
    </div>
  );
}
