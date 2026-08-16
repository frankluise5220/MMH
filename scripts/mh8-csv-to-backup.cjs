const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INPUT_DIR = path.resolve(process.argv[2] || "output/mh8-csv-dedup");
const OUTPUT_FILE = path.resolve(process.argv[3] || path.join(INPUT_DIR, "mh8-restorable.mmh-backup"));
const SUMMARY_FILE = path.join(path.dirname(OUTPUT_FILE), "mh8-restore-package-summary.json");
const PASSPHRASE = process.env.MH8_BACKUP_PASSPHRASE || crypto.randomBytes(18).toString("base64url");

const BACKUP_FORMAT_VERSION = 4;
const ENCRYPTED_BACKUP_PACKAGE_VERSION = 3;
const ENCRYPTED_BACKUP_ALGORITHM = "aes-256-gcm";
const BACKUP_PASSPHRASE_KDF = "pbkdf2-sha256";
const BACKUP_PASSPHRASE_KDF_ITERATIONS = 210000;

const HOUSEHOLD_ID = "mh8_household_import";
const HOUSEHOLD_NAME = "MH8 导入账簿";
const IMPORT_BATCH_ID = "mh8_csv_restore_batch";
const EXPORT_SOURCE = "mh8_csv_restore";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((items) => items.some((item) => String(item ?? "").trim() !== ""));
}

function readCsv(name, optional = false) {
  const file = path.join(INPUT_DIR, name);
  if (!fs.existsSync(file)) {
    if (optional) return [];
    throw new Error(`Missing input file: ${file}`);
  }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => String(header ?? "").trim());
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? "").trim();
    });
    return record;
  });
}

function hashId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash("sha256").update(parts.join("\u001F")).digest("hex").slice(0, 24)}`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const text = clean(value).replace(/,/g, "");
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountString(value, scale = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return scale === 2 ? "0.00" : "0";
  return parsed.toFixed(scale);
}

function nullableAmount(value, scale = 2) {
  const text = clean(value).replace(/,/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed.toFixed(scale) : null;
}

function dateOnly(value) {
  const text = clean(value);
  const match = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function isoDate(value) {
  const date = dateOnly(value);
  return date ? `${date}T00:00:00.000Z` : null;
}

function compactNote(...parts) {
  return parts.map(clean).filter(Boolean).join(" | ") || null;
}

function splitTags(value) {
  return clean(value)
    .split(/[;,，；、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sourceKey(row) {
  return `${clean(row.mh8TransID)}\u001F${clean(row.sourceFile || row["来源文件"])}`;
}

function flowKindForFundSubtype(subtype) {
  if (subtype === "buy" || subtype === "regular_invest" || subtype === "switch_in") return "buy_out";
  if (subtype === "buy_failed") return "refund_in";
  if (subtype === "dividend_cash") return "dividend_in";
  if (subtype === "dividend_reinvest") return "dividend_reinvest_internal";
  return "redeem_in";
}

function normalizeFundSubtype(rawSubtype, rawSource) {
  const subtype = clean(rawSubtype).toLowerCase();
  const source = clean(rawSource).toLowerCase();
  if (subtype === "refund" || source === "regular_invest_refund") return "buy_failed";
  if (subtype === "regular_invest") return "buy";
  if (subtype === "dividend" || subtype === "cash_dividend") return "dividend_cash";
  if (subtype === "reinvest") return "dividend_reinvest";
  if (
    [
      "buy",
      "redeem",
      "dividend_reinvest",
      "dividend_cash",
      "switch_in",
      "switch_out",
      "buy_failed",
    ].includes(subtype)
  ) {
    return subtype;
  }
  return "buy";
}

function isFundCashReceipt(subtype) {
  return subtype === "redeem" || subtype === "switch_out" || subtype === "dividend_cash" || subtype === "buy_failed";
}

function encodeBalanceReconcileTarget(balance) {
  return `balance_reconcile_target:${Number(balance || 0).toFixed(2)}`;
}

function deriveKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
}

function encryptPayload(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt, BACKUP_PASSPHRASE_KDF_ITERATIONS);
  const cipher = crypto.createCipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    app: "MMH",
    packageType: "encrypted-backup",
    packageVersion: ENCRYPTED_BACKUP_PACKAGE_VERSION,
    encrypted: true,
    exportedAt: payload.exportedAt,
    scope: payload.scope,
    encryption: {
      algorithm: ENCRYPTED_BACKUP_ALGORITHM,
      keySource: "passphrase",
      kdf: BACKUP_PASSPHRASE_KDF,
      iterations: BACKUP_PASSPHRASE_KDF_ITERATIONS,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptPackage(pkg, passphrase) {
  const encryption = pkg.encryption || {};
  const key = deriveKey(
    passphrase,
    Buffer.from(String(encryption.salt || ""), "base64"),
    Number(encryption.iterations || BACKUP_PASSPHRASE_KDF_ITERATIONS),
  );
  const decipher = crypto.createDecipheriv(
    ENCRYPTED_BACKUP_ALGORITHM,
    key,
    Buffer.from(String(encryption.iv || ""), "base64"),
  );
  decipher.setAuthTag(Buffer.from(String(encryption.authTag || ""), "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(pkg.ciphertext || ""), "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

const accountTypeRows = readCsv("mh8_account_type_mapping.csv", true);
const accountTypeById = new Map(
  accountTypeRows.map((row) => [
    clean(row.mh8AccountTypeId),
    {
      kind: clean(row.mmhAccountKind) || "other",
      debtDirection: clean(row.mmhDebtDirection) || null,
      investProductType: clean(row.mmhInvestProductType) || null,
    },
  ]),
);

const categorySeedRows = readCsv("mh8_category_mapping_seed.csv", true);
const categoryPathByRaw = new Map();
const categoryTypeByRaw = new Map();
for (const row of categorySeedRows) {
  const raw = clean(row.mh8CategoryPath);
  if (!raw) continue;
  const mapped = clean(row.suggestedMmhCategoryPath) || raw;
  categoryPathByRaw.set(raw, mapped);
  categoryTypeByRaw.set(mapped, clean(row.suggestedMmhType) || "expense");
}

const nowIso = new Date().toISOString();
const groups = [
  { id: "mh8_group_cash", name: "MH8 现金与银行", sortOrder: 10 },
  { id: "mh8_group_credit", name: "MH8 信用与负债", sortOrder: 20 },
  { id: "mh8_group_investment", name: "MH8 投资资产", sortOrder: 30 },
  { id: "mh8_group_other", name: "MH8 其他账户", sortOrder: 90 },
].map((item) => ({
  ...item,
  householdId: HOUSEHOLD_ID,
  createdAt: nowIso,
  updatedAt: nowIso,
}));

function groupForKind(kind) {
  if (kind === "loan" || kind === "bank_credit") return "mh8_group_credit";
  if (kind === "investment" || kind === "deposit" || kind === "insurance") return "mh8_group_investment";
  if (kind === "cash" || kind === "bank_debit" || kind === "ewallet") return "mh8_group_cash";
  return "mh8_group_other";
}

const accounts = new Map();
const categories = new Map();
const institutions = new Map();
const tags = new Map();
const entryTags = [];
const transactions = [];
const fundTransactions = [];
const fundTransactionCashFlows = [];
const entryBusinessLinks = [];
const warnings = [];
const fundReviewRowsBySourceFile = new Map();
const stats = {
  ordinaryBillRows: 0,
  fundRows: 0,
  fundReviewRowsAsFundTransactions: 0,
  fundRowsWithoutCode: 0,
  candidateRows: 0,
  zeroAmountReviewRows: 0,
};

function inferAccountShape(name, preferred = {}) {
  const text = clean(name);
  const preferredKind = clean(preferred.kind);
  let kind = preferredKind || "other";
  let debtDirection = preferred.debtDirection || null;
  let investProductType = preferred.investProductType || null;

  if (!preferredKind) {
    if (/信用卡|花呗|白条/.test(text)) kind = "bank_credit";
    else if (/现金/.test(text)) kind = "cash";
    else if (/支付宝|微信|余额宝|京东|美团|第三方|加油卡/.test(text)) kind = "ewallet";
    else if (/银行|银行卡|招行|工行|农商行|农合|借记卡|活期/.test(text)) kind = "bank_debit";
    else if (/保险/.test(text)) kind = "insurance";
    else if (/基金|证券|股票|贵金属|理财|房产|资产|网贷/.test(text)) kind = "investment";
    else if (/应收|借出/.test(text)) {
      kind = "loan";
      debtDirection = "receivable";
    } else if (/应付|借入|贷款/.test(text)) {
      kind = "loan";
      debtDirection = "payable";
    }
  }

  if (!investProductType) {
    if (/货币基金/.test(text)) investProductType = "money";
    else if (/基金/.test(text)) investProductType = "fund";
    else if (/证券|股票/.test(text)) investProductType = "stock";
    else if (/贵金属/.test(text)) investProductType = "metal";
    else if (/房产|重大资产/.test(text)) investProductType = "property";
    else if (/定期/.test(text)) investProductType = "deposit";
  }

  if (kind === "investment" && !investProductType) investProductType = null;
  return { kind, debtDirection, investProductType };
}

function ensureAccount(name, preferred = {}) {
  const accountName = clean(name) || "MH8 未知账户";
  const existing = accounts.get(accountName);
  const inferred = inferAccountShape(accountName, preferred);
  if (existing) {
    if (preferred.investProductType && !existing.investProductType) existing.investProductType = preferred.investProductType;
    if (preferred.kind && existing.kind === "other") existing.kind = preferred.kind;
    if (preferred.debtDirection && !existing.debtDirection) existing.debtDirection = preferred.debtDirection;
    existing.groupId = groupForKind(existing.kind);
    return existing;
  }
  const account = {
    id: hashId("acct", accountName),
    name: accountName,
    balance: "0.00",
    kind: inferred.kind,
    debtDirection: inferred.debtDirection,
    currency: "CNY",
    isActive: true,
    isPlaceholder: false,
    investProductType: inferred.investProductType,
    creditLimit: null,
    billingDay: null,
    repaymentDay: null,
    creditBillMode: "separate",
    numberMasked: null,
    routeKey: null,
    note: "Imported from MH8 CSV",
    usageCount: 0,
    lastUsedAt: null,
    householdId: HOUSEHOLD_ID,
    institutionId: null,
    counterpartyId: null,
    userId: null,
    groupId: groupForKind(inferred.kind),
    createdAt: nowIso,
    updatedAt: nowIso,
    costBasisMethod: inferred.investProductType === "fund" || inferred.investProductType === "money" ? "moving_avg" : null,
    defaultConfirmDays: null,
    defaultArrivalDays: null,
    tradingCalendar: inferred.investProductType === "fund" || inferred.investProductType === "money" ? "cn_fund" : null,
    defaultFundQueryApiId: null,
    fundUnitsDecimals: 3,
  };
  accounts.set(accountName, account);
  return account;
}

function ensureCategory(name, fallbackType) {
  const rawName = clean(name);
  if (!rawName) return null;
  const categoryName = categoryPathByRaw.get(rawName) || rawName;
  const existing = categories.get(categoryName);
  if (existing) return existing;
  const type = categoryTypeByRaw.get(categoryName) || fallbackType || "expense";
  const category = {
    id: hashId("cat", categoryName),
    name: categoryName,
    type,
    icon: null,
    parentId: null,
    householdId: HOUSEHOLD_ID,
    isSystem: false,
  };
  categories.set(categoryName, category);
  return category;
}

function ensureInstitution(name) {
  const institutionName = clean(name);
  if (!institutionName) return null;
  const existing = institutions.get(institutionName);
  if (existing) return existing;
  const institution = {
    id: hashId("inst", institutionName),
    name: institutionName,
    shortName: null,
    type: "payment",
    householdId: HOUSEHOLD_ID,
  };
  institutions.set(institutionName, institution);
  return institution;
}

function ensureTag(name) {
  const tagName = clean(name);
  if (!tagName) return null;
  const existing = tags.get(tagName);
  if (existing) return existing;
  const tag = {
    id: hashId("tag", tagName),
    name: tagName,
    color: null,
    householdId: HOUSEHOLD_ID,
  };
  tags.set(tagName, tag);
  return tag;
}

function attachTags(entryId, tagText) {
  for (const tagName of splitTags(tagText)) {
    const tag = ensureTag(tagName);
    if (tag) entryTags.push({ entryId, tagId: tag.id });
  }
}

function addTransaction(input) {
  const date = isoDate(input.date) || "1970-01-01T00:00:00.000Z";
  const account = ensureAccount(input.accountName, input.accountShape);
  const toAccount = clean(input.toAccountName) ? ensureAccount(input.toAccountName, input.toAccountShape) : null;
  const category = ensureCategory(input.categoryName, input.categoryType || input.type);
  const institution = ensureInstitution(input.institutionName);
  const id = input.id || hashId("tx", input.seed || transactions.length, date, input.accountName, input.amount, input.note);
  const tx = {
    id,
    date,
    postedAt: input.postedAt ? isoDate(input.postedAt) : null,
    type: input.type || "expense",
    amount: amountString(input.amount, 2),
    accountId: account.id,
    accountName: account.name,
    toAccountId: toAccount ? toAccount.id : null,
    toAccountName: toAccount ? toAccount.name : null,
    categoryId: category ? category.id : null,
    categoryName: category ? category.name : null,
    fundCode: null,
    fundProductType: input.fundProductType || null,
    metalTypeId: null,
    metalTypeName: input.metalTypeName || null,
    metalUnitId: null,
    metalUnitName: input.metalUnitName || null,
    metalQuantity: input.metalQuantity == null ? null : amountString(input.metalQuantity, 6),
    metalUnitPrice: input.metalUnitPrice == null ? null : amountString(input.metalUnitPrice, 6),
    metalFee: input.metalFee == null ? null : amountString(input.metalFee, 2),
    confirmDate: null,
    statementMonth: null,
    note: input.note || null,
    toNote: input.toNote || null,
    deletedAt: null,
    importBatchId: IMPORT_BATCH_ID,
    householdId: HOUSEHOLD_ID,
    createdAt: input.createdAt || date,
    updatedAt: input.updatedAt || nowIso,
    dayOrder: transactions.length,
    currency: "CNY",
    paymentChannelId: null,
    paymentChannelName: null,
    counterpartyInstitutionId: institution ? institution.id : null,
    counterpartyInstitutionName: institution ? institution.name : null,
    status: "posted",
    fundArrivalAmount: input.fundArrivalAmount == null ? null : amountString(input.fundArrivalAmount, 2),
    fundArrivalDate: input.fundArrivalDate ? isoDate(input.fundArrivalDate) : null,
    depositAnnualRate: null,
    depositInterest: null,
    depositSourceEntryId: null,
    fundSourceEntryId: null,
    debtPrincipalAmount: input.debtPrincipalAmount == null ? null : amountString(input.debtPrincipalAmount, 2),
    debtInterestAmount: input.debtInterestAmount == null ? null : amountString(input.debtInterestAmount, 2),
    debtFeeAmount: input.debtFeeAmount == null ? null : amountString(input.debtFeeAmount, 2),
    fundConfirmDate: input.fundConfirmDate ? isoDate(input.fundConfirmDate) : null,
    fundFee: input.fundFee == null ? null : amountString(input.fundFee, 2),
    fundNav: input.fundNav == null ? null : amountString(input.fundNav, 6),
    fundSubtype: input.fundSubtype || null,
    fundUnits: input.fundUnits == null ? null : amountString(input.fundUnits, 6),
    realizedProfit: input.realizedProfit == null ? null : amountString(input.realizedProfit, 2),
    regularInvestPlanId: null,
    creditCardInstallmentPlanId: null,
    installmentNo: null,
    installmentTotal: null,
    installmentPrincipal: null,
    installmentInterest: null,
    installmentRole: null,
    fundName: input.fundName || null,
    wealthProductId: null,
    insuranceProductId: null,
    insuranceAction: input.insuranceAction || null,
    insuranceProductName: input.insuranceProductName || null,
    source: input.source || EXPORT_SOURCE,
  };
  transactions.push(tx);
  if (Number(tx.amount) === 0) stats.zeroAmountReviewRows += 1;
  attachTags(id, input.tags);
  return tx;
}

function addBusinessCashLink({ txId, fundTransactionId, businessType, direction, note }) {
  entryBusinessLinks.push({
    id: hashId("link", txId, fundTransactionId || "", businessType),
    householdId: HOUSEHOLD_ID,
    cashEntryId: txId || null,
    businessEntryId: null,
    fundTransactionId: fundTransactionId || null,
    insuranceTransactionId: null,
    wealthTransactionId: null,
    depositTransactionId: null,
    preciousMetalTransactionId: null,
    stockTransactionId: null,
    propertyTransactionId: null,
    businessType,
    linkType: "cash_flow",
    cashFlowDirection: direction,
    source: EXPORT_SOURCE,
    note,
    metadata: { splitRecord: true, independentBusinessTransaction: true, source: "mh8_csv" },
    deletedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

function addCandidateCashFlow(row, options) {
  const amount = Math.abs(money(options.amount));
  const direction = options.direction || "outflow";
  const isInflow = direction === "inflow";
  const fromName = clean(options.fromAccount);
  const toName = clean(options.toAccount);
  const tx = addTransaction({
    seed: `${options.seedPrefix}:${sourceKey(row)}`,
    date: row.date,
    type: options.type || (isInflow ? "income" : "expense"),
    amount: isInflow ? amount : -amount,
    accountName: isInflow ? (fromName || toName) : (fromName || toName),
    toAccountName: toName && toName !== fromName ? toName : null,
    accountShape: options.fromShape,
    toAccountShape: options.toShape,
    categoryName: options.categoryName || row.category,
    categoryType: options.categoryType,
    institutionName: row.institution,
    note: compactNote(row.note, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`, options.extraNote),
    source: `${EXPORT_SOURCE}_${options.sourceSuffix || options.seedPrefix}`,
    debtPrincipalAmount: options.debtPrincipalAmount,
    debtInterestAmount: options.debtInterestAmount,
    debtFeeAmount: options.debtFeeAmount,
    fundProductType: options.fundProductType || null,
    metalQuantity: options.metalQuantity,
    metalUnitPrice: options.metalUnitPrice,
    metalUnitName: options.metalUnitName,
  });
  stats.candidateRows += 1;
  return tx;
}

for (const row of readCsv("mh8_accounts_reference.csv", true)) {
  const name = clean(row["账户名"]);
  if (!name) continue;
  const mapped = accountTypeById.get(clean(row["账户类型ID"])) || {};
  const account = ensureAccount(name, mapped);
  const masked = clean(row["卡号"] || row["账号"]);
  if (masked && !account.numberMasked) account.numberMasked = masked.slice(-8);
  const hidden = clean(row["已结束"]).toUpperCase() === "TRUE" || clean(row["隐藏标记"]) === "1";
  if (hidden) account.isActive = false;
}

const billRows = readCsv("mmh_bill_import.csv");
for (const row of billRows) {
  const rawType = clean(row["收支大类"]).toLowerCase();
  const inflow = Math.abs(money(row["流入"]));
  const outflow = Math.abs(money(row["流出"]));
  const rawAmount = Math.abs(money(row["金额"])) || inflow || outflow;
  const accountName = clean(row["账户"]);
  const counterAccountName = clean(row["对向账户"]);
  if (!accountName && !counterAccountName) {
    warnings.push({ file: "mmh_bill_import.csv", row: stats.ordinaryBillRows + 2, reason: "missing account" });
    continue;
  }

  if (/转账|transfer/.test(rawType)) {
    if (inflow > 0 && outflow <= 0 && counterAccountName) {
      addTransaction({
        seed: `bill:${stats.ordinaryBillRows}`,
        date: row["日期"],
        postedAt: row["入账日期"],
        type: "transfer",
        amount: -rawAmount,
        accountName: counterAccountName,
        toAccountName: accountName,
        categoryName: row["分类"] || "转账",
        categoryType: "transfer",
        institutionName: row["收支机构"],
        tags: row["标签"],
        note: row["备注"],
        source: `${EXPORT_SOURCE}_bill`,
      });
    } else {
      addTransaction({
        seed: `bill:${stats.ordinaryBillRows}`,
        date: row["日期"],
        postedAt: row["入账日期"],
        type: "transfer",
        amount: inflow > 0 && outflow <= 0 ? rawAmount : -rawAmount,
        accountName,
        toAccountName: counterAccountName || null,
        categoryName: row["分类"] || "转账",
        categoryType: "transfer",
        institutionName: row["收支机构"],
        tags: row["标签"],
        note: row["备注"],
        source: `${EXPORT_SOURCE}_bill`,
      });
    }
  } else if (/收入|income/.test(rawType) || (inflow > 0 && outflow <= 0)) {
    addTransaction({
      seed: `bill:${stats.ordinaryBillRows}`,
      date: row["日期"],
      postedAt: row["入账日期"],
      type: "income",
      amount: inflow > 0 && outflow <= 0 ? rawAmount : -rawAmount,
      accountName,
      categoryName: row["分类"],
      categoryType: "income",
      institutionName: row["收支机构"],
      tags: row["标签"],
      note: row["备注"],
      source: `${EXPORT_SOURCE}_bill`,
    });
  } else {
    addTransaction({
      seed: `bill:${stats.ordinaryBillRows}`,
      date: row["日期"],
      postedAt: row["入账日期"],
      type: "expense",
      amount: inflow > 0 && outflow <= 0 ? rawAmount : -rawAmount,
      accountName,
      categoryName: row["分类"],
      categoryType: "expense",
      institutionName: row["收支机构"],
      tags: row["标签"],
      note: row["备注"],
      source: `${EXPORT_SOURCE}_bill`,
    });
  }
  stats.ordinaryBillRows += 1;
}

const fundRows = readCsv("mmh_fund_import.csv");
for (const row of fundRows) {
  const fundCode = clean(row["基金代码"]);
  const fundAccountName = clean(row["基金账户"]);
  if (!fundCode || !fundAccountName) {
    stats.fundRowsWithoutCode += 1;
    continue;
  }
  const subtype = normalizeFundSubtype(row["基金动作"], row["来源"]);
  const source = clean(row["来源"]) || "manual";
  const grossAmount = Math.abs(money(row["金额"]));
  const cashReceipt = isFundCashReceipt(subtype);
  const cashAccountName = clean(row["资金账户"]);
  const fundAccount = ensureAccount(fundAccountName, { kind: "investment", investProductType: /货币/.test(fundAccountName) ? "money" : "fund" });
  const cashAccount = cashAccountName ? ensureAccount(cashAccountName) : null;
  const arrivalAmount = cashReceipt ? grossAmount : null;
  let cashEntryId = null;

  if (cashAccount && grossAmount >= 0) {
    const amount = cashReceipt ? grossAmount : -grossAmount;
    const tx = addTransaction({
      seed: `fund-cash:${stats.fundRows}`,
      date: cashReceipt ? (row["入账日期"] || row["日期"]) : row["日期"],
      type: "investment",
      amount,
      accountName: cashReceipt ? fundAccount.name : cashAccount.name,
      toAccountName: cashReceipt ? cashAccount.name : fundAccount.name,
      accountShape: cashReceipt ? { kind: "investment", investProductType: fundAccount.investProductType || "fund" } : undefined,
      toAccountShape: cashReceipt ? undefined : { kind: "investment", investProductType: fundAccount.investProductType || "fund" },
      categoryName: subtype === "buy" ? "基金买入" : subtype === "buy_failed" ? "基金退款" : subtype === "dividend_cash" ? "基金分红" : "基金赎回",
      categoryType: "investment",
      note: compactNote(row["备注"], `${fundCode} ${clean(row["基金名称"])}`),
      source: `${EXPORT_SOURCE}_fund_cash`,
      fundProductType: fundAccount.investProductType || "fund",
      fundSubtype: subtype,
      fundCode,
      fundName: clean(row["基金名称"]) || null,
      fundUnits: nullableAmount(row["份额"], 6) == null ? null : Math.abs(money(row["份额"])),
      fundNav: nullableAmount(row["净值"], 6) == null ? null : money(row["净值"]),
      fundFee: nullableAmount(row["手续费"], 2) == null ? null : Math.abs(money(row["手续费"])),
      fundConfirmDate: row["净值日期"],
      fundArrivalDate: row["入账日期"],
      fundArrivalAmount: arrivalAmount,
    });
    cashEntryId = tx.id;
  }

  const fundTxId = hashId("fundtx", stats.fundRows, row["日期"], fundAccount.name, fundCode, clean(row["基金名称"]), grossAmount, clean(row["份额"]));
  fundTransactions.push({
    id: fundTxId,
    householdId: HOUSEHOLD_ID,
    fundAccountId: fundAccount.id,
    cashAccountId: cashAccount ? cashAccount.id : null,
    cashEntryId,
    fundCode,
    fundName: clean(row["基金名称"]) || null,
    fundProductType: fundAccount.investProductType === "money" ? "money" : "fund",
    fundSubtype: subtype,
    source,
    applyDate: isoDate(row["日期"]) || "1970-01-01T00:00:00.000Z",
    confirmDate: isoDate(row["净值日期"]),
    arrivalDate: isoDate(row["入账日期"]),
    grossAmount: amountString(grossAmount, 2),
    refundAmount: subtype === "buy_failed" ? amountString(grossAmount, 2) : "0.00",
    arrivalAmount: arrivalAmount == null ? null : amountString(arrivalAmount, 2),
    fee: nullableAmount(row["手续费"], 2),
    nav: nullableAmount(row["净值"], 6),
    units: nullableAmount(row["份额"], 6),
    realizedProfit: null,
    regularInvestPlanId: null,
    note: row["备注"] || null,
    deletedAt: null,
    createdAt: isoDate(row["日期"]) || nowIso,
    updatedAt: nowIso,
  });

  if (cashEntryId) {
    fundTransactionCashFlows.push({
      id: hashId("fundcf", fundTxId, cashEntryId),
      fundTransactionId: fundTxId,
      txRecordId: cashEntryId,
      kind: flowKindForFundSubtype(subtype),
      amount: amountString(grossAmount, 2),
      flowDate: isoDate(row["入账日期"] || row["日期"]) || "1970-01-01T00:00:00.000Z",
      accountId: cashAccount ? cashAccount.id : null,
      createdAt: nowIso,
    });
    addBusinessCashLink({
      txId: cashEntryId,
      fundTransactionId: fundTxId,
      businessType: "fund",
      direction: cashReceipt ? "inflow" : "outflow",
      note: "Linked MH8 fund cash flow",
    });
  }
  stats.fundRows += 1;
}

for (const row of readCsv("mh8_fund_candidate_review.csv", true)) {
  const mh8Id = clean(row.mh8TransID) || String(stats.fundReviewRowsAsFundTransactions + 1);
  const sourceFile = clean(row.sourceFile);
  const sourceFileKey = sourceFile || "(unknown)";
  fundReviewRowsBySourceFile.set(sourceFileKey, (fundReviewRowsBySourceFile.get(sourceFileKey) || 0) + 1);
  const subtype = normalizeFundSubtype(row.action, row.source);
  const grossAmount = Math.abs(money(row.amount));
  const cashReceipt = isFundCashReceipt(subtype);
  const fundAccountName = clean(row.fundAccount) || clean(row.cashAccount) || "MH8 基金账户待确认";
  const cashAccountName = clean(row.cashAccount);
  const fundAccount = ensureAccount(fundAccountName, { kind: "investment", investProductType: "fund" });
  const cashAccount = cashAccountName ? ensureAccount(cashAccountName) : null;
  const fundCode = clean(row.fundCode) || `MH8-${mh8Id}`;
  const fundName = clean(row.fundName) || `MH8未识别基金#${mh8Id}`;
  const note = compactNote(
    row.note,
    sourceFile ? `MH8:${sourceFile}#${mh8Id}` : `MH8:#${mh8Id}`,
    clean(row.fundCode) ? "" : "基金代码缺失，已使用临时代码",
    clean(row.fundName) ? "" : "基金名称缺失，已使用临时名称",
  );
  let cashEntryId = null;

  if (grossAmount > 0 && (cashAccount || cashAccountName || clean(row.fundAccount))) {
    const amount = cashReceipt ? grossAmount : -grossAmount;
    const tx = addTransaction({
      seed: `fund-review-cash:${sourceKey(row)}`,
      date: cashReceipt ? (row.arrivalDate || row.date) : row.date,
      type: "investment",
      amount,
      accountName: cashReceipt ? fundAccount.name : (cashAccount?.name || fundAccount.name),
      toAccountName: cashReceipt ? (cashAccount?.name || null) : fundAccount.name,
      accountShape: cashReceipt ? { kind: "investment", investProductType: "fund" } : undefined,
      toAccountShape: cashReceipt ? undefined : { kind: "investment", investProductType: "fund" },
      categoryName: row.category || (subtype === "redeem" ? "基金赎回" : "基金买入"),
      categoryType: "investment",
      institutionName: row.institution,
      note,
      source: `${EXPORT_SOURCE}_fund_review_cash`,
      fundProductType: "fund",
      fundSubtype: subtype,
      fundCode,
      fundName,
      fundUnits: nullableAmount(row.units, 6) == null ? null : Math.abs(money(row.units)),
      fundNav: nullableAmount(row.nav, 6) == null ? null : money(row.nav),
      fundFee: nullableAmount(row.fee, 2) == null ? null : Math.abs(money(row.fee)),
      fundConfirmDate: row.confirmDate || row.date,
      fundArrivalDate: row.arrivalDate || row.date,
      fundArrivalAmount: cashReceipt ? grossAmount : null,
    });
    cashEntryId = tx.id;
  }

  const fundTxId = hashId("fundtx_review", sourceKey(row), fundCode);
  fundTransactions.push({
    id: fundTxId,
    householdId: HOUSEHOLD_ID,
    fundAccountId: fundAccount.id,
    cashAccountId: cashAccount ? cashAccount.id : null,
    cashEntryId,
    fundCode,
    fundName,
    fundProductType: "fund",
    fundSubtype: subtype,
    source: `${EXPORT_SOURCE}_fund_review`,
    applyDate: isoDate(row.date) || "1970-01-01T00:00:00.000Z",
    confirmDate: isoDate(row.confirmDate || row.date),
    arrivalDate: isoDate(row.arrivalDate || row.date),
    grossAmount: amountString(grossAmount, 2),
    refundAmount: subtype === "buy_failed" ? amountString(grossAmount, 2) : "0.00",
    arrivalAmount: cashReceipt ? amountString(grossAmount, 2) : null,
    fee: nullableAmount(row.fee, 2),
    nav: nullableAmount(row.nav, 6),
    units: nullableAmount(row.units, 6) == null ? null : amountString(Math.abs(money(row.units)), 6),
    realizedProfit: null,
    regularInvestPlanId: null,
    note,
    deletedAt: null,
    createdAt: isoDate(row.date) || nowIso,
    updatedAt: nowIso,
  });

  if (cashEntryId) {
    fundTransactionCashFlows.push({
      id: hashId("fundcf_review", fundTxId, cashEntryId),
      fundTransactionId: fundTxId,
      txRecordId: cashEntryId,
      kind: flowKindForFundSubtype(subtype),
      amount: amountString(grossAmount, 2),
      flowDate: isoDate(row.arrivalDate || row.date) || "1970-01-01T00:00:00.000Z",
      accountId: cashAccount ? cashAccount.id : null,
      createdAt: nowIso,
    });
  }
  addBusinessCashLink({
    txId: cashEntryId,
    fundTransactionId: fundTxId,
    businessType: "fund",
    direction: cashEntryId ? (cashReceipt ? "inflow" : "outflow") : "none",
    note: "Linked MH8 fund review transaction",
  });
  stats.fundReviewRowsAsFundTransactions += 1;
  stats.candidateRows += 1;
  if (!clean(row.fundCode) || !clean(row.fundName)) stats.fundRowsWithoutCode += 1;
}

for (const row of readCsv("mh8_stock_candidate_import.csv", true)) {
  const action = clean(row.action);
  addCandidateCashFlow(row, {
    seedPrefix: "stock",
    type: "investment",
    direction: action === "sell" ? "inflow" : "outflow",
    fromAccount: action === "sell" ? row.stockAccount : (row.cashAccount || row.stockAccount),
    toAccount: action === "sell" ? row.cashAccount : row.stockAccount,
    fromShape: action === "sell" ? { kind: "investment", investProductType: "stock" } : undefined,
    toShape: action === "sell" ? undefined : { kind: "investment", investProductType: "stock" },
    amount: row.cashAmount || row.tradeAmount,
    categoryName: row.category || (action === "sell" ? "股票卖出" : "股票买入"),
    categoryType: "investment",
    sourceSuffix: "stock",
    extraNote: compactNote(row.securityCode, row.securityName, row.market, row.quantity),
    fundProductType: "stock",
  });
}

for (const row of readCsv("mh8_insurance_candidate_import.csv", true)) {
  const action = clean(row.action);
  addCandidateCashFlow(row, {
    seedPrefix: "insurance",
    type: "investment",
    direction: action === "premium" ? "outflow" : "inflow",
    fromAccount: action === "premium" ? (row.cashAccount || row.insuranceAccount) : row.insuranceAccount,
    toAccount: action === "premium" ? row.insuranceAccount : row.cashAccount,
    fromShape: action === "premium" ? undefined : { kind: "insurance" },
    toShape: action === "premium" ? { kind: "insurance" } : undefined,
    amount: row.cashAmount || row.amount,
    categoryName: row.category || (action === "premium" ? "保险支出" : "保险回款"),
    categoryType: "investment",
    sourceSuffix: "insurance",
    extraNote: compactNote(row.productName, row.action),
    insuranceAction: action || null,
    insuranceProductName: clean(row.productName) || null,
  });
}

for (const row of readCsv("mh8_debt_candidate_import.csv", true)) {
  const action = clean(row.action);
  const cashAmount = Math.abs(money(row.cashAmount || row.principalAmount));
  let fromAccount = row.cashAccount;
  let toAccount = row.debtAccount;
  let signedAmount = -cashAmount;
  const debtDirection = action === "borrow_in" || action === "repay_payable" ? "payable" : "receivable";
  if (action === "collect_in" || action === "borrow_in") {
    fromAccount = row.debtAccount;
    toAccount = row.cashAccount;
    signedAmount = action === "collect_in" ? cashAmount : -cashAmount;
  }
  const tx = addTransaction({
    seed: `debt:${sourceKey(row)}`,
    date: row.date,
    type: "transfer",
    amount: signedAmount,
    accountName: fromAccount,
    toAccountName: toAccount,
    accountShape: clean(fromAccount) === clean(row.debtAccount) ? { kind: "loan", debtDirection } : undefined,
    toAccountShape: clean(toAccount) === clean(row.debtAccount) ? { kind: "loan", debtDirection } : undefined,
    categoryName: row.category || "借入借出",
    categoryType: "transfer",
    institutionName: row.institution,
    note: compactNote(row.note, row.counterparty, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: `${EXPORT_SOURCE}_debt`,
    debtPrincipalAmount: Math.abs(money(row.principalAmount || row.cashAmount)),
    debtInterestAmount: nullableAmount(row.interestOrFeeReview, 2) == null ? null : Math.abs(money(row.interestOrFeeReview)),
  });
  stats.candidateRows += 1;
  if (!tx.toAccountId) warnings.push({ file: "mh8_debt_candidate_import.csv", id: clean(row.mh8TransID), reason: "missing debt transfer side" });
}

for (const row of readCsv("mh8_balance_adjustment_candidates.csv", true)) {
  addTransaction({
    seed: `balance:${sourceKey(row)}`,
    date: row.date,
    type: "transfer",
    amount: 0,
    accountName: row.account,
    categoryName: row.category || "余额调整",
    categoryType: "transfer",
    note: compactNote(row.note, `目标余额 ${amountString(money(row.targetBalance), 2)}`, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    toNote: encodeBalanceReconcileTarget(money(row.targetBalance)),
    source: "balance_reconcile",
  });
  stats.candidateRows += 1;
}

for (const row of readCsv("mh8_metal_candidate_import.csv", true)) {
  const action = clean(row.action);
  addCandidateCashFlow(row, {
    seedPrefix: "metal",
    type: "investment",
    direction: action === "sell" ? "inflow" : "outflow",
    fromAccount: action === "sell" ? row.metalAccount : (row.cashAccount || row.metalAccount),
    toAccount: action === "sell" ? row.cashAccount : row.metalAccount,
    fromShape: action === "sell" ? { kind: "investment", investProductType: "metal" } : undefined,
    toShape: action === "sell" ? undefined : { kind: "investment", investProductType: "metal" },
    amount: row.tradeAmount,
    categoryName: row.category || (action === "sell" ? "贵金属卖出" : "贵金属买入"),
    categoryType: "investment",
    sourceSuffix: "metal",
    extraNote: compactNote(row.metalType, row.unit, row.quantity),
    fundProductType: "metal",
    metalQuantity: nullableAmount(row.quantity, 6) == null ? null : Math.abs(money(row.quantity)),
    metalUnitPrice: nullableAmount(row.unitPrice, 6) == null ? null : money(row.unitPrice),
    metalUnitName: clean(row.unit) || null,
  });
}

for (const row of readCsv("mh8_property_candidate_import.csv", true)) {
  addCandidateCashFlow(row, {
    seedPrefix: "property",
    type: "investment",
    direction: "outflow",
    fromAccount: row.cashAccount || row.propertyAccount,
    toAccount: row.propertyAccount,
    toShape: { kind: "investment", investProductType: "property" },
    amount: row.amount,
    categoryName: row.category || "房产购入",
    categoryType: "investment",
    sourceSuffix: "property",
    extraNote: compactNote(row.propertyName, row.marketValue),
    fundProductType: "property",
  });
}

for (const row of readCsv("mh8_fx_conversion_candidates.csv", true)) {
  const fromAmount = Math.abs(money(row.fromAmount || row.amount || row["金额1"]));
  addTransaction({
    seed: `fx:${sourceKey(row)}`,
    date: row.date,
    type: "transfer",
    amount: -fromAmount,
    accountName: row.fromAccount || row.account || row["账户1"],
    toAccountName: row.toAccount || row.counterAccount || row["账户2"],
    categoryName: row.category || "货币兑换",
    categoryType: "transfer",
    note: compactNote(row.note, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: "fx_conversion",
  });
  stats.candidateRows += 1;
}

for (const row of readCsv("mh8_cash_transfer_review.csv", true)) {
  const fromAmount = Math.abs(money(row.fromAmount));
  addTransaction({
    seed: `cash-transfer:${sourceKey(row)}`,
    date: row.date,
    type: "transfer",
    amount: -fromAmount,
    accountName: row.fromAccount,
    toAccountName: row.toAccount,
    categoryName: row.category || "转账",
    categoryType: "transfer",
    note: compactNote(row.note, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: `${EXPORT_SOURCE}_cash_transfer_review`,
  });
  stats.candidateRows += 1;
}

for (const row of readCsv("mh8_interest_income_review.csv", true)) {
  addTransaction({
    seed: `interest:${sourceKey(row)}`,
    date: row.date,
    type: "income",
    amount: Math.abs(money(row.amount)),
    accountName: row.account,
    categoryName: row.category || "利息收入",
    categoryType: "income",
    institutionName: row.institution,
    note: compactNote(row.note, row.businessDomainGuess, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: `${EXPORT_SOURCE}_interest`,
  });
  stats.candidateRows += 1;
}

for (const row of readCsv("mh8_investment_fee_review.csv", true)) {
  addTransaction({
    seed: `investment-fee:${sourceKey(row)}`,
    date: row.date,
    type: "expense",
    amount: -Math.abs(money(row.amount || row.feeAmount)),
    accountName: row.account || row.cashAccount || row.fundAccount,
    categoryName: row.category || "投资费用",
    categoryType: "expense",
    institutionName: row.institution,
    note: compactNote(row.note, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: `${EXPORT_SOURCE}_investment_fee`,
  });
  stats.candidateRows += 1;
}

for (const row of readCsv("mh8_bill_missing_amount_review.csv", true)) {
  addTransaction({
    seed: `missing-amount:${sourceKey(row)}`,
    date: row.date,
    type: "expense",
    amount: 0,
    accountName: row.account,
    categoryName: row.category || "金额待补",
    categoryType: "expense",
    institutionName: row.institution,
    note: compactNote(row.note, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: `${EXPORT_SOURCE}_missing_amount_review`,
  });
  stats.candidateRows += 1;
}

for (const row of readCsv("mh8_holding_adjustment_review.csv", true)) {
  addTransaction({
    seed: `holding-adjustment:${sourceKey(row)}`,
    date: row.date,
    type: "investment",
    amount: 0,
    accountName: row.account,
    categoryName: row.category || "持仓调整复核",
    categoryType: "investment",
    note: compactNote(row.note, row.businessDomainGuess, `数量/成本 ${clean(row.quantityOrCost)}`, `市值/金额 ${clean(row.marketValueOrAmount)}`, `MH8:${clean(row.sourceFile)}#${clean(row.mh8TransID)}`),
    source: `${EXPORT_SOURCE}_holding_adjustment_review`,
  });
  stats.candidateRows += 1;
}

const accountBalances = new Map([...accounts.values()].map((account) => [account.id, 0]));
for (const tx of transactions) {
  const amount = Number(tx.amount || 0);
  accountBalances.set(tx.accountId, (accountBalances.get(tx.accountId) || 0) + amount);
  if (tx.toAccountId) {
    const incomingAmount = Math.abs(Number(tx.fundArrivalAmount || tx.amount || 0));
    accountBalances.set(tx.toAccountId, (accountBalances.get(tx.toAccountId) || 0) + incomingAmount);
  }
  if (tx.source === "balance_reconcile") {
    const target = clean(tx.toNote).match(/^balance_reconcile_target:([-0-9.]+)$/);
    if (target) accountBalances.set(tx.accountId, Number(target[1]));
  }
}
for (const account of accounts.values()) {
  account.balance = amountString(accountBalances.get(account.id) || 0, 2);
}

const data = {
  household: {
    id: HOUSEHOLD_ID,
    name: HOUSEHOLD_NAME,
    baseCurrency: "CNY",
    createdAt: nowIso,
    updatedAt: nowIso,
  },
  systemSettings: [],
  accessKeys: [],
  aiChannels: [],
  aiModels: [],
  users: [],
  userSettings: [],
  accountGroups: groups,
  institutions: [...institutions.values()],
  counterparties: [],
  categories: [...categories.values()],
  tags: [...tags.values()],
  insuranceProductMasters: [],
  wealthProducts: [],
  accounts: [...accounts.values()],
  accountAliases: [],
  billOverrides: [],
  creditCardCycles: [],
  creditCardInstallmentPlans: [],
  fundConfirmDays: [],
  fundFeeRates: [],
  fundHoldings: [],
  preciousMetalTypes: [],
  preciousMetalUnits: [],
  preciousMetalHoldings: [],
  loanRateAdjustments: [],
  fundQueryApis: [],
  statementRecognitionRules: [],
  statementCategoryRules: [],
  regularInvestPlans: [],
  importBatches: [{
    id: IMPORT_BATCH_ID,
    source: EXPORT_SOURCE,
    note: "Converted from MH8 CSV exports into an MMH restore package",
    rawText: null,
    householdId: HOUSEHOLD_ID,
    createdAt: nowIso,
  }],
  transactions,
  fxRates: [],
  fxConversions: [],
  insuranceProducts: [],
  fundTransactions,
  fundTransactionCashFlows,
  insuranceTransactions: [],
  wealthTransactions: [],
  depositTransactions: [],
  preciousMetalTransactions: [],
  stockSecurities: [],
  stockHoldings: [],
  stockTransactions: [],
  stockPriceCache: [],
  stockFeeRules: [],
  stockMarketFeeRules: [],
  propertyAssets: [],
  propertyValuations: [],
  propertyTransactions: [],
  entryBusinessLinks,
  attachments: [],
  entryTags,
  emailAccounts: [],
};

const exportedAt = new Date();
const payload = {
  app: "MMH",
  formatVersion: BACKUP_FORMAT_VERSION,
  exportedAt,
  exportedBy: null,
  scope: {
    householdId: HOUSEHOLD_ID,
    householdName: HOUSEHOLD_NAME,
    backupScope: "household",
  },
  counts: {
    users: data.users.length,
    accounts: data.accounts.length,
    transactions: data.transactions.length,
    statementRecognitionRules: data.statementRecognitionRules.length,
    categories: data.categories.length,
    tags: data.tags.length,
    institutions: data.institutions.length,
    counterparties: data.counterparties.length,
    emailAccounts: data.emailAccounts.length,
    regularInvestPlans: data.regularInvestPlans.length,
    businessTransactions: data.fundTransactions.length,
    systemSettings: data.systemSettings.length,
    accessKeys: data.accessKeys.length,
    aiChannels: data.aiChannels.length,
    aiModels: data.aiModels.length,
  },
  data,
};

function assertUnique(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (!item.id) throw new Error(`${label} has missing id`);
    if (seen.has(item.id)) throw new Error(`${label} has duplicate id: ${item.id}`);
    seen.add(item.id);
  }
}

assertUnique(data.accounts, "accounts");
assertUnique(data.categories, "categories");
assertUnique(data.institutions, "institutions");
assertUnique(data.transactions, "transactions");
assertUnique(data.fundTransactions, "fundTransactions");
assertUnique(data.fundTransactionCashFlows, "fundTransactionCashFlows");
assertUnique(data.entryBusinessLinks, "entryBusinessLinks");
for (const tx of data.transactions) {
  if (!accountBalances.has(tx.accountId)) throw new Error(`Transaction ${tx.id} references missing accountId`);
  if (tx.toAccountId && !accountBalances.has(tx.toAccountId)) throw new Error(`Transaction ${tx.id} references missing toAccountId`);
}
for (const fundTx of data.fundTransactions) {
  if (!accountBalances.has(fundTx.fundAccountId)) throw new Error(`Fund transaction ${fundTx.id} references missing fund account`);
  if (fundTx.cashAccountId && !accountBalances.has(fundTx.cashAccountId)) throw new Error(`Fund transaction ${fundTx.id} references missing cash account`);
}

const pkg = encryptPayload(payload, PASSPHRASE);
const decrypted = decryptPackage(pkg, PASSPHRASE);
if (decrypted.app !== "MMH" || decrypted.formatVersion !== BACKUP_FORMAT_VERSION) {
  throw new Error("Encrypted package validation failed");
}

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

const summary = {
  generatedAt: nowIso,
  inputDir: INPUT_DIR,
  outputFile: OUTPUT_FILE,
  backupPassphrase: PASSPHRASE,
  packageBytes: fs.statSync(OUTPUT_FILE).size,
  sourceRows: {
    ordinaryBillRows: billRows.length,
    fundImportRows: fundRows.length,
  },
  converted: {
    accounts: data.accounts.length,
    accountGroups: data.accountGroups.length,
    categories: data.categories.length,
    institutions: data.institutions.length,
    tags: data.tags.length,
    transactions: data.transactions.length,
    fundTransactions: data.fundTransactions.length,
    fundTransactionCashFlows: data.fundTransactionCashFlows.length,
    entryBusinessLinks: data.entryBusinessLinks.length,
    entryTags: data.entryTags.length,
    zeroAmountReviewRows: stats.zeroAmountReviewRows,
    fundReviewRowsAsFundTransactions: stats.fundReviewRowsAsFundTransactions,
    fundRowsWithoutCode: stats.fundRowsWithoutCode,
    candidateRows: stats.candidateRows,
  },
  fundReviewRowsBySourceFile: Object.fromEntries([...fundReviewRowsBySourceFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  warnings,
};
fs.writeFileSync(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify(summary, null, 2));
