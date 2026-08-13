export type StatementImportField =
  | "transactionDate"
  | "postedAt"
  | "outflow"
  | "inflow"
  | "amount"
  | "sourceAccount"
  | "repaymentAccount"
  | "creditAccount"
  | "transferCounterAccount"
  | "remark"
  | "category"
  | "institution"
  | "tags"
  | "majorType"
  | "explicitType"
  | "secondRemark";

export type StatementFieldRecognitionSample = {
  targetType?: string | null;
  fieldName?: string | null;
  matchText?: string | null;
  normalizedText?: string | null;
};

export type SpdbCreditCardTransactionField =
  | "transactionDate"
  | "postingDate"
  | "description"
  | "cardLast4"
  | "cardType"
  | "currency"
  | "amount"
  | "originalAmount";

export type StatementHeaderProfile<TField extends string> = {
  institutionName: string;
  minValidSampleRows: number;
  requiredHeaders: Record<TField, readonly string[]>;
};

export const STATEMENT_IMPORT_FIELD_HEADERS: Record<StatementImportField, readonly string[]> = {
  transactionDate: ["日期", "交易日期", "记账日期", "账单日期", "date"],
  postedAt: ["入账日期", "到账日期", "入账时间", "到账时间", "入账日期时间", "到账日期时间", "实际入账时间", "实际到账时间", "postedAt", "postingTime"],
  outflow: ["流出", "支出", "转出", "借方金额", "支出金额", "outflow"],
  inflow: ["流入", "收入", "转入", "贷方金额", "收入金额", "inflow"],
  amount: ["金额", "交易金额", "发生额", "本币金额", "人民币金额", "amount"],
  sourceAccount: ["账户", "本方账户", "交易账户", "账号", "account", "fromAccount"],
  repaymentAccount: ["还款账户", "付款账户", "repaymentAccount"],
  creditAccount: ["信用卡账户", "卡账户", "卡号末四位", "信用卡后四位", "信用卡末四位", "后四位", "末四位", "cardAccount", "cardLast4"],
  transferCounterAccount: ["对向账户", "流向账户", "转入账户", "转出账户", "对方账户", "对手账户", "对方户名", "toAccount"],
  remark: ["备注", "remark", "摘要", "说明", "交易摘要", "交易说明", "用途"],
  category: ["分类", "category"],
  institution: ["收支机构", "机构", "商户", "商户名称", "交易商户", "收款方", "付款方", "交易对方", "institution", "merchant"],
  tags: ["标签", "tags"],
  majorType: ["收支大类", "大类", "收支", "方向", "majorType"],
  explicitType: ["类型", "原始类型", "交易类型", "业务类型", "收支类型", "借贷标志", "借贷方向", "type"],
  secondRemark: ["第二备注", "对方备注", "转入备注", "toNote", "secondRemark"],
};

export const SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE: StatementHeaderProfile<SpdbCreditCardTransactionField> = {
  institutionName: "浦发银行",
  minValidSampleRows: 2,
  requiredHeaders: {
    transactionDate: ["交易日期"],
    postingDate: ["记账日期"],
    description: ["交易摘要"],
    cardLast4: ["卡号末四位"],
    cardType: ["卡片类型"],
    currency: ["交易币种"],
    amount: ["交易金额"],
    originalAmount: ["原始交易金额&币种"],
  },
};

export function isStatementImportField(value: string): value is StatementImportField {
  return Object.prototype.hasOwnProperty.call(STATEMENT_IMPORT_FIELD_HEADERS, value);
}

export function normalizeStatementHeader(value: string) {
  return value.replace(/\s+/g, "").replace(/[：:]/g, "").trim().toLowerCase();
}

export function buildStatementImportFieldHeaders(
  samples: readonly StatementFieldRecognitionSample[] = [],
): Record<StatementImportField, readonly string[]> {
  const merged = Object.fromEntries(
    Object.entries(STATEMENT_IMPORT_FIELD_HEADERS).map(([field, aliases]) => [field, [...aliases]]),
  ) as Record<StatementImportField, string[]>;
  const seenByField = new Map<StatementImportField, Set<string>>();

  for (const field of Object.keys(merged) as StatementImportField[]) {
    seenByField.set(field, new Set(merged[field].map(normalizeStatementHeader)));
  }

  for (const sample of samples) {
    if (sample.targetType !== "field") continue;
    const fieldName = String(sample.fieldName ?? "");
    if (!isStatementImportField(fieldName)) continue;
    const alias = String(sample.matchText || sample.normalizedText || "").trim();
    if (!alias) continue;
    const normalizedAlias = normalizeStatementHeader(alias);
    if (!normalizedAlias || seenByField.get(fieldName)?.has(normalizedAlias)) continue;
    merged[fieldName].push(alias);
    seenByField.get(fieldName)?.add(normalizedAlias);
  }

  return merged;
}

export function findStatementHeaderIndex(headers: readonly string[], aliases: readonly string[]) {
  const aliasSet = new Set(aliases.map(normalizeStatementHeader));
  const matchedIndexes = headers
    .map((header, index) => aliasSet.has(normalizeStatementHeader(header)) ? index : -1)
    .filter((index) => index >= 0);
  return matchedIndexes.length === 1 ? matchedIndexes[0] : -1;
}

export function findFirstStatementHeaderIndex(headers: readonly string[], aliases: readonly string[]) {
  const normalizedHeaders = headers.map(normalizeStatementHeader);
  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(normalizeStatementHeader(alias));
    if (index >= 0) return index;
  }
  return -1;
}

export function matchStatementHeaderProfile<TField extends string>(
  headers: readonly string[],
  profile: StatementHeaderProfile<TField>,
) {
  const indexes = {} as Record<TField, number>;
  for (const [field, aliases] of Object.entries(profile.requiredHeaders) as Array<[TField, readonly string[]]>) {
    const index = findStatementHeaderIndex(headers, aliases);
    if (index < 0) return null;
    indexes[field] = index;
  }
  return indexes;
}

export function createStatementHeaderReader(
  headers: readonly string[],
  fieldHeaders: Record<StatementImportField, readonly string[]> = STATEMENT_IMPORT_FIELD_HEADERS,
) {
  const indexCache = new Map<string, number>();
  const findIndex = (aliases: readonly string[]) => {
    const cacheKey = aliases.join("\u0001");
    if (!indexCache.has(cacheKey)) {
      indexCache.set(cacheKey, findFirstStatementHeaderIndex(headers, aliases));
    }
    return indexCache.get(cacheKey) ?? -1;
  };

  const readAliases = (row: readonly string[], aliases: readonly string[]) => {
    const index = findIndex(aliases);
    return index >= 0 ? String(row[index] ?? "").trim() : "";
  };

  const hasAliases = (aliases: readonly string[]) => findIndex(aliases) >= 0;

  const readField = (row: readonly string[], field: StatementImportField) => readAliases(row, fieldHeaders[field]);
  const hasField = (field: StatementImportField) => hasAliases(fieldHeaders[field]);
  const findFieldIndex = (field: StatementImportField) => findIndex(fieldHeaders[field]);

  return { readAliases, hasAliases, findIndex, readField, hasField, findFieldIndex };
}
