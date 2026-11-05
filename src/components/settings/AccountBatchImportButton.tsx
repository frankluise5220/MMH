"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { createPortal } from "react-dom";
import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Download, FileUp, X } from "lucide-react";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { normalizeCurrency } from "@/lib/currency";
import { parseFlexibleDateToYmd } from "@/lib/date-utils";
import { PRODUCT_TYPES } from "@/lib/investment-config";
import { FIXED_ASSET_TYPES } from "@/lib/fixed-asset";
import { TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { LOAN_TYPES } from "@/lib/loan-type";
import { allowedInstitutionTypesForAccount } from "@/lib/account-institution-rules";
import { supportsMultiCurrencyHierarchy } from "@/lib/account-kind-utils";
import { COUNTERPARTY_TYPE_OPTIONS, institutionTypeLabel, institutionTypeOptions } from "@/lib/account-kinds";
import { useI18n } from "@/lib/i18n";
import { TAG_COLORS, TAG_COLOR_NAME_KEYS } from "@/lib/tag-colors";
import { isCreditCardMonthEndBillingDay } from "@/lib/credit/rules";

/**
 * 基本资料批量导入的字段全集。
 *
 * 结构对齐当前库表（2026-11 版）：
 * - 家庭成员就是 `Institution.type = "family_member"`，不再写 AccountGroup；
 * - 往来对象 `Counterparty` 有 `type`（person/organization/merchant）、`isReimbursable`、`sourceInstitutionId`；
 * - 账户字段覆盖 `AccountKind` 全部种类（cash/bank_debit/bank_credit/ewallet/deposit/investment/
 *   insurance/settlement/loan/other）+ 多币种父子（parent/level/currency）+ 信用卡（billingDay/
 *   repaymentDay/repaymentOffsetDays/billingDayTxPeriod/creditLimit/creditBillMode）+ 投资（份额位数/
 *   成本法/交易日历/确认天数/到账天数）+ 贷款（类别/口径/消费贷/应收应付）。
 */
type AccountBatchImportField =
  | "name"
  | "shortName"
  | "color"
  | "kind"
  | "institutionType"
  | "counterpartyType"
  | "categoryType"
  | "parentCategory"
  | "loanCategory"
  | "loanType"
  | "isConsumerLoan"
  | "liabilityDirection"
  | "isReimbursable"
  | "sourceInstitution"
  | "investProductType"
  | "fixedAssetType"
  | "institution"
  | "counterparty"
  | "owner"
  | "currency"
  | "parent"
  | "level"
  | "numberMasked"
  | "billingDay"
  | "repaymentDay"
  | "repaymentOffsetDays"
  | "billingDayTxPeriod"
  | "creditLimit"
  | "creditBillMode"
  | "fundUnitsDecimals"
  | "costBasisMethod"
  | "tradingCalendar"
  | "defaultConfirmDays"
  | "defaultArrivalDays"
  | "initialBalance"
  | "initialBalanceDate"
  | "note"
  | "sample";

type ImportTarget = "institution" | "familyMember" | "counterparty" | "category" | "tag" | "account";
/** 新结构：8 张数据 sheet，账户按「资金/投资/负债」三大类聚合，具体种类由「账户类型」列区分。 */
type ImportSheetType =
  | "institution"
  | "familyMember"
  | "counterparty"
  | "category"
  | "tag"
  | "funding"
  | "investment"
  | "liability"
  /** 旧模板的「家庭及往来对象」合表，只用于读旧文件。 */
  | "object";

type ImportAccountRow = {
  key: string;
  sheetType: ImportSheetType;
  sheet: string;
  sourceRow: number;
  target: ImportTarget;
  name: string;
  color: string;
  kind: string;
  institutionType: string;
  counterpartyType: string;
  categoryType: string;
  parentCategoryName: string;
  parentCategoryId: string;
  loanCategory: string;
  /** 贷款口径（home/mortgage/consumer/other），由贷款类别派生，仅贷款行使用。 */
  loanType: string;
  isConsumerLoan: boolean;
  /** 往来款方向（payable 应付 / receivable 应收）。 */
  liabilityDirection: string;
  /** 往来对象是否可开具报销单（only yes 才置 true）。 */
  isReimbursable: boolean;
  /** 往来对象的来源机构名称（财智对向账户导入那一列）。 */
  sourceInstitutionName: string;
  shortName: string;
  investProductType: string;
  fixedAssetType: string;
  institutionName: string;
  institutionId: string;
  counterpartyName: string;
  counterpartyId: string;
  ownerName: string;
  ownerId: string;
  currency: string;
  /** 账户级别：父账户自身不记账、余额由子户折算汇总，可以没有子户。 */
  accountLevel: "normal" | "aggregate";
  /** 多币种子户：父账户名称（只允许填已存在的多币种父账户）。 */
  parentName: string;
  parentAccountId: string;
  numberMasked: string;
  billingDay: string;
  repaymentDay: string;
  /** 还款日按「账单日 + N 天」推算时的偏移天数（与 repaymentDay 二选一）。 */
  repaymentOffsetDays: string;
  /** 账单日当天的交易算本期还是下期（current / next）。 */
  billingDayTxPeriod: string;
  creditLimit: string;
  creditBillMode: string;
  fundUnitsDecimals: string;
  costBasisMethod: string;
  tradingCalendar: string;
  defaultConfirmDays: string;
  defaultArrivalDays: string;
  initialBalance: string;
  initialBalanceDate: string;
  note: string;
  errors: string[];
  selected: boolean;
  /** Set once the user manually toggles this row's checkbox; re-validation then keeps their choice. */
  touchedSelection?: boolean;
};

type ImportResult = {
  created: number;
  errors: Array<{ key: string; sheet: string; sourceRow: number; name: string; message: string }>;
};

type AccountBatchImportButtonProps = {
  groups: Array<{ id: string; name: string }>;
  institutions: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
  counterparties: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
  baseCurrency: string;
  onImported: () => void;
  /** 紧凑模式：按钮高 28px（`--ft-tab-filter-h`），用于挂在 FT 页签条右端。 */
  compact?: boolean;
  /** 按钮 tooltip。基本资料页用来说明「这是整套基础资料模板的导出/导入」，不传则不加 title。 */
  exportTemplateTitle?: string;
  importExcelTitle?: string;
};

type Translate = (key: string, params?: Record<string, string | number>) => string;
type AccountImportOption = { value: string; labelKey: string };

type ImportSheetDefinition = {
  type: ImportSheetType;
  sheetKey: string;
  target: ImportTarget;
  fields: AccountBatchImportField[];
  defaultKind?: string;
  /**
   * 旧模板（2026-10-27 下线版）的 sheet 名。新模板不再生成这些 sheet，但用户手上
   * 的旧文件仍要能导入，所以按别名把它们归并到新 sheet 上解析。
   * 别名可以覆盖 `defaultKind`：旧「信用卡」「固定资产」sheet 没有「账户类型」列，
   * 只能靠 sheet 名定种类。不覆盖时沿用所属新 sheet 的定义。
   */
  sheetAliases?: Array<{ sheetKey: string; defaultKind?: string; legacyKindByCounterparty?: boolean }>;
  /**
   * 旧「往来款账户」sheet 没有「账户类型」列：填了往来对象的是往来款，否则是贷款。
   */
  legacyKindByCounterparty?: boolean;
};

type ExistingCategory = { id: string; name: string; type: string; parentId: string | null };
type ExistingAccountRef = {
  id: string;
  name: string;
  kind: string;
  currency?: string | null;
  parentId?: string | null;
  isAggregate?: boolean;
};
type SheetGuideRowOptions = { firstValueOwnRow?: boolean };
type SheetGuideRow = [AccountBatchImportField, string, string, SheetGuideRowOptions?];
type GuideSwatch = { rgb: string; name?: string };

const REQUIRED_FIELDS_BY_SHEET: Record<ImportSheetType, AccountBatchImportField[]> = {
  institution: ["name", "institutionType"],
  object: ["name", "counterpartyType"],
  familyMember: ["name"],
  counterparty: ["name", "counterpartyType"],
  category: ["name", "categoryType"],
  tag: ["name"],
  funding: ["name", "kind", "owner"],
  investment: ["name", "investProductType", "owner"],
  liability: ["name", "kind", "owner"],
};

const HEADER_ALIASES: Record<AccountBatchImportField, string[]> = {
  name: ["name", "account", "accountName", "categoryName", "tagName"],
  color: ["color", "tagColor"],
  kind: ["kind", "accountKind", "type"],
  institutionType: ["institutionType", "type"],
  counterpartyType: ["counterpartyType", "type"],
  categoryType: ["categoryType", "type"],
  parentCategory: ["parentCategory", "parent", "parentName"],
  loanCategory: ["loanCategory", "loanCategoryName", "loanType"],
  loanType: ["loanType", "loanKind", "loanBaseType"],
  isConsumerLoan: ["isConsumerLoan", "consumerLoan"],
  liabilityDirection: ["liabilityDirection", "direction", "payableOrReceivable"],
  isReimbursable: ["isReimbursable", "reimbursable"],
  sourceInstitution: ["sourceInstitution", "sourceInstitutionName", "source"],
  shortName: ["shortName"],
  investProductType: ["investProductType", "productType", "accountSubtype"],
  fixedAssetType: ["fixedAssetType", "assetType"],
  institution: ["institution", "institutionName"],
  counterparty: ["counterparty", "counterpartyName"],
  owner: ["owner", "ownerName", "groupId", "group"],
  currency: ["currency"],
  parent: ["parent", "parentAccount", "parentAccountName", "parentName", "aggregateParent"],
  level: ["level", "accountLevel", "hierarchy", "accountHierarchy", "isAggregate"],
  numberMasked: ["numberMasked", "last4", "cardLast4"],
  billingDay: ["billingDay", "statementDay"],
  repaymentDay: ["repaymentDay", "dueDay"],
  repaymentOffsetDays: ["repaymentOffsetDays", "repaymentOffset"],
  billingDayTxPeriod: ["billingDayTxPeriod", "billingDayTransactionPeriod"],
  creditLimit: ["creditLimit", "limit"],
  creditBillMode: ["creditBillMode", "billMode"],
  fundUnitsDecimals: ["fundUnitsDecimals", "unitDecimals"],
  costBasisMethod: ["costBasisMethod"],
  tradingCalendar: ["tradingCalendar"],
  defaultConfirmDays: ["defaultConfirmDays", "confirmDays"],
  defaultArrivalDays: ["defaultArrivalDays", "arrivalDays"],
  initialBalance: ["initialBalance", "openingBalance"],
  initialBalanceDate: ["initialBalanceDate", "openingBalanceDate"],
  note: ["note", "remark"],
  sample: ["sample", "sampleRow"],
};

export const HEADER_LABELS: Record<AccountBatchImportField, (t: (key: string) => string) => string> = {
  name: (t) => t("settings.accounts.name"),
  color: (t) => t("settings.tags.color"),
  kind: (t) => t("settings.accounts.type"),
  institutionType: (t) => t("settings.accounts.import.institutionType"),
  counterpartyType: (t) => t("settings.accounts.type"),
  categoryType: (t) => t("settings.accounts.import.categoryType"),
  parentCategory: (t) => t("settings.accounts.import.parentCategory"),
  loanCategory: (t) => t("settings.accounts.loanCategory"),
  loanType: (t) => t("settings.accounts.loanType"),
  isConsumerLoan: (t) => t("settings.accounts.import.isConsumerLoan"),
  liabilityDirection: (t) => t("settings.accounts.import.liabilityDirection"),
  isReimbursable: (t) => t("settings.accounts.import.isReimbursable"),
  sourceInstitution: (t) => t("settings.accounts.import.sourceInstitution"),
  shortName: (t) => t("settings.accounts.import.shortName"),
  investProductType: (t) => t("settings.accounts.investmentAccountType"),
  fixedAssetType: (t) => t("fixedAssetEdit.assetType"),
  institution: (t) => t("settings.accounts.institution"),
  counterparty: (t) => t("txForm.counterparty"),
  owner: (t) => t("settings.accounts.owner"),
  currency: (t) => t("settings.accounts.currency"),
  parent: (t) => t("settings.accounts.parentAccount"),
  level: (t) => t("settings.accounts.import.accountLevel"),
  numberMasked: (t) => t("settings.accounts.lastFourLabel"),
  billingDay: (t) => t("settings.accounts.billingDayLabel"),
  repaymentDay: (t) => t("settings.accounts.repaymentDayLabel"),
  repaymentOffsetDays: (t) => t("settings.accounts.import.repaymentOffsetDays"),
  billingDayTxPeriod: (t) => t("settings.accounts.import.billingDayTxPeriod"),
  creditLimit: (t) => t("settings.accounts.creditLimitLabel"),
  creditBillMode: (t) => t("entityForm.creditBillModeLabel"),
  fundUnitsDecimals: (t) => t("settings.accounts.fundUnitsDecimals"),
  costBasisMethod: (t) => t("settings.accounts.costBasisMethod"),
  tradingCalendar: (t) => t("settings.accounts.tradingCalendar"),
  defaultConfirmDays: (t) => t("settings.accounts.import.defaultConfirmDays"),
  defaultArrivalDays: (t) => t("settings.accounts.import.defaultArrivalDays"),
  initialBalance: (t) => t("detail.column.balance"),
  initialBalanceDate: (t) => t("settings.accounts.import.initialBalanceDate"),
  note: (t) => t("settings.accounts.note"),
  sample: (t) => t("settings.accounts.import.sampleRow"),
};

/**
 * 新模板结构（2026-11）：8 张数据 sheet。
 *
 * 相对旧模板（2026-10-27 下线版）的调整：
 * - 「家庭及往来对象」拆成「家庭成员」（Institution.type=family_member）与「往来对象」（Counterparty）；
 * - 「资金账户」与「信用卡」合成一张「资金账户及信用卡」，种类由「账户类型」列区分
 *   （现金/借记卡/电子钱包/信用卡/存款/保险/其他）；
 * - 「往来款账户」与贷款合并为「贷款与往来款」，用「账户类型」区分贷款/往来款；
 * - 固定资产并入「投资账户」（投资品类=固定资产 + 资产类型），不再有独立的 fixed_asset kind；
 * - 补齐新字段：账单日交易归属、还款日偏移、贷款口径/消费贷、应收应付方向、可报销、
 *   来源机构、确认天数、到账天数。
 */
export const SHEETS: ImportSheetDefinition[] = [
  {
    type: "institution",
    sheetKey: "settings.accounts.import.sheet.institution",
    target: "institution",
    fields: ["name", "shortName", "institutionType", "note", "sample"],
  },
  {
    type: "familyMember",
    sheetKey: "settings.accounts.import.sheet.familyMember",
    target: "familyMember",
    fields: ["name", "shortName", "note", "sample"],
  },
  {
    type: "counterparty",
    sheetKey: "settings.accounts.import.sheet.counterparty",
    target: "counterparty",
    fields: ["name", "shortName", "counterpartyType", "isReimbursable", "sourceInstitution", "note", "sample"],
  },
  {
    type: "category",
    sheetKey: "settings.accounts.import.sheet.category",
    target: "category",
    fields: ["name", "categoryType", "parentCategory", "note"],
  },
  {
    type: "tag",
    sheetKey: "settings.accounts.import.sheet.tag",
    target: "tag",
    fields: ["name", "color", "sample"],
  },
  {
    type: "funding",
    sheetKey: "settings.accounts.import.sheet.funding",
    target: "account",
    // 资金账户 + 信用卡合表：信用卡行靠 kind=bank_credit 启用账单相关列。
    fields: [
      "name", "kind", "institution", "owner", "currency", "parent", "level", "numberMasked",
      "billingDay", "repaymentDay", "repaymentOffsetDays", "billingDayTxPeriod",
      "creditLimit", "creditBillMode", "initialBalance", "initialBalanceDate", "note", "sample",
    ],
    sheetAliases: [
      { sheetKey: "settings.accounts.import.sheet.fundingCredit" },
      // 旧「信用卡」sheet 没有「账户类型」列，整张表都是信用卡。
      { sheetKey: "settings.accounts.import.sheet.credit", defaultKind: "bank_credit" },
    ],
  },
  {
    type: "investment",
    sheetKey: "settings.accounts.import.sheet.investment",
    target: "account",
    defaultKind: "investment",
    fields: [
      "name", "investProductType", "fixedAssetType", "institution", "owner", "currency",
      "fundUnitsDecimals", "costBasisMethod", "tradingCalendar",
      "defaultConfirmDays", "defaultArrivalDays", "note", "sample",
    ],
    // 旧版「固定资产」sheet：kind 记为 fixed_asset，解析时归一到 investment + property。
    sheetAliases: [{ sheetKey: "settings.accounts.import.sheet.fixedAsset", defaultKind: "fixed_asset" }],
  },
  {
    type: "liability",
    sheetKey: "settings.accounts.import.sheet.liability",
    target: "account",
    defaultKind: "loan",
    fields: [
      "name", "kind", "institution", "counterparty", "loanCategory", "loanType", "isConsumerLoan",
      "liabilityDirection", "owner", "currency", "initialBalance", "initialBalanceDate", "note", "sample",
    ],
    sheetAliases: [
      // 旧「往来款账户」sheet 没有「账户类型」列，按是否填往来对象区分往来款/贷款。
      { sheetKey: "settings.accounts.import.sheet.settlement", legacyKindByCounterparty: true },
    ],
  },
];

/**
 * 旧模板的「家庭及往来对象」sheet 把家庭成员和往来对象混在一起（type 列区分），
 * 新模板已拆分，但旧文件仍按行分派：family_member 走 Institution，其余走 Counterparty。
 */
const LEGACY_IMPORT_SHEETS: ImportSheetDefinition[] = [
  {
    type: "object",
    sheetKey: "settings.accounts.import.sheet.object",
    target: "familyMember",
    fields: ["name", "counterpartyType", "shortName", "note", "sample"],
  },
];

const IMPORT_SHEETS = [...SHEETS, ...LEGACY_IMPORT_SHEETS];

/**
 * sheet 名 → 定义。旧模板的 sheet 名通过 sheetAliases 指向新 sheet，
 * 保证「往来款账户 / 信用卡 / 固定资产 / 家庭及往来对象」这些旧表还能导入并出列。
 */
function buildSheetDefinitionsByName(t: Translate) {
  const map = new Map<string, ImportSheetDefinition>();
  for (const definition of IMPORT_SHEETS) {
    map.set(normalizeImportHeader(t(definition.sheetKey)), definition);
    for (const alias of definition.sheetAliases ?? []) {
      // 别名只在种类/分派口径上与新 sheet 不同，列定义仍共用同一份。
      map.set(normalizeImportHeader(t(alias.sheetKey)), {
        ...definition,
        defaultKind: alias.defaultKind ?? definition.defaultKind,
        legacyKindByCounterparty: alias.legacyKindByCounterparty ?? definition.legacyKindByCounterparty,
      });
    }
  }
  return map;
}

// 「机构」sheet 允许全部机构类型（含 lend 的往来款机构、person/organization），
// 家庭成员与往来对象另有独立 sheet，但旧文件里若把类型写在机构表也能识别。
const INSTITUTION_TYPE_OPTIONS: AccountImportOption[] = institutionTypeOptions();
const FUNDING_ACCOUNT_KIND_OPTIONS: AccountImportOption[] = [
  { value: "cash", labelKey: "account.kind.cash" },
  { value: "bank_debit", labelKey: "account.kind.bank_debit" },
  { value: "ewallet", labelKey: "account.kind.ewallet" },
  { value: "bank_credit", labelKey: "account.kind.bank_credit" },
  { value: "deposit", labelKey: "account.kind.deposit" },
  { value: "insurance", labelKey: "account.kind.insurance" },
  { value: "other", labelKey: "account.kind.other" },
];
/** 「贷款与往来款」sheet 的账户类型。 */
const LIABILITY_KIND_OPTIONS: AccountImportOption[] = [
  { value: "loan", labelKey: "account.kind.loan" },
  { value: "settlement", labelKey: "account.kind.settlement" },
];
const LOAN_TYPE_OPTIONS: AccountImportOption[] = LOAN_TYPES.map((value) => ({ value, labelKey: `loan.type.${value}` }));
/** 往来款方向：应付（我欠对方）/ 应收（对方欠我）。 */
const LIABILITY_DIRECTION_OPTIONS: AccountImportOption[] = [
  { value: "payable", labelKey: "settings.accounts.import.directionPayable" },
  { value: "receivable", labelKey: "settings.accounts.import.directionReceivable" },
];
const BOOLEAN_SELECT_OPTIONS: AccountImportOption[] = [
  { value: "yes", labelKey: "settings.accounts.import.yes" },
  { value: "no", labelKey: "settings.accounts.import.no" },
];
/** 账单日当天交易的归属：本期 / 下期。 */
const BILLING_DAY_TX_PERIOD_OPTIONS: AccountImportOption[] = [
  { value: "current", labelKey: "settings.accounts.import.txPeriodCurrent" },
  { value: "next", labelKey: "settings.accounts.import.txPeriodNext" },
];
// 投资账户含固定资产（property）与存款类（deposit）品类，不再单独拆 sheet。
const INVEST_PRODUCT_OPTIONS: AccountImportOption[] = PRODUCT_TYPES.map((value) => ({ value, labelKey: `investment.product.${value}` }));
const FIXED_ASSET_TYPE_OPTIONS: AccountImportOption[] = FIXED_ASSET_TYPES.map((value) => ({ value, labelKey: `fixedAsset.type.${value}` }));
const COST_BASIS_OPTIONS: AccountImportOption[] = [
  { value: "moving_avg", labelKey: "settings.accounts.movingAverage" },
  { value: "fifo", labelKey: "settings.accounts.fifo" },
  { value: "lifo", labelKey: "settings.accounts.lifo" },
];
const TRADING_CALENDAR_OPTIONS: AccountImportOption[] = TRADING_CALENDARS.map((value) => ({ value, labelKey: `tradingCalendar.${value}` }));
const TAG_COLOR_OPTIONS: AccountImportOption[] = TAG_COLORS.map((value) => ({ value, labelKey: TAG_COLOR_NAME_KEYS[value] }));
const CREDIT_BILL_MODE_OPTIONS: AccountImportOption[] = [
  { value: "separate", labelKey: "entityForm.creditBillMode.separate" },
  { value: "consolidated", labelKey: "entityForm.creditBillMode.consolidated" },
];
const OBJECT_TYPE_OPTIONS: AccountImportOption[] = institutionTypeOptions(["family_member", "person", "organization"]);
const CATEGORY_TYPE_OPTIONS: AccountImportOption[] = [
  { value: "expense", labelKey: "transaction.type.expense" },
  { value: "income", labelKey: "transaction.type.income" },
];
const MASTER_TARGETS: ImportTarget[] = ["institution", "familyMember", "counterparty", "category", "tag"];
const ACCOUNT_INSTITUTION_ENTITY_TYPES = new Set(["family_member", "person", "organization", "lender"]);
const GUIDE_NOTE_COLUMN_START = 2;
const GUIDE_NOTE_COLUMN_SPAN = 5;
const GUIDE_NOTE_COLUMN_END = GUIDE_NOTE_COLUMN_START + GUIDE_NOTE_COLUMN_SPAN - 1;
const GUIDE_COLUMN_COUNT = GUIDE_NOTE_COLUMN_END + 1;
const GUIDE_NOTICE_ROW_HEIGHT = 42;
const GENERIC_TYPE_FIELDS = new Set<AccountBatchImportField>([
  "institutionType",
  "counterpartyType",
  "categoryType",
  "investProductType",
  "fixedAssetType",
]);
const HEADER_LABEL_ALIAS_KEYS: Partial<Record<AccountBatchImportField, string[]>> = {
  counterpartyType: ["settings.accounts.import.counterpartyType"],
};

function categoryTypeLabel(value: string, t: (key: string) => string) {
  const option = CATEGORY_TYPE_OPTIONS.find((item) => item.value === value);
  return option ? t(option.labelKey) : value;
}

function normalizeImportHeader(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// The exported guide title cell holds the title plus an explanatory note in one
// wrapped cell, so match on the leading title text instead of the full cell.
function isGuideTitleCell(value: unknown, guideTitle: string) {
  return normalizeImportHeader(value).startsWith(guideTitle);
}

function normalizeImportCell(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value ?? "").trim();
}

function parseImportNumber(value: string) {
  const raw = normalizeImportCell(value).replace(/,/g, "");
  if (!raw) return "";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function parseImportDate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return parseFlexibleDateToYmd(value) ?? "";
}

function parseImportEnum(value: string, options: AccountImportOption[], t: (key: string) => string) {
  const raw = normalizeImportHeader(value);
  if (!raw) return "";
  const byCode = options.find((option) => option.value.toLowerCase() === raw);
  if (byCode) return byCode.value;
  const byLabel = options.find((option) =>
    normalizeImportHeader(t(option.labelKey)) === raw ||
    normalizeImportHeader(`${t(option.labelKey)}(${option.value})`) === raw ||
    normalizeImportHeader(`${t(option.labelKey)}（${option.value}）`) === raw
  );
  return byLabel?.value ?? "";
}

/** 「是/否」「yes/no」「1/0」→ 布尔；空返回 null（表示未填，不覆盖默认值）。 */
function parseImportBoolean(value: string): boolean | null {
  const raw = normalizeImportHeader(value);
  if (!raw) return null;
  if (["yes", "y", "true", "1", "是", "√", "✓", "可", "有"].includes(raw)) return true;
  if (["no", "n", "false", "0", "否", "×", "x", "不可", "无"].includes(raw)) return false;
  return null;
}

function parseImportTagColor(value: string) {
  const raw = normalizeImportCell(value).replace(/^#/, "").toUpperCase();
  if (!raw) return "";
  return TAG_COLORS.find((color) => color.replace("#", "").toUpperCase() === raw) ?? "";
}

/** Text color for swatch cells: dark text on light fills, white text on dark fills. */
function isLightSwatchColor(rgb: string) {
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function isRequiredField(sheetType: ImportSheetType, field: AccountBatchImportField) {
  return REQUIRED_FIELDS_BY_SHEET[sheetType].includes(field);
}

function isTemplateSampleRow(value: string, t: (key: string) => string) {
  const normalized = normalizeImportHeader(value);
  if (!normalized) return false;
  return normalized === normalizeImportHeader(t("settings.accounts.import.sampleRowYes")) ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "sample";
}

function requiredFieldError(
  field: AccountBatchImportField,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  return t("settings.accounts.import.requiredFieldMissing", { field: HEADER_LABELS[field](t) });
}

function resolveNamedOption(
  value: string,
  options: Array<{ id: string; name: string; shortName?: string | null }>,
) {
  const raw = value.trim();
  if (!raw) return { id: "", error: "" };
  const normalized = raw.toLowerCase();
  const exact = options.find((option) =>
    option.name.trim().toLowerCase() === normalized ||
    (option.shortName?.trim().toLowerCase() ?? "") === normalized
  );
  if (exact) return { id: exact.id, error: "" };
  const partial = options.filter((option) =>
    option.name.trim().toLowerCase().includes(normalized) ||
    normalized.includes(option.name.trim().toLowerCase()) ||
    (option.shortName?.trim().toLowerCase().includes(normalized) ?? false)
  );
  if (partial.length === 1) return { id: partial[0].id, error: "" };
  if (partial.length > 1) return { id: "", error: "multiple matches" };
  return { id: "", error: "not found" };
}

function matchesPendingName(value: string, rows: ImportAccountRow[], target: ImportTarget) {
  const normalized = normalizeImportHeader(value);
  if (!normalized) return false;
  // Only rows the user has explicitly checked can claim a name slot and serve as a
  // reference for later rows. This mirrors the wizard's "only checked rows are imported"
  // semantics: if row A is checked, rows that follow can reference A; if A is not
  // checked, A's claim does not block subsequent rows from using the same name.
  return rows.some((row) =>
    row.target === target &&
    row.name &&
    row.selected &&
    (normalizeImportHeader(row.name) === normalized || normalizeImportHeader(row.shortName) === normalized)
  );
}

function pendingRowByName(value: string, rows: ImportAccountRow[], target: ImportTarget) {
  const normalized = normalizeImportHeader(value);
  if (!normalized) return null;
  return rows.find((row) =>
    row.target === target &&
    row.name &&
    row.selected &&
    (normalizeImportHeader(row.name) === normalized || normalizeImportHeader(row.shortName) === normalized)
  ) ?? null;
}

function existingRowMatchesName(value: string, rows: Array<{ id: string; name: string; shortName?: string | null }>) {
  const normalized = normalizeImportHeader(value);
  if (!normalized) return false;
  return rows.some((row) =>
    normalizeImportHeader(row.name) === normalized ||
    normalizeImportHeader(row.shortName) === normalized
  );
}

function requiresInstitution(row: Pick<ImportAccountRow, "sheetType" | "kind" | "investProductType" | "counterpartyName">) {
  if (row.sheetType === "funding") return row.kind !== "cash";
  // 固定资产（investment + property）不挂机构。
  if (row.sheetType === "investment") return row.investProductType !== "property";
  // 往来款账户挂在往来对象上，贷款挂在机构上。
  if (row.sheetType === "liability") return row.kind === "loan";
  return false;
}

function requiresOwner(row: Pick<ImportAccountRow, "sheetType">) {
  return row.sheetType === "funding" || row.sheetType === "liability" || row.sheetType === "investment";
}

function isAccountInstitutionEntityType(type: string | null | undefined) {
  return ACCOUNT_INSTITUTION_ENTITY_TYPES.has(type ?? "");
}

function buildImportHeaders(fields: AccountBatchImportField[], t: (key: string) => string) {
  return fields.map((field) => ({
    field,
    aliases: [
      ...HEADER_ALIASES[field],
      ...(GENERIC_TYPE_FIELDS.has(field) ? [t("settings.accounts.type")] : []),
      ...(HEADER_LABEL_ALIAS_KEYS[field] ?? []).map((key) => t(key)),
      HEADER_LABELS[field](t),
    ],
  }));
}

function findHeaderIndex(rows: unknown[][], fields: AccountBatchImportField[], t: (key: string) => string) {
  const importHeaders = buildImportHeaders(fields, t);
  return rows.findIndex((row) => {
    const headerCount = importHeaders.filter((header) =>
      row.some((cell) => header.aliases.some((alias) => normalizeImportHeader(alias) === normalizeImportHeader(cell))),
    ).length;
    return headerCount >= Math.min(2, fields.length);
  });
}

function buildFieldIndex(headerRow: unknown[], fields: AccountBatchImportField[], t: (key: string) => string) {
  const normalizedHeaderRow = headerRow.map(normalizeImportHeader);
  const fieldIndex = new Map<AccountBatchImportField, number>();
  for (const header of buildImportHeaders(fields, t)) {
    const index = normalizedHeaderRow.findIndex((cell) => header.aliases.some((alias) => normalizeImportHeader(alias) === cell));
    if (index >= 0) fieldIndex.set(header.field, index);
  }
  return fieldIndex;
}

function parseSheetRows(
  sheetName: string,
  definition: ImportSheetDefinition,
  rows: unknown[][],
  t: (key: string, params?: Record<string, string | number>) => string,
  baseCurrency: string,
) {
  const headerIndex = findHeaderIndex(rows, definition.fields, t);
  if (headerIndex < 0) return [];
  const fieldIndex = buildFieldIndex(rows[headerIndex], definition.fields, t);
  if (!fieldIndex.has("name")) return [];

  const bodyRows = rows.slice(headerIndex + 1);
  const guideTitle = normalizeImportHeader(t("settings.accounts.import.sheetGuideTitle"));
  const guideOffset = bodyRows.findIndex((row) => row.some((cell) => isGuideTitleCell(cell, guideTitle)));
  const importRows = guideOffset >= 0 ? bodyRows.slice(0, guideOffset) : bodyRows;

  return importRows.flatMap((source, offset): ImportAccountRow[] => {
    const sourceRow = headerIndex + offset + 2;
    const valueAt = (field: AccountBatchImportField) => {
      const index = fieldIndex.get(field);
      return normalizeImportCell(index == null ? "" : source[index]);
    };
    const errors: string[] = [];
    const rawName = valueAt("name");
    if (isTemplateSampleRow(valueAt("sample"), t)) return [];
    const rowHasData = definition.fields.some((field) => field !== "sample" && valueAt(field));
    if (!rowHasData) return [];
    if (!rawName) errors.push(requiredFieldError("name", t));

    const rawInstitutionType = valueAt("institutionType");
    const parsedInstitutionType = parseImportEnum(rawInstitutionType, INSTITUTION_TYPE_OPTIONS, t);
    const institutionType = definition.target === "institution" ? parsedInstitutionType : "";
    if (definition.target === "institution") {
      if (!rawInstitutionType) errors.push(requiredFieldError("institutionType", t));
      else if (!parsedInstitutionType) errors.push(t("settings.accounts.import.invalidEnum"));
    }

    const rawCounterpartyType = valueAt("counterpartyType");
    const counterpartyTypeOptions = definition.type === "object" ? OBJECT_TYPE_OPTIONS : COUNTERPARTY_TYPE_OPTIONS;
    const parsedCounterpartyType = parseImportEnum(rawCounterpartyType, counterpartyTypeOptions, t);
    const counterpartyType = definition.type === "counterparty" || definition.type === "object" ? parsedCounterpartyType : "";
    const target: ImportTarget = definition.type === "object"
      ? parsedCounterpartyType === "family_member" ? "familyMember" : "counterparty"
      : definition.target;
    if (definition.type === "counterparty" || definition.type === "object") {
      if (!rawCounterpartyType) errors.push(requiredFieldError("counterpartyType", t));
      else if (!parsedCounterpartyType) errors.push(t("settings.accounts.import.invalidEnum"));
    }

    const rawCategoryType = valueAt("categoryType");
    const parsedCategoryType = parseImportEnum(rawCategoryType, CATEGORY_TYPE_OPTIONS, t);
    const categoryType = definition.target === "category" ? parsedCategoryType : "";
    if (definition.target === "category") {
      if (!rawCategoryType) errors.push(requiredFieldError("categoryType", t));
      else if (!parsedCategoryType) errors.push(t("settings.accounts.import.invalidEnum"));
    }

    const rawTagColor = valueAt("color");
    const tagColor = definition.target === "tag" ? parseImportTagColor(rawTagColor) : "";
    if (definition.target === "tag" && rawTagColor && !tagColor) {
      errors.push(t("settings.accounts.import.invalidEnum"));
    }

    const rawKind = valueAt("kind");
    const kindOptions = definition.type === "liability"
      ? LIABILITY_KIND_OPTIONS
      : definition.type === "investment"
        ? [{ value: "investment", labelKey: "account.kind.investment" }]
        : FUNDING_ACCOUNT_KIND_OPTIONS;
    // 旧模板的「固定资产」sheet 记的是 fixed_asset；库里已无该 kind，归一到 investment + property。
    const legacyFixedAssetKind = rawKind === "fixed_asset" || definition.defaultKind === "fixed_asset";
    const parsedKind = parseImportEnum(rawKind, kindOptions, t);
    // 旧「往来款账户」sheet 没有「账户类型」列：填了往来对象的是往来款，否则是贷款。
    const impliedKind = definition.legacyKindByCounterparty && !rawKind
      ? (valueAt("counterparty").trim() ? "settlement" : "loan")
      : definition.defaultKind;
    const kind = legacyFixedAssetKind ? "investment" : parsedKind || impliedKind || "";
    if ((definition.type === "funding" || definition.type === "liability") && !kind) {
      errors.push(rawKind ? t("settings.accounts.import.invalidEnum") : t("settings.accounts.import.kindRequired"));
    }

    const rawInvestProductType = valueAt("investProductType");
    const parsedInvestProductType = parseImportEnum(rawInvestProductType, INVEST_PRODUCT_OPTIONS, t);
    const investProductType = kind === "investment"
      ? legacyFixedAssetKind
        ? "property"
        : parsedInvestProductType
      : "";
    if (definition.type === "investment" && !rawInvestProductType && !legacyFixedAssetKind) {
      errors.push(t("settings.accounts.import.investProductTypeRequired"));
    }
    if (definition.type === "investment" && rawInvestProductType && !parsedInvestProductType) {
      errors.push(t("settings.accounts.import.invalidEnum"));
    }

    const rawFixedAssetType = valueAt("fixedAssetType");
    const parsedFixedAssetType = parseImportEnum(rawFixedAssetType, FIXED_ASSET_TYPE_OPTIONS, t);
    const isPropertyAccount = kind === "investment" && investProductType === "property";
    const fixedAssetType = isPropertyAccount ? parsedFixedAssetType : "";
    if (isPropertyAccount && rawFixedAssetType && !parsedFixedAssetType) {
      errors.push(t("settings.accounts.import.invalidEnum"));
    }

    // 2026-10-07 贷款类别：贷款账户必须填类别（存在性在导入前校验阶段按名称核对）。
    const loanCategory = kind === "loan" ? valueAt("loanCategory").trim() : "";
    if (kind === "loan" && !loanCategory) errors.push(requiredFieldError("loanCategory", t));
    // 贷款口径：home 房贷 / mortgage 抵押贷 / consumer 消费贷 / other 其他；留空由库默认。
    const rawLoanType = valueAt("loanType");
    const parsedLoanType = parseImportEnum(rawLoanType, LOAN_TYPE_OPTIONS, t);
    if (rawLoanType && !parsedLoanType) errors.push(t("settings.accounts.import.invalidEnum"));
    const loanType = kind === "loan" ? parsedLoanType : "";
    const rawIsConsumerLoan = valueAt("isConsumerLoan");
    const isConsumerLoan = kind === "loan" ? parseImportBoolean(rawIsConsumerLoan) : false;
    if (kind === "loan" && rawIsConsumerLoan && parseImportBoolean(rawIsConsumerLoan) == null) {
      errors.push(t("settings.accounts.import.invalidEnum"));
    }
    // 往来款方向：只有往来款账户用；空着由服务端按账户名（应收/应付）推断。
    const rawLiabilityDirection = valueAt("liabilityDirection");
    const parsedLiabilityDirection = parseImportEnum(rawLiabilityDirection, LIABILITY_DIRECTION_OPTIONS, t);
    if (rawLiabilityDirection && !parsedLiabilityDirection) errors.push(t("settings.accounts.import.invalidEnum"));
    const liabilityDirection = kind === "settlement" ? parsedLiabilityDirection : "";

    const billingDayRaw = valueAt("billingDay");
    const parsedBillingDay = billingDayRaw ? Number(parseImportNumber(billingDayRaw)) : null;
    if (billingDayRaw) {
      if (parsedBillingDay == null || !Number.isInteger(parsedBillingDay) || parsedBillingDay < 1 || parsedBillingDay > 31) errors.push(t("settings.accounts.import.billingDayInvalid"));
    }
    const repaymentDayRaw = valueAt("repaymentDay");
    if (repaymentDayRaw) {
      const parsedRepaymentDay = Number(parseImportNumber(repaymentDayRaw));
      if (!Number.isInteger(parsedRepaymentDay) || parsedRepaymentDay < 1 || parsedRepaymentDay > 31) errors.push(t("settings.accounts.import.repaymentDayInvalid"));
    }
    const creditLimitRaw = parseImportNumber(valueAt("creditLimit"));
    if (valueAt("creditLimit") && !creditLimitRaw) errors.push(t("settings.accounts.import.creditLimitInvalid"));
    const rawCreditBillMode = valueAt("creditBillMode");
    const parsedCreditBillMode = parseImportEnum(rawCreditBillMode, CREDIT_BILL_MODE_OPTIONS, t);
    const creditBillMode = kind === "bank_credit"
      ? parsedCreditBillMode
      : "";
    if (kind === "bank_credit" && !rawCreditBillMode) errors.push(requiredFieldError("creditBillMode", t));
    if (rawCreditBillMode && !parsedCreditBillMode) errors.push(t("settings.accounts.import.invalidEnum"));
    // 还款日与「账单日 + N 天」二选一，**两列都填时以「还款日」为准**（不报错，偏移天数忽略）。
    const rawRepaymentOffsetDays = valueAt("repaymentOffsetDays");
    const parsedRepaymentOffsetDays = parseImportNumber(rawRepaymentOffsetDays);
    if (rawRepaymentOffsetDays && parsedRepaymentOffsetDays === "") {
      errors.push(t("settings.accounts.import.invalidEnum"));
    }
    const repaymentOffsetDays = kind === "bank_credit" && !repaymentDayRaw ? parsedRepaymentOffsetDays : "";
    const rawBillingDayTxPeriod = valueAt("billingDayTxPeriod");
    const parsedBillingDayTxPeriod = parseImportEnum(rawBillingDayTxPeriod, BILLING_DAY_TX_PERIOD_OPTIONS, t);
    if (rawBillingDayTxPeriod && !parsedBillingDayTxPeriod) errors.push(t("settings.accounts.import.invalidEnum"));
    const billingDayTxPeriod = kind === "bank_credit" ? parsedBillingDayTxPeriod : "";

    const fundUnitsDecimalsRaw = parseImportNumber(valueAt("fundUnitsDecimals"));
    if (valueAt("fundUnitsDecimals") && !fundUnitsDecimalsRaw) errors.push(t("settings.accounts.import.unitDecimalsInvalid"));
    const rawCostBasisMethod = valueAt("costBasisMethod");
    const costBasisMethod = kind === "investment"
      ? parseImportEnum(rawCostBasisMethod, COST_BASIS_OPTIONS, t) || "moving_avg"
      : "";
    if (rawCostBasisMethod && !parseImportEnum(rawCostBasisMethod, COST_BASIS_OPTIONS, t)) errors.push(t("settings.accounts.import.invalidEnum"));
    const rawTradingCalendar = valueAt("tradingCalendar");
    const tradingCalendar = kind === "investment"
      ? parseImportEnum(rawTradingCalendar, TRADING_CALENDAR_OPTIONS, t) || "cn_fund"
      : "";
    if (rawTradingCalendar && !parseImportEnum(rawTradingCalendar, TRADING_CALENDAR_OPTIONS, t)) errors.push(t("settings.accounts.import.invalidEnum"));
    // 确认/到账天数：投资账户的默认值，留空由品类默认（基金 T+1 等）决定。
    const parsedDefaultConfirmDays = parseImportNumber(valueAt("defaultConfirmDays"));
    if (valueAt("defaultConfirmDays") && parsedDefaultConfirmDays === "") errors.push(t("settings.accounts.import.invalidEnum"));
    const parsedDefaultArrivalDays = parseImportNumber(valueAt("defaultArrivalDays"));
    if (valueAt("defaultArrivalDays") && parsedDefaultArrivalDays === "") errors.push(t("settings.accounts.import.invalidEnum"));
    const defaultConfirmDays = kind === "investment" ? parsedDefaultConfirmDays : "";
    const defaultArrivalDays = kind === "investment" ? parsedDefaultArrivalDays : "";

    const initialBalanceRaw = parseImportNumber(valueAt("initialBalance"));
    if (valueAt("initialBalance") && !initialBalanceRaw) errors.push(t("settings.accounts.import.balanceInvalid"));
    const initialBalanceDate = parseImportDate(valueAt("initialBalanceDate"));
    if (initialBalanceRaw && !initialBalanceDate) errors.push(t("settings.accounts.import.balanceDateInvalid"));

    // 账户级别：只有资金账户（含信用卡）允许；父账户自身不记账，不能带期初余额、不能再有上级。
    const rawAccountLevel = valueAt("level");
    const parsedAccountLevel = definition.target === "account"
      ? parseAccountLevel(rawAccountLevel, t)
      : "";
    const accountLevel: "normal" | "aggregate" = parsedAccountLevel === "aggregate" ? "aggregate" : "normal";
    if (definition.target === "account" && rawAccountLevel && !parsedAccountLevel) {
      errors.push(t("settings.accounts.import.invalidEnum"));
    }
    if (accountLevel === "aggregate") {
      if (valueAt("parent")) errors.push(t("settings.accounts.import.aggregateNoParent"));
      if (initialBalanceRaw) errors.push(t("settings.accounts.import.aggregateNoInitialBalance"));
    }

    return [{
      key: `${definition.type}:${sheetName}:${sourceRow}`,
      sheetType: definition.type,
      sheet: sheetName,
      sourceRow,
      target,
      name: rawName,
      color: tagColor,
      kind,
      institutionType,
      counterpartyType,
      categoryType,
      parentCategoryName: valueAt("parentCategory"),
      parentCategoryId: "",
      loanCategory,
      loanType,
      isConsumerLoan: parseImportBoolean(rawIsConsumerLoan) === true,
      liabilityDirection,
      isReimbursable: target === "counterparty" ? parseImportBoolean(valueAt("isReimbursable")) === true : false,
      sourceInstitutionName: target === "counterparty" ? valueAt("sourceInstitution") : "",
      shortName: valueAt("shortName"),
      investProductType,
      fixedAssetType,
      institutionName: valueAt("institution"),
      institutionId: "",
      counterpartyName: valueAt("counterparty"),
      counterpartyId: "",
      ownerName: valueAt("owner"),
      ownerId: "",
      currency: definition.target === "account" ? normalizeCurrency(valueAt("currency") || baseCurrency) : "",
      accountLevel,
      parentName: definition.target === "account" ? valueAt("parent") : "",
      parentAccountId: "",
      numberMasked: valueAt("numberMasked"),
      billingDay: parsedBillingDay ? String(parsedBillingDay) : "",
      repaymentDay: repaymentDayRaw ? String(Number(parseImportNumber(repaymentDayRaw))) : "",
      creditLimit: creditLimitRaw,
      creditBillMode,
      repaymentOffsetDays,
      billingDayTxPeriod,
      fundUnitsDecimals: fundUnitsDecimalsRaw,
      costBasisMethod,
      tradingCalendar,
      defaultConfirmDays,
      defaultArrivalDays,
      initialBalance: initialBalanceRaw,
      initialBalanceDate,
      note: valueAt("note"),
      errors,
      selected: errors.length === 0,
    }];
  });
}

function categoryTreeHeaders(t: (key: string) => string, thirdLevelCount = 4) {
  const thirdLevel = t("settings.accounts.import.categoryThirdLevelColumn");
  return [
    t("settings.accounts.import.categoryRootColumn"),
    t("settings.accounts.import.categorySecondLevelColumn"),
    ...Array.from({ length: Math.max(1, thirdLevelCount) }, (_, index) => `${thirdLevel}${index + 1}`),
  ];
}

function findCategoryTreeHeaderIndex(rows: unknown[][], t: (key: string) => string) {
  const rootLabels = new Set([
    normalizeImportHeader(t("settings.accounts.import.categoryRootColumn")),
    normalizeImportHeader(HEADER_LABELS.categoryType(t)),
    "type",
    "categorytype",
  ]);
  const secondLevelLabels = new Set([
    normalizeImportHeader(t("settings.accounts.import.categorySecondLevelColumn")),
    "level2",
    "secondlevel",
    "secondlevelcategory",
  ]);
  return rows.findIndex((row) =>
    rootLabels.has(normalizeImportHeader(row[0])) &&
    secondLevelLabels.has(normalizeImportHeader(row[1]))
  );
}

function buildCategoryImportRow(params: {
  sheetName: string;
  sourceRow: number;
  columnIndex: number;
  name: string;
  categoryType: string;
  parentCategoryName: string;
  errors: string[];
}): ImportAccountRow {
  return {
    key: `category:${params.sourceRow}:${params.columnIndex}`,
    sheetType: "category",
    sheet: params.sheetName,
    sourceRow: params.sourceRow,
    target: "category",
    name: params.name,
    color: "",
    accountLevel: "normal",
    kind: "",
    institutionType: "",
    counterpartyType: "",
    categoryType: params.categoryType,
    parentCategoryName: params.parentCategoryName,
    parentCategoryId: "",
    loanCategory: "",
    loanType: "",
    isConsumerLoan: false,
    liabilityDirection: "",
    isReimbursable: false,
    sourceInstitutionName: "",
    shortName: "",
    investProductType: "",
    fixedAssetType: "",
    institutionName: "",
    institutionId: "",
    counterpartyName: "",
    counterpartyId: "",
    ownerName: "",
    ownerId: "",
    currency: "",
    parentName: "",
    parentAccountId: "",
    numberMasked: "",
    billingDay: "",
    repaymentDay: "",
    repaymentOffsetDays: "",
    billingDayTxPeriod: "",
    creditLimit: "",
    creditBillMode: "",
    fundUnitsDecimals: "",
    costBasisMethod: "",
    tradingCalendar: "",
    defaultConfirmDays: "",
    defaultArrivalDays: "",
    initialBalance: "",
    initialBalanceDate: "",
    note: "",
    errors: params.errors,
    selected: params.errors.length === 0,
  };
}

function parseCategoryTreeRows(
  sheetName: string,
  rows: unknown[][],
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const headerIndex = findCategoryTreeHeaderIndex(rows, t);
  if (headerIndex < 0) return [];
  const bodyRows = rows.slice(headerIndex + 1);
  const guideTitle = normalizeImportHeader(t("settings.accounts.import.sheetGuideTitle"));
  const guideOffset = bodyRows.findIndex((row) => row.some((cell) => isGuideTitleCell(cell, guideTitle)));
  const importRows = guideOffset >= 0 ? bodyRows.slice(0, guideOffset) : bodyRows;

  return importRows.flatMap((source, offset): ImportAccountRow[] => {
    const sourceRow = headerIndex + offset + 2;
    const rawType = normalizeImportCell(source[0]);
    const secondLevelName = normalizeImportCell(source[1]);
    const thirdLevelNames = source.slice(2).map(normalizeImportCell).filter(Boolean);
    if (!rawType && !secondLevelName && thirdLevelNames.length === 0) return [];

    const parsedType = parseImportEnum(rawType, CATEGORY_TYPE_OPTIONS, t);
    const errors: string[] = [];
    if (!rawType) errors.push(requiredFieldError("categoryType", t));
    else if (!parsedType) errors.push(t("settings.accounts.import.invalidEnum"));
    if (!secondLevelName) errors.push(t("settings.accounts.import.categorySecondLevelRequired"));

    const rowsForSource: ImportAccountRow[] = [];
    if (secondLevelName) {
      rowsForSource.push(buildCategoryImportRow({
        sheetName,
        sourceRow,
        columnIndex: 2,
        name: secondLevelName,
        categoryType: parsedType,
        parentCategoryName: "",
        errors,
      }));
    }
    rowsForSource.push(...thirdLevelNames.map((name, childIndex) => buildCategoryImportRow({
      sheetName,
      sourceRow,
      columnIndex: childIndex + 3,
      name,
      categoryType: parsedType,
      parentCategoryName: secondLevelName,
      errors,
    })));
    return rowsForSource;
  });
}

type DuplicateNameTarget = "institution" | "familyMember" | "counterparty";

/**
 * Preview-stage duplicate-name check for master data (institution / family member / counterparty).
 * Within each kind, name and shortName share one uniqueness pool: a later row whose name or
 * shortName equals any earlier row's name/shortName (same kind), or any existing record's
 * name/shortName, is marked as an error so it cannot be imported.
 * This mirrors the server-side 409 behavior of assertInstitutionDisplayNamesUnique /
 * assertCounterpartyDisplayNamesUnique. Counterparty rows additionally conflict with the whole
 * institution name space (existing + earlier in-batch institution/family-member rows), because
 * creating a counterparty syncs an institution mirror through assertInstitutionDisplayNamesUnique.
 */
function validateDuplicateNames(
  rows: ImportAccountRow[],
  options: {
    groups: Array<{ id: string; name: string }>;
    institutions: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    counterparties: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    t: (key: string, params?: Record<string, string | number>) => string;
  },
) {
  const existingByTarget: Record<DuplicateNameTarget, Set<string>> = {
    institution: new Set<string>(),
    familyMember: new Set<string>(),
    counterparty: new Set<string>(),
  };
  const addToExisting = (target: DuplicateNameTarget, value: unknown) => {
    const key = normalizeImportHeader(value);
    if (key) existingByTarget[target].add(key);
  };
  for (const item of options.institutions) {
    addToExisting("institution", item.name);
    addToExisting("institution", item.shortName);
    // Creating a counterparty syncs an institution mirror, so a counterparty row also
    // conflicts with every existing institution name/shortName.
    addToExisting("counterparty", item.name);
    addToExisting("counterparty", item.shortName);
    if (item.type === "family_member") {
      addToExisting("familyMember", item.name);
      addToExisting("familyMember", item.shortName);
    }
  }
  for (const item of options.counterparties) {
    addToExisting("counterparty", item.name);
    addToExisting("counterparty", item.shortName);
  }
  for (const item of options.groups) {
    addToExisting("familyMember", item.name);
  }

  // Same-batch claimed names: value -> owning row (sheet + row number). Claim priority follows
  // MASTER_TARGETS import order (institution -> familyMember -> counterparty), so the row that
  // would actually be created first wins and later conflicting rows are flagged.
  const batchClaimed: Record<DuplicateNameTarget, Map<string, { sheet: string; sourceRow: number }>> = {
    institution: new Map(),
    familyMember: new Map(),
    counterparty: new Map(),
  };
  const findBatchOwner = (target: ImportTarget, key: string) => {
    const direct = batchClaimed[target as DuplicateNameTarget]?.get(key);
    if (direct) return direct;
    if (target === "counterparty") {
      return batchClaimed.institution.get(key) ?? batchClaimed.familyMember.get(key);
    }
    return undefined;
  };

  for (const target of ["institution", "familyMember", "counterparty"] as const) {
    for (const row of rows.filter((item) => item.target === target)) {
      const nameKey = normalizeImportHeader(row.name);
      const shortKey = normalizeImportHeader(row.shortName);
      if (nameKey && shortKey && nameKey === shortKey) {
        row.errors.push(options.t("settings.accounts.import.nameEqualsShortName"));
        continue;
      }
      // Only checked rows claim their name/shortName slot in the batch pool. Unchecked
      // rows won't be imported, so they must not block later checked rows from using
      // the same name (the duplicate check still runs against existing DB records below).
      const rowClaimsSlot = row.selected;
      for (const [value, key] of [[row.name, nameKey], [row.shortName, shortKey]] as const) {
        if (!key) continue;
        const batchOwner = findBatchOwner(target, key);
        if (batchOwner) {
          row.errors.push(options.t("settings.accounts.import.duplicateNameInBatch", { value, sheet: batchOwner.sheet, row: batchOwner.sourceRow }));
          continue;
        }
        if (existingByTarget[target].has(key)) {
          row.errors.push(options.t("settings.accounts.import.duplicateNameExisting", { value }));
          continue;
        }
        if (rowClaimsSlot) {
          batchClaimed[target].set(key, { sheet: row.sheet, sourceRow: row.sourceRow });
        }
      }
    }
  }
  return rows;
}

function validateReferences(
  rows: ImportAccountRow[],
  options: {
    groups: Array<{ id: string; name: string }>;
    institutions: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    counterparties: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    categories: ExistingCategory[];
    accounts: ExistingAccountRef[];
    baseCurrency: string;
    t: (key: string, params?: Record<string, string | number>) => string;
  },
) {
  return rows.map((row) => {
    const errors = [...row.errors];
    let institutionId = "";
    let counterpartyId = "";
    let ownerId = "";
    let parentCategoryId = "";
    let parentAccountId = "";

    // 往来对象的「来源机构」必须命中机构表（或本批次同一张表的机构行），否则落库时挂不上。
    if (row.target === "counterparty" && row.sourceInstitutionName) {
      const sourceInstitution = resolveNamedOption(row.sourceInstitutionName, options.institutions);
      // 本批次的机构行（按名称或简称）也算命中，模板示例里的「招行」就是这种情况。
      const pendingSource = pendingRowByName(row.sourceInstitutionName, rows, "institution");
      if (!sourceInstitution.id && !pendingSource) {
        errors.push(options.t("settings.accounts.import.sourceInstitutionNotFound"));
      }
    }

    if (row.target === "account") {
      const allowedTypes = allowedInstitutionTypesForAccount(row.kind, row.investProductType);
      const institution = resolveNamedOption(row.institutionName, options.institutions);
      if (institution.id) {
        institutionId = institution.id;
        const matchedInstitution = options.institutions.find((item) => item.id === institution.id);
        const institutionType = matchedInstitution?.type ?? "other";
        if (isAccountInstitutionEntityType(institutionType)) {
          errors.push(options.t("settings.accounts.import.institutionEntityMismatch"));
        } else if (!allowedTypes.includes(institutionType)) {
          errors.push(options.t("settings.accounts.import.institutionNotAllowed"));
        }
      } else if (institution.error === "multiple matches") {
        errors.push(options.t("settings.accounts.import.institutionAmbiguous"));
      } else if (institution.error === "not found") {
        const pendingInstitution = pendingRowByName(row.institutionName, rows, "institution");
        if (pendingInstitution) {
          const pendingInstitutionType = pendingInstitution.institutionType || "bank";
          if (isAccountInstitutionEntityType(pendingInstitutionType)) {
            errors.push(options.t("settings.accounts.import.institutionEntityMismatch"));
          } else if (!allowedTypes.includes(pendingInstitutionType)) {
            errors.push(options.t("settings.accounts.import.institutionNotAllowed"));
          }
        } else if (
          existingRowMatchesName(row.institutionName, options.groups) ||
          existingRowMatchesName(row.institutionName, options.counterparties) ||
          matchesPendingName(row.institutionName, rows, "familyMember") ||
          matchesPendingName(row.institutionName, rows, "counterparty")
        ) {
          errors.push(options.t("settings.accounts.import.institutionEntityMismatch"));
        } else {
          errors.push(options.t("settings.accounts.import.institutionNotFound"));
        }
      } else if (!row.institutionName && requiresInstitution(row)) {
        errors.push(options.t("settings.accounts.import.institutionRequired"));
      }

      if (row.kind === "settlement" && !row.counterpartyName) {
        errors.push(options.t("settings.accounts.import.settlementRelationRequired"));
      }

      if (row.counterpartyName) {
        const counterparty = resolveNamedOption(row.counterpartyName, options.counterparties);
        // 往来对象只挂在贷款账户（借款来源）与往来款账户上。
        if (row.kind !== "loan" && row.kind !== "settlement") {
          errors.push(options.t("settings.accounts.import.counterpartyAccountKindMismatch"));
        } else if (counterparty.id) {
          counterpartyId = counterparty.id;
        } else if (counterparty.error === "multiple matches") {
          errors.push(options.t("settings.accounts.import.counterpartyAmbiguous"));
        } else if (counterparty.error === "not found") {
          if (
            existingRowMatchesName(row.counterpartyName, options.institutions) ||
            existingRowMatchesName(row.counterpartyName, options.groups) ||
            matchesPendingName(row.counterpartyName, rows, "institution") ||
            matchesPendingName(row.counterpartyName, rows, "familyMember")
          ) {
            errors.push(options.t("settings.accounts.import.counterpartyEntityMismatch"));
          } else if (!matchesPendingName(row.counterpartyName, rows, "counterparty")) {
            errors.push(options.t("settings.accounts.import.counterpartyNotFound"));
          }
        }
        if (row.kind === "loan" && row.institutionName) {
          errors.push(options.t("settings.accounts.import.loanOwnerExclusive"));
        }
      }

      if (!row.ownerName && requiresOwner(row)) {
        errors.push(requiredFieldError("owner", options.t));
      } else {
        const owner = resolveNamedOption(row.ownerName, options.groups);
        if (owner.id) {
          ownerId = owner.id;
        } else if (owner.error === "multiple matches") {
          errors.push(options.t("settings.accounts.import.ownerAmbiguous"));
        } else if (owner.error === "not found") {
          if (
            existingRowMatchesName(row.ownerName, options.institutions) ||
            existingRowMatchesName(row.ownerName, options.counterparties) ||
            matchesPendingName(row.ownerName, rows, "institution") ||
            matchesPendingName(row.ownerName, rows, "counterparty")
          ) {
            errors.push(options.t("settings.accounts.import.ownerEntityMismatch"));
          } else if (!matchesPendingName(row.ownerName, rows, "familyMember")) {
            errors.push(options.t("settings.accounts.import.ownerNotFound"));
          }
        }
      }

      // 多币种子户（2026-10-20）：父账户必须是「系统里已经存在」的多币种父账户，
      // 不接受本批次新建账户当父级（顺序无关、避免歧义），并要求类型一致、同币种唯一。
      // 只有资金账户（含信用卡）允许父子层级（2026-10-20 用户裁定）。
      if (row.accountLevel === "aggregate" && !supportsMultiCurrencyHierarchy(row.kind)) {
        errors.push(options.t("settings.accounts.import.accountLevelKindNotAllowed"));
      }
      if (row.parentName) {
        const normalizedParentName = row.parentName.trim().toLowerCase();
        const matchedParents = options.accounts.filter((item) => item.name.trim().toLowerCase() === normalizedParentName);
        const parent = matchedParents[0];
        if (matchedParents.length > 1) {
          errors.push(options.t("settings.accounts.import.parentAccountAmbiguous"));
        } else if (!parent) {
          errors.push(options.t("settings.accounts.import.parentAccountNotFound", { name: row.parentName.trim() }));
        } else if (parent.name.trim() === row.name.trim()) {
          errors.push(options.t("settings.accounts.import.parentAccountSelf"));
        } else if (!supportsMultiCurrencyHierarchy(row.kind)) {
          errors.push(options.t("settings.accounts.import.parentAccountKindNotAllowed"));
        } else if (!parent.isAggregate || parent.parentId) {
          errors.push(options.t("settings.accounts.import.parentAccountNotAggregate"));
        } else if (!supportsMultiCurrencyHierarchy(parent.kind)) {
          // 历史遗留的非资金父账户不再接受新子户。
          errors.push(options.t("settings.accounts.import.parentAccountKindNotAllowed"));
        } else if (row.kind && parent.kind !== (row.kind === "fixed_asset" ? "investment" : row.kind)) {
          errors.push(options.t("settings.accounts.import.parentAccountKindMismatch"));
        } else {
          const targetCurrency = normalizeCurrency(row.currency || options.baseCurrency);
          const existingSibling = options.accounts.some((item) => (
            item.parentId === parent.id && normalizeCurrency(item.currency || options.baseCurrency) === targetCurrency
          ));
          const pendingSibling = rows.some((other) => (
            other.key !== row.key &&
            other.target === "account" &&
            other.parentName.trim().toLowerCase() === normalizedParentName &&
            normalizeCurrency(other.currency || options.baseCurrency) === targetCurrency
          ));
          if (existingSibling || pendingSibling) {
            errors.push(options.t("settings.accounts.import.parentAccountCurrencyConflict", { currency: targetCurrency }));
          } else {
            parentAccountId = parent.id;
          }
        }
      }
    }

    if (row.target === "category" && row.parentCategoryName) {
      const parent = resolveNamedOption(row.parentCategoryName, options.categories);
      if (parent.id) {
        parentCategoryId = parent.id;
      } else if (parent.error === "multiple matches") {
        errors.push(options.t("settings.accounts.import.parentCategoryAmbiguous"));
      } else if (parent.error === "not found" && !matchesPendingName(row.parentCategoryName, rows, "category")) {
        errors.push(options.t("settings.accounts.import.parentCategoryNotFound"));
      }
    }

    return {
      ...row,
      institutionId,
      counterpartyId,
      ownerId,
      parentCategoryId,
      parentAccountId,
      errors,
      selected: errors.length === 0,
    };
  });
}

const ACCOUNT_LEVEL_OPTIONS: AccountImportOption[] = [
  { value: "normal", labelKey: "settings.accounts.import.accountLevelNormal" },
  { value: "aggregate", labelKey: "settings.accounts.import.accountLevelAggregate" },
];

// 账户级别只有「子账户 / 父账户」两种；同时兼容旧模板写过的「普通账户」以及英文/日文关键字。
function parseAccountLevel(value: string, t: (key: string) => string) {
  const raw = normalizeImportHeader(value);
  if (!raw) return "";
  const parsed = parseImportEnum(value, ACCOUNT_LEVEL_OPTIONS, t);
  if (parsed) return parsed;
  if (/父|親|parent|aggregate/.test(raw)) return "aggregate";
  if (/子|sub|child|normal|普通|通常/.test(raw)) return "normal";
  return "";
}

const FIELD_SELECT_OPTIONS: Partial<Record<AccountBatchImportField, AccountImportOption[]>> = {
  level: ACCOUNT_LEVEL_OPTIONS,
  color: TAG_COLOR_OPTIONS,
  kind: FUNDING_ACCOUNT_KIND_OPTIONS,
  institutionType: INSTITUTION_TYPE_OPTIONS,
  counterpartyType: COUNTERPARTY_TYPE_OPTIONS,
  categoryType: CATEGORY_TYPE_OPTIONS,
  investProductType: INVEST_PRODUCT_OPTIONS,
  fixedAssetType: FIXED_ASSET_TYPE_OPTIONS,
  creditBillMode: CREDIT_BILL_MODE_OPTIONS,
  costBasisMethod: COST_BASIS_OPTIONS,
  tradingCalendar: TRADING_CALENDAR_OPTIONS,
  loanType: LOAN_TYPE_OPTIONS,
  liabilityDirection: LIABILITY_DIRECTION_OPTIONS,
  billingDayTxPeriod: BILLING_DAY_TX_PERIOD_OPTIONS,
  isConsumerLoan: BOOLEAN_SELECT_OPTIONS,
  isReimbursable: BOOLEAN_SELECT_OPTIONS,
};

const EDITABLE_MASTER_FIELDS = new Set<AccountBatchImportField>(["name", "shortName", "institutionType", "counterpartyType", "note"]);
const EDITABLE_CATEGORY_FIELDS = new Set<AccountBatchImportField>(["name", "categoryType", "parentCategory", "note"]);
const EDITABLE_TAG_FIELDS = new Set<AccountBatchImportField>(["name", "color"]);

const EDITABLE_ACCOUNT_FIELDS_BY_SHEET: Partial<Record<ImportSheetType, AccountBatchImportField[]>> = {
  funding: ["name", "kind", "institution", "owner", "currency", "parent", "numberMasked", "billingDay", "repaymentDay", "repaymentOffsetDays", "billingDayTxPeriod", "creditLimit", "creditBillMode", "initialBalance", "initialBalanceDate", "level", "note"],
  investment: ["name", "investProductType", "fixedAssetType", "institution", "owner", "currency", "fundUnitsDecimals", "costBasisMethod", "tradingCalendar", "defaultConfirmDays", "defaultArrivalDays", "note"],
  liability: ["name", "kind", "institution", "counterparty", "loanCategory", "loanType", "isConsumerLoan", "liabilityDirection", "owner", "currency", "initialBalance", "initialBalanceDate", "note"],
};

const FIELD_COLUMN_MIN_WIDTH: Partial<Record<AccountBatchImportField, number>> = {
  name: 150,
  shortName: 100,
  institution: 140,
  counterparty: 120,
  owner: 100,
  kind: 100,
  institutionType: 110,
  counterpartyType: 110,
  investProductType: 130,
  fixedAssetType: 120,
  creditBillMode: 110,
  currency: 70,
  parent: 130,
  level: 110,
  numberMasked: 80,
  billingDay: 80,
  repaymentDay: 80,
  creditLimit: 90,
  initialBalance: 100,
  initialBalanceDate: 130,
  note: 160,
  categoryType: 90,
  parentCategory: 120,
  color: 90,
  fundUnitsDecimals: 90,
  costBasisMethod: 100,
  tradingCalendar: 100,
};

function isRowFieldEditable(row: ImportAccountRow, field: AccountBatchImportField) {
  if (row.target === "institution" || row.target === "familyMember" || row.target === "counterparty") {
    return EDITABLE_MASTER_FIELDS.has(field);
  }
  if (row.target === "category") {
    return EDITABLE_CATEGORY_FIELDS.has(field);
  }
  if (row.target === "tag") {
    return EDITABLE_TAG_FIELDS.has(field);
  }
  if (row.target === "account") {
    if (row.sheetType === "funding" && ["billingDay", "repaymentDay", "repaymentOffsetDays", "billingDayTxPeriod", "creditLimit", "creditBillMode"].includes(field)) {
      return row.kind === "bank_credit";
    }
    return EDITABLE_ACCOUNT_FIELDS_BY_SHEET[row.sheetType]?.includes(field) ?? false;
  }
  return false;
}

function rowFieldValue(row: ImportAccountRow, field: AccountBatchImportField): string {
  switch (field) {
    case "name": return row.name;
    case "shortName": return row.shortName;
    case "institution": return row.institutionName;
    case "counterparty": return row.counterpartyName;
    case "owner": return row.ownerName;
    case "numberMasked": return row.numberMasked;
    case "note": return row.note;
    case "parentCategory": return row.parentCategoryName;
    case "kind": return row.kind;
    case "institutionType": return row.institutionType;
    case "counterpartyType": return row.counterpartyType;
    case "categoryType": return row.categoryType;
    case "investProductType": return row.investProductType;
    case "fixedAssetType": return row.fixedAssetType;
    case "loanCategory": return row.loanCategory;
    case "loanType": return row.loanType;
    case "isConsumerLoan": return row.isConsumerLoan ? "yes" : "";
    case "liabilityDirection": return row.liabilityDirection;
    case "isReimbursable": return row.isReimbursable ? "yes" : "";
    case "sourceInstitution": return row.sourceInstitutionName;
    case "creditBillMode": return row.creditBillMode;
    case "costBasisMethod": return row.costBasisMethod;
    case "tradingCalendar": return row.tradingCalendar;
    case "defaultConfirmDays": return row.defaultConfirmDays;
    case "defaultArrivalDays": return row.defaultArrivalDays;
    case "fundUnitsDecimals": return row.fundUnitsDecimals;
    case "billingDay": return row.billingDay;
    case "repaymentDay": return row.repaymentDay;
    case "repaymentOffsetDays": return row.repaymentOffsetDays;
    case "billingDayTxPeriod": return row.billingDayTxPeriod;
    case "creditLimit": return row.creditLimit;
    case "initialBalance": return row.initialBalance;
    case "initialBalanceDate": return row.initialBalanceDate;
    case "currency": return row.currency;
    case "level": return row.accountLevel === "aggregate" ? "aggregate" : "normal";
    case "parent": return row.parentName;
    case "color": return row.color;
    default: return "";
  }
}

function billingDayDisplayValue(day: string, t: Translate): string {
  const value = Number(day);
  if (!Number.isInteger(value)) return day;
  return isCreditCardMonthEndBillingDay(value)
    ? t("settings.accounts.billingDayMonthEndValue")
    : t("settings.accounts.billingDayValue", { day: value });
}

function rowFieldDisplay(row: ImportAccountRow, field: AccountBatchImportField, t: Translate): string {
  switch (field) {
    case "level":
      return row.accountLevel === "aggregate"
        ? t("settings.accounts.import.accountLevelAggregate")
        : t("settings.accounts.import.accountLevelNormal");
    case "billingDay": return row.billingDay ? billingDayDisplayValue(row.billingDay, t) : "";
    case "color": {
      const colorLabelKey = TAG_COLOR_NAME_KEYS[row.color as keyof typeof TAG_COLOR_NAME_KEYS];
      return row.color ? `${colorLabelKey ? t(colorLabelKey) : row.color} ${row.color}` : "";
    }
    case "kind": return row.kind ? t(`account.kind.${row.kind}`) : "";
    case "institutionType": return row.institutionType ? institutionTypeLabel(row.institutionType, t) : "";
    case "counterpartyType": return row.counterpartyType ? institutionTypeLabel(row.counterpartyType, t) : "";
    case "categoryType": return categoryTypeLabel(row.categoryType, t);
    case "investProductType": return row.investProductType ? t(`investment.product.${row.investProductType}`) : "";
    case "fixedAssetType": return row.fixedAssetType ? t(`fixedAsset.type.${row.fixedAssetType}`) : "";
    case "loanCategory": return row.loanCategory;
    case "loanType": return row.loanType ? t(`loan.type.${row.loanType}`) : "";
    case "liabilityDirection":
      return row.liabilityDirection
        ? t(row.liabilityDirection === "payable" ? "settings.accounts.import.directionPayable" : "settings.accounts.import.directionReceivable")
        : "";
    case "isConsumerLoan":
    case "isReimbursable":
      return field === "isConsumerLoan"
        ? row.isConsumerLoan ? t("settings.accounts.import.yes") : ""
        : row.isReimbursable ? t("settings.accounts.import.yes") : "";
    case "billingDayTxPeriod":
      return row.billingDayTxPeriod
        ? t(row.billingDayTxPeriod === "next" ? "settings.accounts.import.txPeriodNext" : "settings.accounts.import.txPeriodCurrent")
        : "";
    case "creditBillMode": return row.creditBillMode ? t(`entityForm.creditBillMode.${row.creditBillMode}`) : "";
    case "costBasisMethod": return row.costBasisMethod ? displayCostBasisMethod(row.costBasisMethod, t) : "";
    case "tradingCalendar": return row.tradingCalendar ? t(`tradingCalendar.${row.tradingCalendar}`) : "";
    default: return rowFieldValue(row, field);
  }
}

/** Normalize a user-edited cell into the row. Raw text is kept for invalid numbers/dates so the user still sees what they typed; validation flags it. */
function applyRowEdit(row: ImportAccountRow, field: AccountBatchImportField, raw: string): ImportAccountRow {
  const next = { ...row };
  const trimmed = raw.trim();
  switch (field) {
    case "name": next.name = trimmed; break;
    case "shortName": next.shortName = trimmed; break;
    case "color": next.color = trimmed ? (parseImportTagColor(trimmed) || trimmed) : ""; break;
    case "institution": next.institutionName = trimmed; next.institutionId = ""; break;
    case "counterparty": next.counterpartyName = trimmed; next.counterpartyId = ""; break;
    case "owner": next.ownerName = trimmed; next.ownerId = ""; break;
    case "currency": next.currency = trimmed ? normalizeCurrency(trimmed) : ""; break;
    case "level": next.accountLevel = trimmed === "aggregate" ? "aggregate" : "normal"; break;
    case "parent": next.parentName = trimmed; next.parentAccountId = ""; break;
    case "numberMasked": next.numberMasked = trimmed; break;
    case "note": next.note = trimmed; break;
    case "parentCategory": next.parentCategoryName = trimmed; next.parentCategoryId = ""; break;
    case "initialBalanceDate": next.initialBalanceDate = trimmed ? (parseImportDate(trimmed) || trimmed) : ""; break;
    case "initialBalance": next.initialBalance = trimmed ? (parseImportNumber(trimmed) || trimmed) : ""; break;
    case "fundUnitsDecimals": next.fundUnitsDecimals = trimmed ? (parseImportNumber(trimmed) || trimmed) : ""; break;
    case "billingDay":
    case "repaymentDay": {
      const parsed = parseImportNumber(trimmed);
      next[field] = trimmed && parsed ? String(Number(parsed)) : trimmed;
      break;
    }
    case "creditLimit": next.creditLimit = trimmed ? (parseImportNumber(trimmed) || trimmed) : ""; break;
    case "kind": {
      next.kind = trimmed;
      if (trimmed !== "bank_credit") {
        next.billingDay = "";
        next.repaymentDay = "";
        next.repaymentOffsetDays = "";
        next.billingDayTxPeriod = "";
        next.creditLimit = "";
        next.creditBillMode = "";
      }
      if (trimmed !== "settlement") next.liabilityDirection = "";
      if (trimmed !== "loan") {
        next.loanCategory = "";
        next.loanType = "";
        next.isConsumerLoan = false;
      }
      break;
    }
    case "institutionType": next.institutionType = trimmed; break;
    case "counterpartyType": {
      next.counterpartyType = trimmed;
      // The object sheet routes rows by this type: family_member rows are family members, others are counterparties.
      next.target = trimmed === "family_member" ? "familyMember" : "counterparty";
      break;
    }
    case "categoryType": next.categoryType = trimmed; break;
    case "investProductType": next.investProductType = trimmed; break;
    case "fixedAssetType": next.fixedAssetType = trimmed; break;
    case "loanCategory": next.loanCategory = trimmed; break;
    case "loanType": next.loanType = trimmed; break;
    case "isConsumerLoan": next.isConsumerLoan = parseImportBoolean(trimmed) === true; break;
    case "liabilityDirection": next.liabilityDirection = trimmed; break;
    case "isReimbursable": next.isReimbursable = parseImportBoolean(trimmed) === true; break;
    case "sourceInstitution": next.sourceInstitutionName = trimmed; break;
    case "creditBillMode": next.creditBillMode = trimmed; break;
    case "costBasisMethod": next.costBasisMethod = trimmed; break;
    case "tradingCalendar": next.tradingCalendar = trimmed; break;
    case "billingDayTxPeriod": next.billingDayTxPeriod = trimmed; break;
    case "repaymentOffsetDays":
    case "defaultConfirmDays":
    case "defaultArrivalDays": {
      const parsed = parseImportNumber(trimmed);
      next[field] = trimmed && parsed ? String(Number(parsed)) : trimmed;
      break;
    }
    default: break;
  }
  return next;
}

/**
 * Full re-validation after an in-place edit: rebuilds per-row field errors (required fields,
 * number/date formats), then re-runs duplicate-name and reference validation so cross-row
 * effects (renames, retargets) are reflected immediately. Rows keep their manual checkbox
 * choice when it was touched manually.
 */
function revalidateRows(
  rows: ImportAccountRow[],
  options: {
    groups: Array<{ id: string; name: string }>;
    institutions: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    counterparties: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    categories: ExistingCategory[];
    accounts: ExistingAccountRef[];
    baseCurrency: string;
    t: (key: string, params?: Record<string, string | number>) => string;
  },
) {
  const t = options.t;
  const selectionByRow = new Map(rows.map((row) => [row.key, { selected: row.selected, touched: row.touchedSelection ?? false }]));
  const rebuilt = rows.map((row) => {
    const errors: string[] = [];
    if (!row.name.trim()) errors.push(requiredFieldError("name", t));
    if (row.target === "institution" && !row.institutionType) errors.push(requiredFieldError("institutionType", t));
    if ((row.sheetType === "object" || row.sheetType === "counterparty") && !row.counterpartyType) {
      errors.push(requiredFieldError("counterpartyType", t));
    }
    if (row.target === "category" && !row.categoryType) errors.push(requiredFieldError("categoryType", t));
    if (row.target === "tag" && row.color && !parseImportTagColor(row.color)) errors.push(t("settings.accounts.import.invalidEnum"));

    if (row.target === "account") {
      if ((row.sheetType === "funding" || row.sheetType === "liability") && !row.kind) errors.push(t("settings.accounts.import.kindRequired"));
      if (row.sheetType === "investment" && !row.investProductType) errors.push(t("settings.accounts.import.investProductTypeRequired"));
      if (row.kind === "investment" && row.investProductType === "property" && !row.fixedAssetType) {
        errors.push(requiredFieldError("fixedAssetType", t));
      }
      if (row.kind === "bank_credit" && !row.creditBillMode) errors.push(requiredFieldError("creditBillMode", t));
      // 还款日与「账单日 + N 天」二选一：都填时以「还款日」为准，偏移天数忽略（不报冲突）。

      if (row.billingDay) {
        const day = Number(parseImportNumber(row.billingDay));
        if (!Number.isInteger(day) || day < 1 || day > 31) errors.push(t("settings.accounts.import.billingDayInvalid"));
      }
      if (row.repaymentDay) {
        const day = Number(parseImportNumber(row.repaymentDay));
        if (!Number.isInteger(day) || day < 1 || day > 31) errors.push(t("settings.accounts.import.repaymentDayInvalid"));
      }
      if (row.creditLimit && !parseImportNumber(row.creditLimit)) errors.push(t("settings.accounts.import.creditLimitInvalid"));
      if (row.fundUnitsDecimals && !parseImportNumber(row.fundUnitsDecimals)) errors.push(t("settings.accounts.import.unitDecimalsInvalid"));
      if (row.initialBalance && !parseImportNumber(row.initialBalance)) errors.push(t("settings.accounts.import.balanceInvalid"));
      if (row.initialBalance && !parseImportDate(row.initialBalanceDate)) errors.push(t("settings.accounts.import.balanceDateInvalid"));
      if (row.initialBalanceDate && !parseImportDate(row.initialBalanceDate)) errors.push(t("settings.accounts.import.dateInvalid"));
    }

    // 还款日优先：两者都有时清掉偏移天数，保证预览与提交都和「还款日」一致。
    const repaymentNormalized = row.repaymentDay && row.repaymentOffsetDays
      ? { ...row, repaymentOffsetDays: "" }
      : row;
    return { ...repaymentNormalized, errors };
  });
  const duplicateChecked = validateDuplicateNames(rebuilt, options);
  const validated = validateReferences(duplicateChecked, options);
  return validated.map((row) => {
    const preference = selectionByRow.get(row.key);
    if (preference?.touched) return { ...row, selected: preference.selected };
    return row;
  });
}

type PreviewTableProps = {
  rows: ImportAccountRow[];
  columns: AccountBatchImportField[];
  importing: boolean;
  selectedKeys: Set<string>;
  batchReplaceFields: BatchReplaceFieldConfig<AccountBatchImportField>[];
  batchTargetCount: number;
  resetKey: string;
  t: Translate;
  onSelectionChange: (keys: Set<string>) => void;
  onEditField: (key: string, field: AccountBatchImportField, raw: string) => void;
  onBatchEdit: (field: AccountBatchImportField, raw: string) => string | void;
};

const CELL_INPUT_CLASS = "h-7 w-full min-w-0 rounded-md border border-blue-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-blue-500";
const CELL_SELECT_CLASS = "h-7 w-full min-w-0 rounded-md border border-blue-200 bg-white px-1.5 text-xs text-slate-800 outline-none focus:border-blue-500";
const NUMERIC_IMPORT_FIELDS = new Set<AccountBatchImportField>(["billingDay", "repaymentDay", "creditLimit", "fundUnitsDecimals", "initialBalance"]);
const DATE_IMPORT_FIELDS = new Set<AccountBatchImportField>(["initialBalanceDate"]);
const CLEARABLE_BATCH_FIELDS = new Set<AccountBatchImportField>([
  "shortName",
  "color",
  "institution",
  "counterparty",
  "owner",
  "currency",
  "numberMasked",
  "billingDay",
  "repaymentDay",
  "creditLimit",
  "fundUnitsDecimals",
  "costBasisMethod",
  "tradingCalendar",
  "initialBalance",
  "initialBalanceDate",
  "level",
  "parentCategory",
  "note",
]);

function stopCellEvent(event: ReactMouseEvent<HTMLElement>) {
  event.stopPropagation();
}

/** 「账户类型」的可选值取决于所在 sheet：资金账户和贷款/往来款用的是两套枚举。 */
function kindOptionsForSheet(sheetType: ImportSheetType) {
  return sheetType === "liability" ? LIABILITY_KIND_OPTIONS : FUNDING_ACCOUNT_KIND_OPTIONS;
}

function selectOptionsForRowField(row: ImportAccountRow, field: AccountBatchImportField) {
  if (field === "counterpartyType" && row.sheetType === "counterparty") return COUNTERPARTY_TYPE_OPTIONS;
  if (field === "kind") return kindOptionsForSheet(row.sheetType);
  return FIELD_SELECT_OPTIONS[field];
}

function selectOptionsForBatchField(field: AccountBatchImportField, rows: ImportAccountRow[]) {
  if (field === "counterpartyType" && rows.length > 0 && rows.every((row) => row.sheetType === "counterparty")) {
    return COUNTERPARTY_TYPE_OPTIONS;
  }
  if (field === "kind") {
    const allLiability = rows.length > 0 && rows.every((row) => row.sheetType === "liability");
    return kindOptionsForSheet(allLiability ? "liability" : "funding");
  }
  return FIELD_SELECT_OPTIONS[field];
}

function batchSelectOptions(options: AccountImportOption[] | undefined, t: Translate, allowEmpty: boolean) {
  const mapped = (options ?? []).map((option) => ({ value: option.value, label: t(option.labelKey) }));
  return allowEmpty ? [{ value: "", label: t("batchImport.emptyValue") }, ...mapped] : mapped;
}

function buildBatchReplaceFields(
  fields: AccountBatchImportField[],
  candidateRows: ImportAccountRow[],
  t: Translate,
): BatchReplaceFieldConfig<AccountBatchImportField>[] {
  return fields
    .filter((field) => candidateRows.some((row) => isRowFieldEditable(row, field)))
    .map((field) => {
      const allowEmpty = CLEARABLE_BATCH_FIELDS.has(field);
      const selectOptions = selectOptionsForBatchField(field, candidateRows);
      return {
        value: field,
        label: HEADER_LABELS[field](t),
        kind: selectOptions ? "select" : DATE_IMPORT_FIELDS.has(field) ? "date" : NUMERIC_IMPORT_FIELDS.has(field) ? "number" : "text",
        options: selectOptions ? batchSelectOptions(selectOptions, t, allowEmpty) : undefined,
        allowEmpty,
        precision: field === "billingDay" || field === "repaymentDay" || field === "fundUnitsDecimals" ? 0 : 2,
        placeholder: DATE_IMPORT_FIELDS.has(field)
          ? "YYYY-MM-DD"
          : NUMERIC_IMPORT_FIELDS.has(field)
            ? t("batchImport.numberExpressionPlaceholder")
            : undefined,
      };
    });
}

function PreviewTable({
  rows,
  columns,
  importing,
  selectedKeys,
  batchReplaceFields,
  batchTargetCount,
  resetKey,
  t,
  onSelectionChange,
  onEditField,
  onBatchEdit,
}: PreviewTableProps) {
  const [editingCell, setEditingCell] = useState<{ rowKey: string; field: AccountBatchImportField } | null>(null);
  const minWidth = Math.min(1600, Math.max(760, 160 + columns.length * 140));

  function beginEdit(row: ImportAccountRow, field: AccountBatchImportField) {
    if (importing || !isRowFieldEditable(row, field)) return;
    setEditingCell({ rowKey: row.key, field });
  }

  function renderDisplayCell(row: ImportAccountRow, field: AccountBatchImportField, display: string, title: string) {
    const editable = isRowFieldEditable(row, field);
    const color = field === "color" ? row.color : "";
    return (
      <span
        data-row-double-click-ignore
        className={`flex min-h-5 w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 ${editable ? "cursor-pointer hover:bg-slate-100" : "text-slate-500"}`}
        title={editable ? title : display}
        onMouseDown={stopCellEvent}
        onClick={stopCellEvent}
        onDoubleClick={(event) => {
          event.stopPropagation();
          beginEdit(row, field);
        }}
      >
        {color ? <span className="h-3 w-3 shrink-0 rounded-full border border-white shadow-sm" style={{ backgroundColor: color }} aria-hidden="true" /> : null}
        <span className="min-w-0 truncate">{display || "-"}</span>
      </span>
    );
  }

  function renderCell(row: ImportAccountRow, field: AccountBatchImportField) {
    const value = rowFieldValue(row, field);
    const display = rowFieldDisplay(row, field, t);
    const editTitle = t("statementImportPreview.doubleClickEdit", { field: HEADER_LABELS[field](t) });
    if (editingCell?.rowKey === row.key && editingCell.field === field && isRowFieldEditable(row, field)) {
      const selectOptions = selectOptionsForRowField(row, field);
      if (selectOptions) {
        const known = selectOptions.some((option) => option.value === value);
        return (
          <select
            data-row-double-click-ignore
            value={value}
            autoFocus
            onMouseDown={stopCellEvent}
            onClick={stopCellEvent}
            onDoubleClick={stopCellEvent}
            onChange={(event) => {
              onEditField(row.key, field, event.target.value);
              setEditingCell(null);
            }}
            onBlur={() => setEditingCell(null)}
            className={CELL_SELECT_CLASS}
            disabled={importing}
          >
            <option value="">{t("batchImport.emptyValue")}</option>
            {!known && value ? <option value={value}>{display}</option> : null}
            {selectOptions.map((option) => (
              <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
            ))}
          </select>
        );
      }
      return (
        <input
          data-row-double-click-ignore
          type="text"
          value={value}
          autoFocus
          onMouseDown={stopCellEvent}
          onClick={stopCellEvent}
          onDoubleClick={stopCellEvent}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onEditField(row.key, field, event.target.value)}
          onBlur={() => setEditingCell(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") setEditingCell(null);
          }}
          className={CELL_INPUT_CLASS}
          placeholder={DATE_IMPORT_FIELDS.has(field) ? "YYYY-MM-DD" : undefined}
          disabled={importing}
        />
      );
    }
    return renderDisplayCell(row, field, display, editTitle);
  }

  const tableColumns: AdvancedDataTableColumn<ImportAccountRow>[] = [
    {
      key: "sourceRow",
      label: "#",
      width: 56,
      minWidth: 48,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => String(row.sourceRow),
      filterNumber: (row) => row.sourceRow,
      sortValue: (row) => row.sourceRow,
      render: (row) => <span className="tabular-nums text-slate-500">{row.sourceRow}</span>,
    },
    ...columns.map((field): AdvancedDataTableColumn<ImportAccountRow> => {
      const isNumeric = NUMERIC_IMPORT_FIELDS.has(field);
      const isDate = DATE_IMPORT_FIELDS.has(field);
      const isSelect = Boolean(FIELD_SELECT_OPTIONS[field]);
      return {
        key: field,
        label: HEADER_LABELS[field](t),
        width: Math.max(FIELD_COLUMN_MIN_WIDTH[field] ?? 120, 96),
        minWidth: Math.min(Math.max(FIELD_COLUMN_MIN_WIDTH[field] ?? 120, 88), 180),
        align: isNumeric ? "right" : "left",
        filterKind: isDate ? "dateRange" : isNumeric ? "numberRange" : isSelect ? "multi" : "text",
        filterText: (row) => rowFieldDisplay(row, field, t) || t("batchImport.emptyValue"),
        filterNumber: isNumeric ? (row) => {
          const parsed = Number(parseImportNumber(rowFieldValue(row, field)));
          return Number.isFinite(parsed) ? parsed : null;
        } : undefined,
        sortValue: (row) => {
          if (isNumeric) {
            const parsed = Number(parseImportNumber(rowFieldValue(row, field)));
            return Number.isFinite(parsed) ? parsed : null;
          }
          return rowFieldDisplay(row, field, t) || "";
        },
        truncate: false,
        cellTitle: (row) => rowFieldDisplay(row, field, t),
        render: (row) => renderCell(row, field),
      };
    }),
    {
      key: "status",
      label: t("settings.accounts.import.notes"),
      width: 220,
      minWidth: 160,
      filterKind: "text",
      filterText: (row) => row.errors.length > 0 ? row.errors.join(" / ") : t("batchImport.emptyValue"),
      render: (row) => row.errors.length > 0 ? (
        <span className="block truncate text-red-600" title={row.errors.join(" / ")}>{row.errors.join(" / ")}</span>
      ) : (
        <span className="text-slate-400">-</span>
      ),
    },
  ];

  return (
    <AdvancedDataTable
      storageKey={`mmh_basic_data_import_preview_table_v1:${resetKey}`}
      columns={tableColumns}
      rows={rows}
      rowKey={(row) => row.key}
      emptyText={t("settings.accounts.import.noPreview")}
      minTableWidth={minWidth}
      selectable
      selectAllScope="renderedRows"
      selectedKeys={selectedKeys}
      onSelectionChange={(keys) => {
        if (importing) return;
        onSelectionChange(keys);
      }}
      batchActionSlot={(
        <BatchReplacePopoverButton
          fields={batchReplaceFields}
          targetCount={batchTargetCount}
          targetLabel={t("batchImport.selectedTargetLabel")}
          disabledTitle={t("statementImportPreview.selectRowsFirst")}
          buttonTitle={t("statementImportPreview.batchEditSelected", { count: batchTargetCount })}
          panelAlign="left"
          messageClassName="sr-only"
          onApply={onBatchEdit}
        />
      )}
      toolbarTitle={t("settings.accounts.import.previewTitle")}
      toolbarRightContent={<span className="text-xs text-slate-500">{t("settings.accounts.import.selectedCount", { selected: selectedKeys.size, total: rows.length })}</span>}
      rowClassName={(row) => row.errors.length > 0 ? "bg-red-50/60 hover:bg-red-100" : row.selected ? "bg-blue-50/40 hover:bg-blue-100" : "bg-white hover:bg-slate-50"}
      onRowDoubleClick={(row) => {
        const firstEditableField = columns.find((field) => isRowFieldEditable(row, field));
        if (firstEditableField) beginEdit(row, firstEditableField);
      }}
      fillHeight
      compactRows
      resetKey={resetKey}
      resetDisplayStateOnMount
    />
  );
}

async function fetchCategories(): Promise<ExistingCategory[]> {
  const response = await fetch("/api/v1/category", { cache: "no-store" });
  const data = await response.json().catch(() => null) as { ok?: boolean; categories?: ExistingCategory[] } | null;
  return data?.ok && Array.isArray(data.categories) ? data.categories : [];
}

/** 2026-10-07 贷款类别：贷款账户必选类别，导入前按名称核对本账簿已有类别。 */
async function fetchLoanCategories(): Promise<Array<{ id: string; name: string; baseType: string }>> {
  const response = await fetch("/api/v1/loan-categories", { cache: "no-store" });
  const data = await response.json().catch(() => null) as
    | { ok?: boolean; categories?: Array<{ id: string; name: string; baseType: string }> }
    | null;
  return data?.ok && Array.isArray(data.categories) ? data.categories : [];
}

/** 父账户校验只认系统里已存在的账户，因此导入时必须先取一次账户清单。 */
async function fetchExistingAccounts(): Promise<ExistingAccountRef[]> {
  const response = await fetch("/api/v1/accounts", { cache: "no-store" });
  const data = await response.json().catch(() => null) as { ok?: boolean; accounts?: unknown[] } | null;
  if (!data?.ok || !Array.isArray(data.accounts)) return [];
  return data.accounts.flatMap((item): ExistingAccountRef[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? "");
    const name = String(record.name ?? "");
    if (!id || !name) return [];
    return [{
      id,
      name,
      kind: String(record.kind ?? ""),
      currency: record.currency ? String(record.currency) : null,
      parentId: record.parentId ? String(record.parentId) : null,
      isAggregate: record.isAggregate === true,
    }];
  });
}

async function fetchExistingTags(): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch("/api/v1/tags", { cache: "no-store" });
  const data = await response.json().catch(() => null) as { ok?: boolean; tags?: Array<{ id: string; name: string }> } | null;
  return data?.ok && Array.isArray(data.tags) ? data.tags : [];
}

export function buildAccountImportRows(
  file: File,
  t: (key: string, params?: Record<string, string | number>) => string,
  options: {
    groups: Array<{ id: string; name: string }>;
    institutions: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    counterparties: Array<{ id: string; name: string; shortName?: string | null; type?: string | null }>;
    categories: ExistingCategory[];
    accounts: ExistingAccountRef[];
    baseCurrency: string;
  },
): Promise<ImportAccountRow[]> {
  return import("xlsx").then(async (XLSX) => {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    // 新模板的 sheet 名 + 旧模板 sheet 名别名（旧文件仍可导入）。
    const definitionsBySheetName = buildSheetDefinitionsByName(t);
    const parsedRows: ImportAccountRow[] = [];
    for (const sheetName of workbook.SheetNames) {
      const definition = definitionsBySheetName.get(normalizeImportHeader(sheetName));
      if (!definition) continue;
      const sheet = workbook.Sheets[sheetName];
      const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
      const nextRows = definition.type === "category"
        ? parseCategoryTreeRows(sheetName, sheetRows, t)
        : [];
      parsedRows.push(...(nextRows.length > 0 ? nextRows : parseSheetRows(sheetName, definition, sheetRows, t, options.baseCurrency)));
    }
    return validateReferences(validateDuplicateNames(parsedRows, { ...options, t }), { ...options, t });
  });
}

function optionList(options: AccountImportOption[], t: (key: string) => string) {
  return options.map((option) => t(option.labelKey)).join("\n");
}

function rowFromFields(fields: AccountBatchImportField[], values: Partial<Record<AccountBatchImportField, string>>) {
  return fields.map((field) => values[field] ?? "");
}

type SheetMergeRange = { s: { r: number; c: number }; e: { r: number; c: number } };
type WorksheetWithMerges = { "!merges"?: SheetMergeRange[] };

function guideWideRow(cells: string[]) {
  return [...cells, ...Array.from({ length: Math.max(0, GUIDE_COLUMN_COUNT - cells.length) }, () => "")];
}

function applyGuideMerges(sheet: WorksheetWithMerges, guideStartRow: number, guideHeaderRow: number, rows: string[][]) {
  const rowCount = rows.length;
  const merges = sheet["!merges"] ?? [];
  for (let rowIndex = guideStartRow; rowIndex < guideHeaderRow; rowIndex += 1) {
    merges.push({ s: { r: rowIndex, c: 0 }, e: { r: rowIndex, c: GUIDE_NOTE_COLUMN_END } });
  }
  for (let rowIndex = guideHeaderRow; rowIndex < rowCount; rowIndex += 1) {
    merges.push({ s: { r: rowIndex, c: GUIDE_NOTE_COLUMN_START }, e: { r: rowIndex, c: GUIDE_NOTE_COLUMN_END } });
  }
  let fieldStartRow = guideHeaderRow + 1;
  for (let rowIndex = fieldStartRow + 1; rowIndex <= rowCount; rowIndex += 1) {
    const startsNextField = rowIndex === rowCount || Boolean(String(rows[rowIndex]?.[0] ?? "").trim());
    if (!startsNextField) continue;
    if (rowIndex - fieldStartRow > 1 && String(rows[fieldStartRow]?.[0] ?? "").trim()) {
      merges.push({ s: { r: fieldStartRow, c: 0 }, e: { r: rowIndex - 1, c: 0 } });
    }
    fieldStartRow = rowIndex;
  }
  sheet["!merges"] = merges;
}

function mergedFieldLabelStartRows(sheet: WorksheetWithMerges) {
  const startRows = new Set<number>();
  for (const merge of sheet["!merges"] ?? []) {
    if (merge.s.c === 0 && merge.e.c === 0 && merge.e.r > merge.s.r) startRows.add(merge.s.r);
  }
  return startRows;
}


function appendSheetGuideRows(
  dataRows: string[][],
  sheetType: ImportSheetType,
  fields: AccountBatchImportField[],
  guideRows: SheetGuideRow[],
  t: (key: string) => string,
  swatches?: Map<string, GuideSwatch>,
) {
  const rows = [
    ...dataRows,
    [],
    // 说明区只占一行：标题 + 「以下数据会被忽略」+ 「未修改的 sheet 会被忽略」合并为一个单元格。
    guideWideRow([t("settings.accounts.import.sheetGuideTitleCombined")]),
    guideWideRow([t("settings.accounts.import.guideField"), t("settings.accounts.import.guideValue"), t("settings.accounts.import.guideNote")]),
  ];
  for (const [field, allowedValues, note, options] of guideRows.filter(([field]) => fields.includes(field))) {
    const values = allowedValues.split("\n").filter(Boolean);
    const required = isRequiredField(sheetType, field);
    const prefix = values.length > 1
      ? t(required ? "settings.accounts.import.requiredEnumGuide" : "settings.accounts.import.optionalEnumGuide")
      : required
        ? t("settings.accounts.import.requiredFieldGuide")
        : "";
    const firstValueOwnRow = options?.firstValueOwnRow ?? false;
    rows.push(guideWideRow([
      HEADER_LABELS[field](t),
      firstValueOwnRow ? "" : values[0] ?? "",
      [prefix, note].filter(Boolean).join(" "),
    ]));
    for (const value of firstValueOwnRow ? values : values.slice(1)) {
      rows.push(guideWideRow(["", value, swatches?.get(value.trim().toUpperCase())?.name ?? ""]));
    }
  }
  return [
    ...rows,
  ];
}

function appendStyledSheet(
  XLSX: typeof import("xlsx-js-style"),
  workbook: import("xlsx-js-style").WorkBook,
  sheetName: string,
  sheetType: ImportSheetType,
  fields: AccountBatchImportField[],
  sampleRows: Array<Partial<Record<AccountBatchImportField, string>>>,
  guideRows: SheetGuideRow[],
  t: (key: string) => string,
  swatches?: Map<string, GuideSwatch>,
) {
  const headers = fields.map((field) => HEADER_LABELS[field](t));
  const dataRows = [headers, ...sampleRows.map((row) => rowFromFields(fields, { ...row, sample: t("settings.accounts.import.sampleRowYes") }))];
  const allRows = appendSheetGuideRows(dataRows, sheetType, fields, guideRows, t, swatches);
  const sheet = XLSX.utils.aoa_to_sheet(allRows);
  const columnCount = Math.max(...allRows.map((row) => row.length), GUIDE_COLUMN_COUNT);
  sheet["!cols"] = Array.from({ length: columnCount }, (_, columnIndex) => {
    const defaultWidth = columnIndex >= GUIDE_NOTE_COLUMN_START && columnIndex <= GUIDE_NOTE_COLUMN_END ? 18 : columnIndex === 1 ? 28 : 16;
    const contentWidth = Math.max(...allRows.map((row) => String(row[columnIndex] ?? "").split("\n").reduce((max, item) => Math.max(max, item.length + 2), 0)));
    return { wch: Math.max(defaultWidth, Math.min(36, contentWidth)) };
  });
  const border = {
    top: { style: "thin", color: { rgb: "E2E8F0" } },
    bottom: { style: "thin", color: { rgb: "E2E8F0" } },
    left: { style: "thin", color: { rgb: "E2E8F0" } },
    right: { style: "thin", color: { rgb: "E2E8F0" } },
  };
  fields.forEach((field, columnIndex) => {
    const address = XLSX.utils.encode_cell({ r: 0, c: columnIndex });
    const required = isRequiredField(sheetType, field);
    if (sheet[address]) {
      sheet[address].s = {
        fill: { patternType: "solid", fgColor: { rgb: required ? "FCE4D6" : "E2E8F0" } },
        font: { bold: true, color: { rgb: required ? "C00000" : "1F2937" } },
        alignment: { horizontal: "center", vertical: "center" },
        border,
      };
    }
  });
  const guideStartRow = dataRows.length + 1;
  const guideHeaderRow = guideStartRow + 1;
  for (let rowIndex = guideStartRow; rowIndex < guideHeaderRow; rowIndex += 1) {
    const guideIntroCell = XLSX.utils.encode_cell({ r: rowIndex, c: 0 });
    if (sheet[guideIntroCell]) {
      sheet[guideIntroCell].s = {
        font: { bold: rowIndex === guideStartRow, color: { rgb: rowIndex === guideStartRow ? "1F2937" : "374151" } },
        fill: { patternType: "solid", fgColor: { rgb: "DBEAFE" } },
        alignment: { horizontal: "left", vertical: "center", wrapText: true },
        border,
      };
    }
  }
  // Merged cells do not auto-fit row height in Excel, so reserve space for guide notice rows.
  const guideRowHeights = sheet["!rows"] ?? [];
  guideRowHeights[guideStartRow] = { hpt: GUIDE_NOTICE_ROW_HEIGHT };
  sheet["!rows"] = guideRowHeights;
  applyGuideMerges(sheet, guideStartRow, guideHeaderRow, allRows);
  for (let columnIndex = 0; columnIndex < GUIDE_COLUMN_COUNT; columnIndex += 1) {
    const address = XLSX.utils.encode_cell({ r: guideHeaderRow, c: columnIndex });
    if (sheet[address]) {
      sheet[address].s = {
        fill: { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
        font: { bold: true, color: { rgb: "1F2937" } },
        alignment: { horizontal: "left", vertical: "center", wrapText: true },
        border,
      };
    }
  }
  const requiredGuideLabels = new Set(fields.filter((field) => isRequiredField(sheetType, field)).map((field) => HEADER_LABELS[field](t)));
  const mergedGuideFieldRows = mergedFieldLabelStartRows(sheet);
  const swatchByCellText = (text: string) => swatches?.get(text.trim().toUpperCase());
  const swatchStyle = (swatch: GuideSwatch, horizontal: "center" | undefined) => ({
    fill: { patternType: "solid", fgColor: { rgb: swatch.rgb } },
    font: { color: { rgb: isLightSwatchColor(swatch.rgb) ? "1F2937" : "FFFFFF" } },
    alignment: { horizontal, vertical: "top" as const, wrapText: true },
    border,
  });
  // Sample color cells display swatches directly so the filled-in value is visible.
  const colorFieldIndex = fields.indexOf("color");
  if (swatches && colorFieldIndex >= 0) {
    for (let rowIndex = 1; rowIndex < dataRows.length; rowIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: colorFieldIndex });
      if (!sheet[address]) continue;
      const swatch = swatchByCellText(String(allRows[rowIndex]?.[colorFieldIndex] ?? ""));
      if (!swatch) continue;
      sheet[address].s = {
        ...swatchStyle(swatch, "center"),
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
      };
    }
  }
  let currentGuideFieldRequired = false;
  for (let rowIndex = guideHeaderRow + 1; rowIndex < allRows.length; rowIndex += 1) {
    const guideFieldLabel = String(allRows[rowIndex]?.[0] ?? "");
    if (guideFieldLabel) currentGuideFieldRequired = requiredGuideLabels.has(guideFieldLabel);
    for (let columnIndex = 0; columnIndex < GUIDE_COLUMN_COUNT; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      if (!sheet[address]) continue;
      const swatch = columnIndex === 1 ? swatchByCellText(String(allRows[rowIndex]?.[1] ?? "")) : undefined;
      sheet[address].s = swatch
        ? swatchStyle(swatch, "center")
        : {
            font: { bold: currentGuideFieldRequired && columnIndex === 0, color: { rgb: currentGuideFieldRequired ? "C00000" : "374151" } },
            alignment: {
              horizontal: columnIndex === 0 && mergedGuideFieldRows.has(rowIndex) ? "left" : undefined,
              vertical: columnIndex === 0 && mergedGuideFieldRows.has(rowIndex) || columnIndex >= GUIDE_NOTE_COLUMN_START ? "center" : "top",
              wrapText: true,
            },
            border,
          };
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
}

function fallbackCategoryTemplateRows(t: (key: string) => string) {
  return [
    categoryTreeHeaders(t),
    [
      categoryTypeLabel("expense", t),
      t("settings.accounts.importSampleCategoryDining"),
      t("settings.accounts.importSampleCategoryBreakfast"),
      t("settings.accounts.importSampleCategoryLunch"),
      t("settings.accounts.importSampleCategoryDinner"),
    ],
    [
      categoryTypeLabel("expense", t),
      t("settings.accounts.importSampleCategoryTransport"),
      t("settings.accounts.importSampleCategoryTaxi"),
      t("settings.accounts.importSampleCategoryBus"),
      t("settings.accounts.importSampleCategorySubway"),
    ],
    [
      categoryTypeLabel("income", t),
      t("settings.accounts.importSampleCategorySalary"),
      t("settings.accounts.importSampleCategoryBaseSalary"),
      t("settings.accounts.importSampleCategoryBonus"),
    ],
    [
      categoryTypeLabel("income", t),
      t("settings.accounts.importSampleCategoryInvestmentIncome"),
      t("settings.accounts.importSampleCategoryInterest"),
      t("settings.accounts.importSampleCategoryDividend"),
    ],
  ];
}

function buildCategoryTemplateRows(
  categories: ExistingCategory[],
  t: (key: string) => string,
) {
  const allowedTypes = new Set(CATEGORY_TYPE_OPTIONS.map((option) => option.value));
  const usableCategories = categories.filter((category) => allowedTypes.has(category.type));
  if (usableCategories.length === 0) return fallbackCategoryTemplateRows(t);

  const categoryById = new Map(usableCategories.map((category) => [category.id, category]));
  const childrenByParentId = new Map<string, ExistingCategory[]>();
  const rootRows: ExistingCategory[] = [];
  for (const category of usableCategories) {
    if (!category.parentId) {
      rootRows.push(category);
      continue;
    }
    const siblings = childrenByParentId.get(category.parentId) ?? [];
    siblings.push(category);
    childrenByParentId.set(category.parentId, siblings);
  }

  const categoryRows: string[][] = [];
  const exportedIds = new Set<string>();
  for (const root of rootRows) {
    exportedIds.add(root.id);
    const children = childrenByParentId.get(root.id) ?? [];
    children.forEach((child) => exportedIds.add(child.id));
    categoryRows.push([categoryTypeLabel(root.type, t), root.name, ...children.map((child) => child.name)]);
  }

  for (const category of usableCategories) {
    if (!exportedIds.has(category.id) && (!category.parentId || !categoryById.has(category.parentId))) {
      categoryRows.push([categoryTypeLabel(category.type, t), category.name]);
    }
  }

  if (categoryRows.length === 0) return fallbackCategoryTemplateRows(t);
  const thirdLevelCount = Math.max(4, ...categoryRows.map((row) => Math.max(0, row.length - 2)));
  return [categoryTreeHeaders(t, thirdLevelCount), ...categoryRows];
}

function appendCategoryStyledSheet(
  XLSX: typeof import("xlsx-js-style"),
  workbook: import("xlsx-js-style").WorkBook,
  sheetName: string,
  dataRows: string[][],
  t: (key: string) => string,
) {
  const guideRows: Array<[string, string, string, boolean]> = [
    [
      t("settings.accounts.import.categoryRootColumn"),
      optionList(CATEGORY_TYPE_OPTIONS, t),
      t("settings.accounts.import.guideCategoryRoot"),
      true,
    ],
    [
      t("settings.accounts.import.categorySecondLevelColumn"),
      t("settings.accounts.import.guideRequiredValue"),
      t("settings.accounts.import.guideCategorySecondLevel"),
      true,
    ],
    [
      t("settings.accounts.import.categoryThirdLevelColumn"),
      t("settings.accounts.import.guideOptionalValue"),
      t("settings.accounts.import.guideCategoryThirdLevel"),
      false,
    ],
  ];
  const guideDataRows = guideRows.flatMap(([field, allowedValues, note, required]) => {
    const values = allowedValues.split("\n").filter(Boolean);
    const prefix = values.length > 1
      ? t(required ? "settings.accounts.import.requiredEnumGuide" : "settings.accounts.import.optionalEnumGuide")
      : required
        ? t("settings.accounts.import.requiredFieldGuide")
        : "";
    return [
      guideWideRow([field, values[0] ?? "", [prefix, note].filter(Boolean).join(" ")]),
      ...values.slice(1).map((value) => guideWideRow(["", value, ""])),
    ];
  });
  const allRows = [
    ...dataRows,
    [],
    // 说明区只占一行（与账户各 sheet 一致）。
    guideWideRow([t("settings.accounts.import.sheetGuideTitleCombinedCategory")]),
    guideWideRow([t("settings.accounts.import.guideField"), t("settings.accounts.import.guideValue"), t("settings.accounts.import.guideNote")]),
    ...guideDataRows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(allRows);
  const columnCount = Math.max(...allRows.map((row) => row.length), GUIDE_COLUMN_COUNT);
  sheet["!cols"] = Array.from({ length: columnCount }, (_, columnIndex) => {
    if (columnIndex >= GUIDE_NOTE_COLUMN_START) return { wch: 18 };
    const defaultWidth = columnIndex === 0 ? 14 : 20;
    const contentWidth = Math.max(...allRows.map((row) => String(row[columnIndex] ?? "").split("\n").reduce((max, item) => Math.max(max, item.length + 2), 0)));
    return { wch: Math.max(defaultWidth, Math.min(36, contentWidth)) };
  });
  const border = {
    top: { style: "thin", color: { rgb: "E2E8F0" } },
    bottom: { style: "thin", color: { rgb: "E2E8F0" } },
    left: { style: "thin", color: { rgb: "E2E8F0" } },
    right: { style: "thin", color: { rgb: "E2E8F0" } },
  };
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const address = XLSX.utils.encode_cell({ r: 0, c: columnIndex });
    if (sheet[address]) {
      sheet[address].s = {
        fill: { patternType: "solid", fgColor: { rgb: columnIndex < 2 ? "FCE4D6" : "E2E8F0" } },
        font: { bold: true, color: { rgb: columnIndex < 2 ? "C00000" : "1F2937" } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border,
      };
    }
  }
  const guideStartRow = dataRows.length + 1;
  const guideHeaderRow = guideStartRow + 1;
  for (let rowIndex = guideStartRow; rowIndex < guideHeaderRow; rowIndex += 1) {
    const guideIntroCell = XLSX.utils.encode_cell({ r: rowIndex, c: 0 });
    if (sheet[guideIntroCell]) {
      sheet[guideIntroCell].s = {
        font: { bold: rowIndex === guideStartRow, color: { rgb: rowIndex === guideStartRow ? "1F2937" : "374151" } },
        fill: { patternType: "solid", fgColor: { rgb: "DBEAFE" } },
        alignment: { horizontal: "left", vertical: "center", wrapText: true },
        border,
      };
    }
  }
  // Merged cells do not auto-fit row height in Excel, so reserve space for guide notice rows.
  const guideRowHeights = sheet["!rows"] ?? [];
  guideRowHeights[guideStartRow] = { hpt: GUIDE_NOTICE_ROW_HEIGHT };
  sheet["!rows"] = guideRowHeights;
  applyGuideMerges(sheet, guideStartRow, guideHeaderRow, allRows);
  const requiredGuideLabels = new Set(guideRows.filter(([, , , required]) => required).map(([field]) => field));
  const mergedGuideFieldRows = mergedFieldLabelStartRows(sheet);
  let currentGuideFieldRequired = false;
  for (let rowIndex = guideHeaderRow; rowIndex < allRows.length; rowIndex += 1) {
    const guideFieldLabel = String(allRows[rowIndex]?.[0] ?? "");
    if (guideFieldLabel) currentGuideFieldRequired = requiredGuideLabels.has(guideFieldLabel);
    for (let columnIndex = 0; columnIndex < GUIDE_COLUMN_COUNT; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      if (!sheet[address]) continue;
      sheet[address].s = {
        fill: rowIndex === guideHeaderRow ? { patternType: "solid", fgColor: { rgb: "E2E8F0" } } : undefined,
        font: {
          bold: rowIndex === guideHeaderRow || (currentGuideFieldRequired && columnIndex === 0),
          color: { rgb: rowIndex > guideHeaderRow && currentGuideFieldRequired ? "C00000" : "1F2937" },
        },
        alignment: {
          horizontal: "left",
          vertical: rowIndex === guideHeaderRow || (columnIndex === 0 && mergedGuideFieldRows.has(rowIndex)) || columnIndex >= GUIDE_NOTE_COLUMN_START ? "center" : "top",
          wrapText: true,
        },
        border,
      };
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
}

function displayCostBasisMethod(value: string, t: (key: string) => string) {
  if (!value) return "";
  if (value === "moving_avg") return t("settings.accounts.movingAverage");
  return t(`settings.accounts.${value}`);
}

function mapByName<T extends { id: string; name: string; shortName?: string | null }>(items: T[]) {
  const map = new Map<string, string>();
  for (const item of items) {
    map.set(normalizeImportHeader(item.name), item.id);
    if (item.shortName) map.set(normalizeImportHeader(item.shortName), item.id);
  }
  return map;
}

function createdEntityId(data: unknown, key: string) {
  const object = data as Record<string, unknown> | null;
  const entity = object?.[key] as { id?: unknown } | undefined;
  return typeof entity?.id === "string" ? entity.id : "";
}

export function AccountBatchImportButton({
  groups,
  institutions,
  counterparties,
  baseCurrency,
  onImported,
  compact = false,
  exportTemplateTitle,
  importExcelTitle,
}: AccountBatchImportButtonProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [rows, setRows] = useState<ImportAccountRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [activeSheet, setActiveSheet] = useState("");
  const [importCategories, setImportCategories] = useState<ExistingCategory[]>([]);
  const [importAccounts, setImportAccounts] = useState<ExistingAccountRef[]>([]);

  const selectedRows = useMemo(() => rows.filter((row) => row.selected), [rows]);

  const sheetOptions = useMemo(() => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.sheet)) {
        seen.add(row.sheet);
        names.push(row.sheet);
      }
    }
    return names;
  }, [rows]);

  const sheetStats = useMemo(() => {
    const stats = new Map<string, { total: number; errors: number; selected: number }>();
    for (const row of rows) {
      const stat = stats.get(row.sheet) ?? { total: 0, errors: 0, selected: 0 };
      stat.total += 1;
      if (row.errors.length > 0) stat.errors += 1;
      if (row.selected) stat.selected += 1;
      stats.set(row.sheet, stat);
    }
    return stats;
  }, [rows]);

  const activeSheetIndex = useMemo(
    () => Math.max(0, sheetOptions.indexOf(activeSheet)),
    [sheetOptions, activeSheet],
  );
  const isFirstSheet = activeSheetIndex <= 0;
  const isLastSheet = activeSheetIndex >= sheetOptions.length - 1;
  const activeSheetStats = activeSheet ? sheetStats.get(activeSheet) : undefined;
  const activeSheetSelected = activeSheetStats?.selected ?? 0;
  const selectedRowsWithErrors = useMemo(() => selectedRows.filter((row) => row.errors.length > 0), [selectedRows]);
  const canGoNext = !isLastSheet;
  const canImport = selectedRows.length > 0 && selectedRowsWithErrors.length === 0;

  const visibleRows = useMemo(
    () => rows.filter((row) => !activeSheet || row.sheet === activeSheet),
    [rows, activeSheet],
  );

  const sheetColumns = useMemo(() => {
    // 含旧模板 sheet 名别名，否则旧文件（如「往来款账户」）解析出数据却没有列。
    const definitionsBySheetName = buildSheetDefinitionsByName(t);
    const columnsBySheet = new Map<string, AccountBatchImportField[]>();
    for (const row of rows) {
      if (columnsBySheet.has(row.sheet)) continue;
      const fields = (definitionsBySheetName.get(normalizeImportHeader(row.sheet))?.fields ?? []).filter((field) => field !== "sample");
      columnsBySheet.set(row.sheet, fields);
    }
    return columnsBySheet;
  }, [rows, t]);

  const activeSheetColumns = useMemo(
    () => sheetColumns.get(activeSheet) ?? sheetColumns.get(visibleRows[0]?.sheet ?? "") ?? [],
    [activeSheet, sheetColumns, visibleRows],
  );
  const activeSelectedRows = useMemo(() => visibleRows.filter((row) => row.selected), [visibleRows]);
  const visibleSelectedKeys = useMemo(() => new Set(activeSelectedRows.map((row) => row.key)), [activeSelectedRows]);
  const activeBatchReplaceFields = useMemo(
    () => buildBatchReplaceFields(activeSheetColumns, activeSelectedRows.length > 0 ? activeSelectedRows : visibleRows, t),
    [activeSelectedRows, activeSheetColumns, t, visibleRows],
  );

  function updateRowField(key: string, field: AccountBatchImportField, raw: string) {
    setRows((current) => {
      const edited = current.map((row) => (row.key === key ? applyRowEdit(row, field, raw) : row));
      return revalidateRows(edited, { groups, institutions, counterparties, categories: importCategories, accounts: importAccounts, baseCurrency, t });
    });
  }

  function updateVisibleSelection(keys: Set<string>) {
    const visibleKeySet = new Set(visibleRows.map((row) => row.key));
    setRows((current) => {
      const edited = current.map((row) => (
        visibleKeySet.has(row.key)
          ? { ...row, selected: keys.has(row.key), touchedSelection: true }
          : row
      ));
      return revalidateRows(edited, { groups, institutions, counterparties, categories: importCategories, accounts: importAccounts, baseCurrency, t });
    });
  }

  function applyBatchEdit(field: AccountBatchImportField, raw: string) {
    const targetKeys = new Set(visibleRows.filter((row) => row.selected && isRowFieldEditable(row, field)).map((row) => row.key));
    if (targetKeys.size === 0) throw new Error(t("statementImportPreview.selectRowsFirst"));
    setRows((current) => {
      const edited = current.map((row) => (targetKeys.has(row.key) ? applyRowEdit(row, field, raw) : row));
      return revalidateRows(edited, { groups, institutions, counterparties, categories: importCategories, accounts: importAccounts, baseCurrency, t });
    });
    return t("statementImportPreview.batchReplaceResult", {
      count: targetKeys.size,
      field: HEADER_LABELS[field](t),
      invalidSuffix: "",
    });
  }

  function goToSheet(index: number) {
    if (index < 0 || index >= sheetOptions.length) return;
    setActiveSheet(sheetOptions[index]);
  }

  function goNext() {
    if (!canGoNext) return;
    goToSheet(activeSheetIndex + 1);
  }

  function goPrev() {
    if (isFirstSheet) return;
    goToSheet(activeSheetIndex - 1);
  }

  function commonAccountGuideRows(): SheetGuideRow[] {
    return [
      ["owner", t("settings.accounts.import.guideOwnerValue"), t("settings.accounts.import.guideOwner")],
      ["currency", t("settings.accounts.import.guideCurrencyValue"), t("settings.accounts.import.guideCurrency")],
      ["numberMasked", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNumberMasked")],
      ["initialBalance", t("settings.accounts.import.guideNumberValue"), t("settings.accounts.import.guideBalance")],
      ["initialBalanceDate", "YYYY-MM-DD", t("settings.accounts.import.guideBalance")],
      ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
      ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
    ];
  }

  function guideRowsForSheet(sheetType: ImportSheetType): SheetGuideRow[] {
    if (sheetType === "institution") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideInstitutionName")],
        ["shortName", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideShortName")],
        ["institutionType", optionList(INSTITUTION_TYPE_OPTIONS, t), t("settings.accounts.import.guideInstitutionSheet")],
        ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
        ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
      ];
    }
    if (sheetType === "object") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideObjectName")],
        ["counterpartyType", optionList(OBJECT_TYPE_OPTIONS, t), t("settings.accounts.import.guideObjectSheet")],
        ["shortName", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideShortName")],
        ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
        ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
      ];
    }
    if (sheetType === "familyMember") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideFamilyMemberName")],
        ["shortName", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideShortName")],
        ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
        ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
      ];
    }
    if (sheetType === "counterparty") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideCounterpartyName")],
        ["counterpartyType", optionList(COUNTERPARTY_TYPE_OPTIONS, t), t("settings.accounts.import.guideCounterpartySheet")],
        ["shortName", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideShortName")],
        ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
        ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
      ];
    }
    if (sheetType === "category") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideCategoryName")],
        ["categoryType", optionList(CATEGORY_TYPE_OPTIONS, t), t("settings.accounts.import.guideCategoryType")],
        ["parentCategory", t("settings.accounts.import.guideParentCategoryValue"), t("settings.accounts.import.guideParentCategory")],
        ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
      ];
    }
    if (sheetType === "tag") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideTagName")],
        ["color", TAG_COLORS.join("\n"), t("settings.accounts.import.guideTagColor"), { firstValueOwnRow: true }],
        ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
      ];
    }
    if (sheetType === "funding") {
      const accountGuideRows = commonAccountGuideRows();
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideAccountName")],
        ["kind", optionList(FUNDING_ACCOUNT_KIND_OPTIONS, t), t("settings.accounts.import.guideFundingSheet")],
        ["institution", t("settings.accounts.import.guideInstitutionNameValue"), t("settings.accounts.import.guideFundingInstitution")],
        ...accountGuideRows.filter(([field]) => field !== "sample"),
        // 只有资金账户（含信用卡）有父子层级：父账户 / 账户级别两列只出现在本表。
        ["parent", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideParentAccount")],
        ["level", t("settings.accounts.import.accountLevelValue"), `${t("settings.accounts.import.accountLevelGuide")} ${t("settings.accounts.import.accountLevelSampleNote")}`],
        ["billingDay", t("entityForm.billingDayPlaceholder"), t("settings.accounts.import.guideCreditFields")],
        ["repaymentDay", "1-31", t("settings.accounts.import.guideRepaymentDay")],
        ["repaymentOffsetDays", "0-31", t("settings.accounts.import.guideRepaymentOffsetDays")],
        ["billingDayTxPeriod", optionList(BILLING_DAY_TX_PERIOD_OPTIONS, t), t("settings.accounts.import.guideCreditFields")],
        ["creditLimit", t("settings.accounts.import.guideNumberValue"), t("settings.accounts.import.guideCreditFields")],
        ["creditBillMode", optionList(CREDIT_BILL_MODE_OPTIONS, t), t("settings.accounts.import.guideCreditBillMode")],
        accountGuideRows.find(([field]) => field === "sample")!,
      ];
    }
    if (sheetType === "liability") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideAccountName")],
        ["kind", optionList(LIABILITY_KIND_OPTIONS, t), t("settings.accounts.import.guideLiabilitySheet")],
        ["institution", t("settings.accounts.import.guideInstitutionNameValue"), t("settings.accounts.import.guideSettlementInstitution")],
        ["counterparty", t("settings.accounts.import.guideCounterpartyValue"), t("settings.accounts.import.guideSettlementCounterparty")],
        ["loanCategory", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideLoanCategory")],
        ["loanType", optionList(LOAN_TYPE_OPTIONS, t), t("settings.accounts.import.guideLoanCategory")],
        ["isConsumerLoan", optionList(BOOLEAN_SELECT_OPTIONS, t), t("settings.accounts.import.guideLoanCategory")],
        ["liabilityDirection", optionList(LIABILITY_DIRECTION_OPTIONS, t), t("settings.accounts.import.guideSettlementCounterparty")],
        ...commonAccountGuideRows(),
      ];
    }
    if (sheetType === "investment") {
      return [
        ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideAccountName")],
        ["investProductType", optionList(INVEST_PRODUCT_OPTIONS, t), t("settings.accounts.import.guideInvestSubtype")],
        ["fixedAssetType", optionList(FIXED_ASSET_TYPE_OPTIONS, t), t("settings.accounts.import.guideFixedAssetSheet")],
        ["institution", t("settings.accounts.import.guideInstitutionNameValue"), t("settings.accounts.import.guideInvestmentInstitution")],
        ["owner", t("settings.accounts.import.guideOwnerValue"), t("settings.accounts.import.guideOwner")],
        ["currency", t("settings.accounts.import.guideCurrencyValue"), t("settings.accounts.import.guideCurrency")],
        ["fundUnitsDecimals", t("settings.accounts.import.guideNumberValue"), t("settings.accounts.import.guideInvestmentUnits")],
        ["costBasisMethod", optionList(COST_BASIS_OPTIONS, t), t("settings.accounts.import.guideInvestmentCostBasis")],
        ["tradingCalendar", optionList(TRADING_CALENDAR_OPTIONS, t), t("settings.accounts.import.guideInvestmentCostBasis")],
        ["defaultConfirmDays", t("settings.accounts.import.guideNumberValue"), t("settings.accounts.import.guideInvestmentUnits")],
        ["defaultArrivalDays", t("settings.accounts.import.guideNumberValue"), t("settings.accounts.import.guideInvestmentUnits")],
        ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
        ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
      ];
    }
    return [
      ["name", t("settings.accounts.import.guideRequiredValue"), t("settings.accounts.import.guideAccountName")],
      ["owner", t("settings.accounts.import.guideOwnerValue"), t("settings.accounts.import.guideOwner")],
      ["currency", t("settings.accounts.import.guideCurrencyValue"), t("settings.accounts.import.guideCurrency")],
      ["note", t("settings.accounts.import.guideOptionalValue"), t("settings.accounts.import.guideNoteText")],
      ["sample", t("settings.accounts.import.sampleRowYes"), t("settings.accounts.import.guideSampleRow")],
    ];
  }

  async function downloadTemplate() {
    const XLSX = await import("xlsx-js-style");
    const workbook = XLSX.utils.book_new();
    const owner = t("settings.accounts.importSampleFamilyMember");
    const spouse = t("settings.accounts.importSampleFamilyMemberSpouse");
    const counterparty = t("settings.accounts.importSampleCounterparty");
    const mmhCounterpartyShort = t("settings.accounts.importSampleMmhCounterpartyShort");
    const bankInstitution = t("settings.accounts.importSampleBankShort");
    const brokerageInstitution = t("settings.accounts.importSampleBrokerageShort");
    const fundCompanyInstitution = t("settings.accounts.importSampleFundCompanyShort");
    const paymentInstitution = t("settings.accounts.importSamplePaymentShort");
    const ewalletInstitution = t("settings.accounts.importSampleEwalletShort");
    // 简称与名称重复会命中「名称与简称不能相同」校验，这种情况示例只留名称。
    const sampleShortName = (name: string, short: string) =>
      normalizeImportHeader(name) === normalizeImportHeader(short) ? "" : short;
    const institutionSample = (nameKey: string, typeKey: string, shortKey: string) => {
      const name = t(nameKey);
      return { name, institutionType: t(typeKey), shortName: sampleShortName(name, t(shortKey)) };
    };
    const templateCategories = await fetchCategories().catch(() => []);
    const sheetByType = new Map(SHEETS.map((sheet) => [sheet.type, sheet]));
    const institutionSheet = sheetByType.get("institution")!;
    const familyMemberSheet = sheetByType.get("familyMember")!;
    const counterpartySheet = sheetByType.get("counterparty")!;
    const fundingSheet = sheetByType.get("funding")!;
    const liabilitySheet = sheetByType.get("liability")!;
    const investmentSheet = sheetByType.get("investment")!;

    appendStyledSheet(XLSX, workbook, t(institutionSheet.sheetKey), institutionSheet.type, institutionSheet.fields, [
      institutionSample("settings.accounts.importSampleBank", "institution.type.bank", "settings.accounts.importSampleBankShort"),
      institutionSample("settings.accounts.importSampleBankAlt", "institution.type.bank", "settings.accounts.importSampleBankAltShort"),
      institutionSample("settings.accounts.importSampleInsurance", "institution.type.insurance", "settings.accounts.importSampleInsuranceShort"),
      institutionSample("settings.accounts.importSampleBrokerage", "institution.type.brokerage", "settings.accounts.importSampleBrokerageShort"),
      institutionSample("settings.accounts.importSampleFundCompany", "institution.type.fund_company", "settings.accounts.importSampleFundCompanyShort"),
      institutionSample("settings.accounts.importSamplePayment", "institution.type.payment", "settings.accounts.importSamplePaymentShort"),
      institutionSample("settings.accounts.importSampleEwallet", "institution.type.payment", "settings.accounts.importSampleEwalletShort"),
      institutionSample("settings.accounts.importSampleLiabilityInstitution", "institution.type.other", "settings.accounts.importSampleLiabilityInstitutionShort"),
      institutionSample("settings.accounts.importSampleOtherInstitution", "institution.type.other", "settings.accounts.importSampleOtherInstitutionShort"),
    ], guideRowsForSheet("institution"), t);
    // 简称不能与名称相同（会命中「名称与简称不能相同」校验），家庭成员示例只给名称。
    appendStyledSheet(XLSX, workbook, t(familyMemberSheet.sheetKey), familyMemberSheet.type, familyMemberSheet.fields, [
      { name: owner },
      { name: spouse },
    ], guideRowsForSheet("familyMember"), t);
    appendStyledSheet(XLSX, workbook, t(counterpartySheet.sheetKey), counterpartySheet.type, counterpartySheet.fields, [
      {
        name: counterparty,
        counterpartyType: t("institution.type.person"),
        shortName: sampleShortName(counterparty, t("settings.accounts.importSampleCounterpartyShort")),
        isReimbursable: t("settings.accounts.import.yes"),
      },
      {
        name: t("settings.accounts.importSampleCounterpartyOrg"),
        counterpartyType: t("institution.type.organization"),
        shortName: sampleShortName(t("settings.accounts.importSampleCounterpartyOrg"), t("settings.accounts.importSampleCounterpartyOrgShort")),
      },
      {
        name: t("settings.accounts.importSampleMmhCounterparty"),
        counterpartyType: t("institution.type.organization"),
        shortName: sampleShortName(t("settings.accounts.importSampleMmhCounterparty"), mmhCounterpartyShort),
        sourceInstitution: bankInstitution,
      },
    ], guideRowsForSheet("counterparty"), t);
    appendStyledSheet(XLSX, workbook, t(fundingSheet.sheetKey), fundingSheet.type, fundingSheet.fields, [
      { name: t("settings.accounts.importSampleCash"), kind: t("account.kind.cash"), owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleDebit"), kind: t("account.kind.bank_debit"), institution: bankInstitution, owner, currency: baseCurrency, numberMasked: "1234", note: t("settings.accounts.importSampleNote") },
      { name: t("settings.accounts.importSampleWallet"), kind: t("account.kind.ewallet"), institution: paymentInstitution, owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleLooseChange"), kind: t("account.kind.ewallet"), institution: ewalletInstitution, owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleDeposit"), kind: t("account.kind.deposit"), institution: bankInstitution, owner, currency: baseCurrency },
      {
        name: t("settings.accounts.importSampleCredit"),
        kind: t("account.kind.bank_credit"),
        institution: bankInstitution,
        owner,
        currency: baseCurrency,
        numberMasked: "0000",
        billingDay: "1",
        repaymentDay: "25",
        creditLimit: "50000",
        creditBillMode: t("entityForm.creditBillMode.separate"),
      },
      // 多币种示例（2026-10-20）：父账户行币种留空（服务端锁本位币）、账户级别=父账户；
      // 子账户行填上级账户名 + 子户币种。父账户必须先存在，所以两行要分两次导入。
      { name: t("settings.accounts.importSampleMultiCurrencyParent"), kind: t("account.kind.cash"), owner, level: t("settings.accounts.import.accountLevelAggregate") },
      {
        name: t("settings.accounts.importSampleMultiCurrencyChild"),
        kind: t("account.kind.cash"),
        owner,
        currency: "JPY",
        parent: t("settings.accounts.importSampleMultiCurrencyParent"),
        level: t("settings.accounts.import.accountLevelNormal"),
      },
    ], guideRowsForSheet("funding"), t);
    // 贷款与往来款同表：贷款靠「贷款类别 + 机构」，往来款靠「往来对象 + 方向」。
    appendStyledSheet(XLSX, workbook, t(liabilitySheet.sheetKey), liabilitySheet.type, liabilitySheet.fields, [
      { name: t("settings.accounts.importSampleLoan"), kind: t("account.kind.loan"), institution: bankInstitution, loanCategory: t("loan.type.home"), loanType: t("loan.type.home"), owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleSettlementInstitution"), kind: t("account.kind.settlement"), counterparty: t("settings.accounts.importSampleCounterpartyOrg"), liabilityDirection: t("settings.accounts.import.directionPayable"), owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleMmhSettlementAccount"), kind: t("account.kind.settlement"), counterparty: mmhCounterpartyShort, liabilityDirection: t("settings.accounts.import.directionReceivable"), owner, currency: baseCurrency },
    ], guideRowsForSheet("liability"), t);
    // 固定资产并入投资账户：投资品类=固定资产 + 资产类型，库里没有独立 fixed_asset kind。
    appendStyledSheet(XLSX, workbook, t(investmentSheet.sheetKey), investmentSheet.type, investmentSheet.fields, [
      {
        name: t("settings.accounts.importSampleFund"),
        investProductType: t("investment.product.fund"),
        institution: fundCompanyInstitution,
        owner,
        currency: baseCurrency,
        fundUnitsDecimals: "2",
        costBasisMethod: t("settings.accounts.movingAverage"),
      },
      { name: t("settings.accounts.importSampleMoneyFund"), investProductType: t("investment.product.money"), institution: paymentInstitution, owner, currency: baseCurrency, fundUnitsDecimals: "2" },
      { name: t("settings.accounts.importSampleWealth"), investProductType: t("investment.product.wealth"), institution: bankInstitution, owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleMetal"), investProductType: t("investment.product.metal"), institution: bankInstitution, owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleInvestmentDeposit"), investProductType: t("investment.product.deposit"), institution: bankInstitution, owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleStock"), investProductType: t("investment.product.stock"), institution: brokerageInstitution, owner, currency: baseCurrency, costBasisMethod: t("settings.accounts.movingAverage") },
      { name: t("settings.accounts.importSampleFixedAsset"), investProductType: t("investment.product.property"), fixedAssetType: t("fixedAsset.type.property"), owner, currency: baseCurrency },
      { name: t("settings.accounts.importSampleVehicle"), investProductType: t("investment.product.property"), fixedAssetType: t("fixedAsset.type.vehicle"), owner, currency: baseCurrency },
    ], guideRowsForSheet("investment"), t);
    // 分类与标签不参与账户引用，放在最后，避免把「机构/对象 → 账户」的主线拆开。
    appendCategoryStyledSheet(XLSX, workbook, t("settings.accounts.import.sheet.category"), buildCategoryTemplateRows(templateCategories, t), t);
    const tagSheet = sheetByType.get("tag")!;
    const tagSwatches = new Map<string, GuideSwatch>(TAG_COLORS.map((color) => [color, { rgb: color.slice(1).toUpperCase(), name: t(TAG_COLOR_NAME_KEYS[color]) }]));
    appendStyledSheet(XLSX, workbook, t("settings.accounts.import.sheet.tag"), tagSheet.type, tagSheet.fields, [
      { name: t("settings.accounts.importSampleTagOne"), color: "#F59E0B" },
      { name: t("settings.accounts.importSampleTagTwo"), color: "#14B8A6" },
    ], guideRowsForSheet("tag"), t, tagSwatches);

    XLSX.writeFile(workbook, t("settings.accounts.importTemplateFile"), { compression: true });
  }

  async function handleFile(file: File) {
    setParseError("");
    setResult(null);
    setFileName(file.name);
    try {
      const categories = await fetchCategories();
      const accounts = await fetchExistingAccounts();
      const nextRows = await buildAccountImportRows(file, t, { groups, institutions, counterparties, categories, accounts, baseCurrency });
      setImportCategories(categories);
      setImportAccounts(accounts);
      if (nextRows.length === 0) {
        setRows([]);
        setActiveSheet("");
        setParseError(t("settings.accounts.import.noRows"));
      } else {
        setRows(nextRows);
        setActiveSheet(nextRows[0]?.sheet ?? "");
      }
      setOpen(true);
    } catch (error) {
      setRows([]);
      setActiveSheet("");
      setParseError(t("settings.accounts.import.readFailed", { reason: error instanceof Error ? error.message : String(error) }));
      setOpen(true);
    }
  }

  async function postJson(path: string, body: Record<string, unknown>) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    return { response, data };
  }

  async function importSelected() {
    if (importing || selectedRows.length === 0) return;
    if (selectedRowsWithErrors.length > 0) {
      setResult({
        created: 0,
        errors: selectedRowsWithErrors.map((row) => ({
          key: row.key,
          sheet: row.sheet,
          sourceRow: row.sourceRow,
          name: row.name,
          message: row.errors.join(" / ") || t("settings.accounts.import.rowFailed"),
        })),
      });
      return;
    }
    setImporting(true);
    setResult(null);
    const created: ImportAccountRow[] = [];
    const errors: ImportResult["errors"] = [];
    const institutionIds = mapByName(institutions);
    const counterpartyIds = mapByName(counterparties);
    const ownerIds = mapByName(groups);
    // 分类名称只在同一收支类型内唯一（收入/支出各可有一个「棋牌」），
    // 所以命中索引必须带 type，否则会把收入分类当成支出分类跳过或错挂父级。
    const categoryList = await fetchCategories();
    const categoryIdsByTypeName = new Map<string, string>();
    for (const category of categoryList) {
      categoryIdsByTypeName.set(`${category.type}:${normalizeImportHeader(category.name)}`, category.id);
    }
    const tagIds = mapByName(await fetchExistingTags());
    // 贷款类别：内置类别的显示名走 i18n，所以同时按「存储名」和「本地化名」建索引。
    const loanCategoryIds = new Map<string, string>();
    for (const category of await fetchLoanCategories()) {
      loanCategoryIds.set(normalizeImportHeader(category.name), category.id);
      const localized = t(`loan.type.${category.baseType}`);
      if (localized) loanCategoryIds.set(normalizeImportHeader(localized), category.id);
    }

    for (const target of [...MASTER_TARGETS, "account"] as ImportTarget[]) {
      for (const row of selectedRows.filter((item) => item.target === target)) {
        try {
          let path = "/api/v1/accounts";
          let body: Record<string, unknown>;
          if (row.target === "institution") {
            path = "/api/v1/institution";
            body = { name: row.name, type: row.institutionType, shortName: row.shortName };
          } else if (row.target === "counterparty") {
            path = "/api/v1/counterparty";
            body = {
              name: row.name,
              type: row.counterpartyType,
              shortName: row.shortName,
              isReimbursable: row.isReimbursable || undefined,
              sourceInstitutionId: row.sourceInstitutionName
                ? institutionIds.get(normalizeImportHeader(row.sourceInstitutionName))
                : undefined,
            };
          } else if (row.target === "familyMember") {
            path = "/api/v1/account-group";
            body = { name: row.name, shortName: row.shortName };
          } else if (row.target === "tag") {
            const existingTagId = tagIds.get(normalizeImportHeader(row.name));
            if (existingTagId) {
              continue;
            }
            path = "/api/v1/tags";
            body = { name: row.name, color: row.color || undefined };
          } else if (row.target === "category") {
            const categoryKey = (name: string) => `${row.categoryType}:${normalizeImportHeader(name)}`;
            const existingCategoryId = categoryIdsByTypeName.get(categoryKey(row.name));
            if (existingCategoryId) {
              continue;
            }
            path = "/api/v1/category";
            body = {
              name: row.name,
              type: row.categoryType,
              parentId: row.parentCategoryId || categoryIdsByTypeName.get(categoryKey(row.parentCategoryName)) || "",
            };
          } else {
            const institutionId = row.institutionId || institutionIds.get(normalizeImportHeader(row.institutionName)) || "";
            const counterpartyId = row.counterpartyId || counterpartyIds.get(normalizeImportHeader(row.counterpartyName)) || "";
            const ownerId = row.ownerId || ownerIds.get(normalizeImportHeader(row.ownerName)) || "";
            if (row.institutionName && !institutionId) {
              errors.push({ key: row.key, sheet: row.sheet, sourceRow: row.sourceRow, name: row.name, message: t("settings.accounts.import.institutionNotFound") });
              continue;
            }
            if (row.counterpartyName && !counterpartyId) {
              errors.push({ key: row.key, sheet: row.sheet, sourceRow: row.sourceRow, name: row.name, message: t("settings.accounts.import.counterpartyNotFound") });
              continue;
            }
            if (row.ownerName && !ownerId) {
              errors.push({ key: row.key, sheet: row.sheet, sourceRow: row.sourceRow, name: row.name, message: t("settings.accounts.import.ownerNotFound") });
              continue;
            }
            // 贷款账户：类别必选，且必须命中本账簿已有类别（找不到就报错不导）。
            let loanCategoryId = "";
            if (row.kind === "loan") {
              loanCategoryId = loanCategoryIds.get(normalizeImportHeader(row.loanCategory)) || "";
              if (!loanCategoryId) {
                errors.push({
                  key: row.key,
                  sheet: row.sheet,
                  sourceRow: row.sourceRow,
                  name: row.name,
                  message: t("settings.accounts.import.loanCategoryRequired"),
                });
                continue;
              }
            }
            if (row.parentName && !row.parentAccountId) {
              errors.push({
                key: row.key,
                sheet: row.sheet,
                sourceRow: row.sourceRow,
                name: row.name,
                message: t("settings.accounts.import.parentAccountNotFound", { name: row.parentName }),
              });
              continue;
            }
            // 父账户是统计单元：不提交上级、币种（服务端锁本位币）、卡号/账单/额度/期初余额。
            const aggregateRow = row.accountLevel === "aggregate";
            body = {
              name: row.name,
              isAggregate: aggregateRow || undefined,
              parentId: aggregateRow ? undefined : (row.parentAccountId || undefined),
              loanCategoryId: loanCategoryId || undefined,
              kind: row.kind === "fixed_asset" ? "investment" : row.kind,
              investProductType: row.kind === "fixed_asset" ? "property" : row.investProductType,
              fixedAssetType: row.kind === "fixed_asset" ? row.fixedAssetType : undefined,
              loanType: row.loanType || undefined,
              isConsumerLoan: row.isConsumerLoan || undefined,
              liabilityDirection: row.liabilityDirection || undefined,
              institutionId,
              counterpartyId,
              groupId: ownerId,
              currency: aggregateRow ? undefined : row.currency,
              numberMasked: aggregateRow ? undefined : row.numberMasked,
              billingDay: aggregateRow ? undefined : row.billingDay,
              repaymentDay: aggregateRow ? undefined : row.repaymentDay,
              // 还款日优先：填了还款日就不提交偏移天数，否则服务端会按「账单日 + N 天」覆盖还款日。
              repaymentOffsetDays: aggregateRow || row.repaymentDay ? undefined : row.repaymentOffsetDays || undefined,
              billingDayTxPeriod: aggregateRow ? undefined : row.billingDayTxPeriod || undefined,
              creditLimit: aggregateRow ? undefined : row.creditLimit,
              creditBillMode: aggregateRow ? undefined : row.creditBillMode,
              fundUnitsDecimals: row.fundUnitsDecimals,
              costBasisMethod: row.costBasisMethod,
              tradingCalendar: row.tradingCalendar,
              defaultConfirmDays: row.defaultConfirmDays || undefined,
              defaultArrivalDays: row.defaultArrivalDays || undefined,
              initialBalance: aggregateRow ? undefined : row.initialBalance,
              initialBalanceDate: aggregateRow ? undefined : row.initialBalanceDate,
              note: row.note,
            };
          }
          const { response, data } = await postJson(path, body);
          if (!response.ok || data?.ok === false) {
            errors.push({ key: row.key, sheet: row.sheet, sourceRow: row.sourceRow, name: row.name, message: data?.error || t("settings.accounts.import.rowFailed") });
          } else {
            created.push(row);
            if (row.target === "institution") {
              const id = createdEntityId(data, "institution");
              if (id) {
                institutionIds.set(normalizeImportHeader(row.name), id);
                if (row.shortName) institutionIds.set(normalizeImportHeader(row.shortName), id);
              }
            }
            if (row.target === "counterparty") {
              const id = createdEntityId(data, "counterparty");
              if (id) {
                counterpartyIds.set(normalizeImportHeader(row.name), id);
                if (row.shortName) counterpartyIds.set(normalizeImportHeader(row.shortName), id);
              }
            }
            if (row.target === "familyMember") {
              const id = createdEntityId(data, "group");
              if (id) {
                ownerIds.set(normalizeImportHeader(row.name), id);
                if (row.shortName) ownerIds.set(normalizeImportHeader(row.shortName), id);
              }
            }
            if (row.target === "category") {
              const id = createdEntityId(data, "category");
              if (id) categoryIdsByTypeName.set(`${row.categoryType}:${normalizeImportHeader(row.name)}`, id);
            }
            if (row.target === "tag") {
              const id = createdEntityId(data, "tag");
              if (id) tagIds.set(normalizeImportHeader(row.name), id);
            }
          }
        } catch (error) {
          errors.push({ key: row.key, sheet: row.sheet, sourceRow: row.sourceRow, name: row.name, message: error instanceof Error ? error.message : t("settings.accounts.import.rowFailed") });
        }
      }
    }
    setResult({ created: created.length, errors });
    setImporting(false);
    if (created.length > 0) onImported();
  }

  function close() {
    if (importing) return;
    setOpen(false);
    setFileName("");
    setParseError("");
    setRows([]);
    setActiveSheet("");
    setResult(null);
  }

  const dialog = open ? createPortal(
    <ModalLayer className="fixed inset-0 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={close}>
      <div
        data-batch-popover-boundary
        className="flex h-[86vh] w-[1120px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-slate-800">{t("settings.accounts.import.previewTitle")}</div>
            <div className="mt-1 text-xs text-slate-500">{fileName || t("settings.accounts.import.emptyFile")}</div>
          </div>
          <button type="button" onClick={close} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" aria-label={t("table.close")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {parseError && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{parseError}</div>}
        {result && (
          <div className={`border-b px-4 py-2 text-xs ${result.errors.length > 0 ? "border-amber-100 bg-amber-50 text-amber-800" : "border-emerald-100 bg-emerald-50 text-emerald-700"}`}>
            <div>{t("settings.accounts.import.result", { created: result.created, errors: result.errors.length })}</div>
            {result.errors.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {result.errors.slice(0, 5).map((error) => (
                  <div key={error.key}>{error.sheet} #{error.sourceRow} · {error.name}: {error.message}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {rows.length > 0 ? (
          <>
            {sheetOptions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-2">
                {sheetOptions.map((sheetName) => {
                  const stat = sheetStats.get(sheetName);
                  const isActive = sheetName === activeSheet;
                  const errors = stat?.errors ?? 0;
                  const total = stat?.total ?? 0;
                  const selected = stat?.selected ?? 0;
                  return (
                    <button
                      key={sheetName}
                      type="button"
                      onClick={() => setActiveSheet(sheetName)}
                      title={errors > 0 ? t("settings.accounts.import.sheetErrorCount", { count: errors }) : undefined}
                      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
                        isActive ? "border-blue-600 bg-blue-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      {sheetName}
                      {errors > 0 ? (
                        <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-medium ${isActive ? "bg-white text-red-600" : "bg-red-600 text-white"}`}>
                          {errors}
                        </span>
                      ) : (
                        <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none ${isActive ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"}`}>
                          {total > 0 && selected > 0 && selected < total ? `${selected}/${total}` : total}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <PreviewTable
                rows={visibleRows}
                columns={activeSheetColumns}
                importing={importing}
                selectedKeys={visibleSelectedKeys}
                batchReplaceFields={activeBatchReplaceFields}
                batchTargetCount={activeSelectedRows.length}
                resetKey={`${normalizeImportHeader(activeSheet || visibleRows[0]?.sheet || "preview")}:${activeSheetColumns.join("|")}`}
                t={t}
                onSelectionChange={updateVisibleSelection}
                onEditField={updateRowField}
                onBatchEdit={applyBatchEdit}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700">
                  {t("settings.accounts.import.stepProgress", { current: activeSheetIndex + 1, total: sheetOptions.length })}
                </span>
                <span aria-hidden>·</span>
                <span>{activeSheet}</span>
                <span aria-hidden>·</span>
                <span>{t("settings.accounts.import.selectedCount", { selected: activeSheetSelected, total: activeSheetStats?.total ?? 0 })}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={isFirstSheet || importing}
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("settings.accounts.import.prevSheet")}
                </button>
                {!isLastSheet ? (
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!canGoNext || importing}
                    className="h-9 rounded-md bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("settings.accounts.import.nextSheet")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={importSelected}
                    disabled={!canImport || importing}
                    className="h-9 rounded-md bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {importing ? t("batchImport.importing") : t("settings.accounts.import.confirmImport")}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="px-4 py-12 text-center text-sm text-slate-400">{t("settings.accounts.import.noPreview")}</div>
        )}
      </div>
    </ModalLayer>,
    document.body,
  ) : null;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".xlsx,.xls"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        title={exportTemplateTitle}
        onClick={() => void downloadTemplate()}
        className={`inline-flex ${compact ? "h-7" : "h-8"} shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm transition-colors hover:bg-slate-50`}
      >
        <Download className="h-3.5 w-3.5" />
        {t("settings.accounts.exportTemplate")}
      </button>
      <button
        type="button"
        title={importExcelTitle}
        onClick={() => fileInputRef.current?.click()}
        className={`inline-flex ${compact ? "h-7" : "h-8"} shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm transition-colors hover:bg-blue-50`}
      >
        <FileUp className="h-3.5 w-3.5" />
        {t("settings.accounts.importExcel")}
      </button>
      {dialog}
    </>
  );
}
