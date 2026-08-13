import {
  inferSignedAmountInflowSign,
  isCreditCardRepaymentLikeText,
  isExpenseRefundLikeText,
  signedAmountDirection,
} from "@/lib/statement/amount-direction";
import {
  STATEMENT_IMPORT_FIELD_HEADERS,
  SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE,
  createStatementHeaderReader,
  matchStatementHeaderProfile,
  type StatementImportField,
} from "@/lib/statement/header-catalog";
import {
  alignStatementIncomeRefunds,
  enrichKnownStatementMerchantForImport,
} from "@/lib/statement/import-normalization";

export type StatementExcelPreviewItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  inflow?: number;
  outflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  transferDirection?: "in" | "out";
  category?: string;
  categoryUserEdited?: boolean;
  remark?: string;
  counterparty?: string;
  institution?: string;
  institutionUserEdited?: boolean;
  postedDate?: string;
  currency?: string;
  _meta?: {
    institutionName?: string;
    ownerName?: string;
    cardNumberMasked?: string;
    statementCurrency?: string;
    minimumPayment?: number;
    creditLimit?: number;
    billingDay?: number;
    repaymentDay?: number;
    statementAmount?: number;
    statementPeriodStart?: string;
    statementPeriodEnd?: string;
    statementDueDate?: string;
  };
};

type StatementFieldHeaders = Record<StatementImportField, readonly string[]>;

function formatDateCell(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value ?? "").trim();
}

function normalizeHeader(value: string) {
  return value.replace(/\s+/g, "").replace(/[：:]/g, "").trim().toLowerCase();
}

function normalizeDate(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = raw
    .replace(/[年月/.]/g, "-")
    .replace(/[日号]/g, "")
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseAmount(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parsePositiveAmountCell(row: string[], index: number) {
  if (index < 0) return 0;
  const raw = String(row[index] ?? "").trim();
  if (!raw) return 0;
  const parsed = parseAmount(raw);
  return parsed === null ? 0 : Math.abs(parsed);
}

function rowText(row: string[]) {
  return row.filter(Boolean).join(" ");
}

export function hasImportableStatementRows(items: StatementExcelPreviewItem[]) {
  return items.some((item) => item.date && Number(item.amount) > 0);
}

function cardAccountHint(institutionName: string | undefined, defaultAccountName: string, last4: string) {
  const cardTail = last4.trim();
  if (!cardTail) return defaultAccountName;
  const bankName = String(institutionName ?? "").trim();
  if (bankName) return `${bankName}信用卡(${cardTail})`;
  const defaultName = defaultAccountName.trim();
  if (!defaultName) return `信用卡(${cardTail})`;
  if (defaultName.includes(cardTail)) return defaultName;
  return `${defaultName}(${cardTail})`;
}

export function isKnownCreditCardStatementRows(rows: string[][]) {
  for (const [index, row] of rows.entries()) {
    const indexes = matchStatementHeaderProfile(row, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
    if (!indexes) continue;
    let validRows = 0;
    for (const sampleRow of rows.slice(index + 1, index + 21)) {
      const date = normalizeDate(sampleRow[indexes.transactionDate] ?? "");
      const amount = parseAmount(sampleRow[indexes.amount] ?? "");
      const description = String(sampleRow[indexes.description] ?? "").trim();
      const cardLast4 = String(sampleRow[indexes.cardLast4] ?? "").trim();
      if (date && amount !== null && amount !== 0 && description && /^\d{4}$/.test(cardLast4)) validRows += 1;
      if (validRows >= SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.minValidSampleRows) return true;
    }
  }
  return false;
}

export function normalizeStatementExcelParsedItems(items: StatementExcelPreviewItem[]) {
  return alignStatementIncomeRefunds(items.map(enrichKnownStatementMerchantForImport));
}

function statementHeaderScore(row: string[], fieldHeaders: StatementFieldHeaders) {
  const reader = createStatementHeaderReader(row, fieldHeaders);
  let score = 0;
  if (reader.hasField("transactionDate")) score += 4;
  if (reader.hasField("amount")) score += 4;
  if (reader.hasField("sourceAccount")) score += 3;
  if (reader.hasField("majorType")) score += 2;
  if (reader.hasField("explicitType")) score += 2;
  if (reader.hasField("creditAccount")) score += 2;
  if (reader.hasField("repaymentAccount")) score += 1;
  if (reader.hasField("transferCounterAccount")) score += 1;
  if (reader.hasField("category")) score += 1;
  if (reader.hasField("institution")) score += 1;
  if (reader.hasField("remark")) score += 1;
  return score >= 8 ? score : 0;
}

function trimRowsToStatementHeader(rows: string[][], fieldHeaders: StatementFieldHeaders) {
  const compactRows = rows.filter((row) => row.some((cell) => cell.trim()));
  let bestIndex = 0;
  let bestScore = statementHeaderScore(compactRows[0] ?? [], fieldHeaders);
  compactRows.slice(0, 25).forEach((row, index) => {
    const score = statementHeaderScore(row, fieldHeaders);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore > 0 ? compactRows.slice(bestIndex) : compactRows;
}

function headerSignature(row: string[]) {
  return row.map(normalizeHeader).join("|");
}

function mergeStatementWorkbookRows(
  sheetRows: Array<{ sheetName: string; rows: string[][] }>,
  fieldHeaders: StatementFieldHeaders,
) {
  const trimmedSheets = sheetRows
    .map((sheet) => ({ ...sheet, rows: trimRowsToStatementHeader(sheet.rows, fieldHeaders) }))
    .filter((sheet) => sheet.rows.length > 0);
  if (trimmedSheets.length === 0) return [] as string[][];

  const groups = new Map<string, typeof trimmedSheets>();
  for (const sheet of trimmedSheets) {
    const signature = headerSignature(sheet.rows[0] ?? []);
    groups.set(signature, [...(groups.get(signature) ?? []), sheet]);
  }

  const selectedSheets = Array.from(groups.values()).sort((a, b) => {
    const aScore = statementHeaderScore(a[0]?.rows[0] ?? [], fieldHeaders);
    const bScore = statementHeaderScore(b[0]?.rows[0] ?? [], fieldHeaders);
    if (aScore !== bScore) return bScore - aScore;
    const aRows = a.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    const bRows = b.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    return bRows - aRows;
  })[0] ?? [];

  const [firstSheet, ...restSheets] = selectedSheets;
  const mergedRows = [...(firstSheet?.rows ?? [])];
  for (const sheet of restSheets) mergedRows.push(...sheet.rows.slice(1));
  return mergedRows;
}

export function parseStatementTemplateRows(
  rows: string[][],
  defaultAccountName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): StatementExcelPreviewItem[] {
  const [headers = [], ...dataRows] = rows;
  const spdbIndexes = matchStatementHeaderProfile(headers, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
  const knownInstitutionName = spdbIndexes ? SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.institutionName : undefined;
  const reader = createStatementHeaderReader(headers, fieldHeaders);
  const dateIndex = spdbIndexes?.transactionDate ?? reader.findFieldIndex("transactionDate");
  const typeIndex = reader.findIndex([...fieldHeaders.explicitType, ...fieldHeaders.majorType]);
  const plainAccountIndex = reader.findFieldIndex("sourceAccount");
  const legacyCardIndex = spdbIndexes?.cardLast4 ?? reader.findFieldIndex("creditAccount");
  const accountIndex = plainAccountIndex >= 0 ? plainAccountIndex : legacyCardIndex;
  const legacyCardAccountMode = plainAccountIndex < 0 && legacyCardIndex >= 0;
  const counterIndex = reader.findIndex([...fieldHeaders.transferCounterAccount, ...fieldHeaders.repaymentAccount]);
  const amountIndex = spdbIndexes?.amount ?? reader.findFieldIndex("amount");
  const outflowIndex = reader.findFieldIndex("outflow");
  const inflowIndex = reader.findFieldIndex("inflow");
  const categoryIndex = reader.findFieldIndex("category");
  const merchantIndex = reader.findFieldIndex("institution");
  const tagsIndex = reader.findFieldIndex("tags");
  const remarkIndex = spdbIndexes?.description ?? reader.findFieldIndex("remark");
  const postedIndex = spdbIndexes?.postingDate ?? reader.findFieldIndex("postedAt");

  if (dateIndex < 0 || amountIndex < 0) return [];

  const signedAmountInflowSign = inferSignedAmountInflowSign(dataRows.flatMap((row) => {
    const rawInflowText = inflowIndex >= 0 ? String(row[inflowIndex] ?? "").trim() : "";
    const rawOutflowText = outflowIndex >= 0 ? String(row[outflowIndex] ?? "").trim() : "";
    const hasExplicitFlow =
      parsePositiveAmountCell(row, inflowIndex) > 0 ||
      parsePositiveAmountCell(row, outflowIndex) > 0 ||
      !!rawInflowText ||
      !!rawOutflowText;
    if (hasExplicitFlow) return [];
    const typeText = String(row[typeIndex] ?? "").trim();
    const category = String(row[categoryIndex] ?? "").trim();
    const institution = String(row[merchantIndex] ?? "").trim();
    const remark = String(row[remarkIndex] ?? "").trim();
    return [{
      amount: parseAmount(row[amountIndex] ?? ""),
      text: `${typeText} ${category} ${institution} ${remark} ${rowText(row)}`,
    }];
  }));

  return dataRows.flatMap<StatementExcelPreviewItem>((row) => {
    const date = normalizeDate(row[dateIndex] ?? "");
    const amountSigned = parseAmount(row[amountIndex] ?? "");
    if (!date || amountSigned === null || amountSigned === 0) return [];

    const typeText = String(row[typeIndex] ?? "").trim().toLowerCase();
    const rawOutflow = parsePositiveAmountCell(row, outflowIndex);
    const rawInflow = parsePositiveAmountCell(row, inflowIndex);
    const rawOutflowText = outflowIndex >= 0 ? String(row[outflowIndex] ?? "").trim() : "";
    const rawInflowText = inflowIndex >= 0 ? String(row[inflowIndex] ?? "").trim() : "";
    const hasExplicitFlow = rawInflow > 0 || rawOutflow > 0 || !!rawInflowText || !!rawOutflowText;
    const explicitDirection: "in" | "out" | null =
      rawInflow > 0 && rawOutflow <= 0 ? "in"
      : rawOutflow > 0 && rawInflow <= 0 ? "out"
      : null;
    const signedDirection = hasExplicitFlow ? explicitDirection : signedAmountDirection(amountSigned, signedAmountInflowSign);
    const amount = Math.abs(amountSigned) || rawInflow || rawOutflow;
    const rawAccountValue = accountIndex >= 0 ? String(row[accountIndex] ?? "").trim() : defaultAccountName;
    const cardLast4 = legacyCardAccountMode ? rawAccountValue.match(/\d{4}(?!\d)/)?.[0] ?? "" : "";
    const accountValue = legacyCardAccountMode
      ? cardAccountHint(knownInstitutionName, defaultAccountName, cardLast4)
      : rawAccountValue;
    const counterAccount = counterIndex >= 0 ? String(row[counterIndex] ?? "").trim() : "";
    const category = String(row[categoryIndex] ?? "").trim();
    const institution = String(row[merchantIndex] ?? "").trim();
    const tags = tagsIndex >= 0 ? String(row[tagsIndex] ?? "").trim() : "";
    const remark = String(row[remarkIndex] ?? "").trim() || tags || rowText(row);
    const postedDate = postedIndex >= 0 ? normalizeDate(row[postedIndex] ?? "") : undefined;
    const sourceText = `${typeText} ${category} ${institution} ${remark} ${rowText(row)}`;
    const isRepayment = /转账|transfer/.test(typeText) || isCreditCardRepaymentLikeText(sourceText);
    const isRefund = isExpenseRefundLikeText(sourceText);
    const isSignedInflow = signedDirection === "in";
    const isIncome = !isRefund && (/income|收入/.test(typeText) || isSignedInflow);

    if (isRepayment) {
      const accountIsCurrent = normalizeHeader(accountValue) === normalizeHeader(defaultAccountName);
      const counterIsCurrent = normalizeHeader(counterAccount) === normalizeHeader(defaultAccountName);
      const accountSideIsPrimary = legacyCardAccountMode || accountIsCurrent || !counterIsCurrent;
      const transferIsInflow = explicitDirection
        ? explicitDirection === "in"
        : isCreditCardRepaymentLikeText(sourceText) || signedDirection !== "out";
      const fromAccount = transferIsInflow
        ? accountSideIsPrimary ? counterAccount : accountValue
        : accountSideIsPrimary ? (accountValue || defaultAccountName) : (counterAccount || defaultAccountName);
      const toAccount = transferIsInflow
        ? accountSideIsPrimary ? (accountValue || defaultAccountName) : (counterAccount || defaultAccountName)
        : accountSideIsPrimary ? counterAccount : accountValue;
      return [{
        rawText: rowText(row),
        type: "transfer" as const,
        date,
        amount,
        inflow: transferIsInflow ? amount : undefined,
        outflow: transferIsInflow ? undefined : amount,
        account: transferIsInflow ? toAccount : fromAccount,
        fromAccount,
        toAccount,
        transferDirection: transferIsInflow ? "in" as const : "out" as const,
        institution,
        remark,
        postedDate,
        _meta: cardLast4 || knownInstitutionName ? {
          institutionName: knownInstitutionName,
          cardNumberMasked: cardLast4 || undefined,
        } : undefined,
      }];
    }

    const account = accountValue || defaultAccountName;
    const resolvedType = explicitDirection === "out" ? "expense" : isIncome ? "income" : "expense";
    const accountSideInflow = explicitDirection
      ? explicitDirection === "in"
      : isIncome || isRefund;
    return [{
      rawText: rowText(row),
      type: resolvedType,
      date,
      amount,
      inflow: accountSideInflow ? amount : undefined,
      outflow: accountSideInflow ? undefined : amount,
      account,
      category,
      institution,
      counterparty: institution || undefined,
      remark,
      postedDate,
      _meta: cardLast4 || knownInstitutionName ? {
        institutionName: knownInstitutionName,
        cardNumberMasked: cardLast4 || undefined,
      } : undefined,
    }];
  });
}

export async function readStatementWorkbookRowsAndText(
  file: File,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
) {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetRows = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
      header: 1,
      defval: "",
      raw: false,
      dateNF: "yyyy-mm-dd",
    }).map((row) => row.map(formatDateCell).map((cell) => cell.trim()));
    return { sheetName, rows };
  });
  const rows = mergeStatementWorkbookRows(sheetRows, fieldHeaders);
  const text = sheetRows
    .flatMap((sheet) => sheet.rows.filter((row) => row.some(Boolean)))
    .map((row) => row.join("\t"))
    .join("\n");
  return { rows, text };
}

export async function parseStatementExcelFile(
  file: File,
  defaultAccountName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
) {
  const { rows, text } = await readStatementWorkbookRowsAndText(file, fieldHeaders);
  const localItems = normalizeStatementExcelParsedItems(parseStatementTemplateRows(rows, defaultAccountName, fieldHeaders));
  return {
    rows,
    text,
    localItems,
    preferServerRecognition: isKnownCreditCardStatementRows(rows),
  };
}
