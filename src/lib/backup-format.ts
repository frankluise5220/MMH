/**
 * 备份包格式常量（客户端/服务端共享，禁止引入服务端依赖）。
 *
 * `BACKUP_FORMAT_VERSION` 的唯一权威定义在这里；`src/lib/server/backup.ts`
 * re-export 它，`scripts/check-backup-package.cjs` 扫描本文件确认版本号。
 * 客户端（恢复确认弹窗）拿它判断「备份是否来自更新版本」。
 */
export const BACKUP_FORMAT_VERSION = 6;

/**
 * 当前恢复端认识的备份 `data` 顶层键集合。
 *
 * 必须与 `src/lib/server/backup.ts` 的 `parseBackupPayload` 显式解析的键保持
 * 一致（含 `debtAgreements` 旧键名）；`scripts/check-backup-package.cjs`
 * 扫描两个文件比对，防止一边加表另一边漏同步。
 *
 * 客户端用它算出「包里有、当前版本不认识」的表：这些数据恢复时会被服务端
 * 静默忽略，必须在恢复确认弹窗里向用户点名提醒。
 */
export const KNOWN_BACKUP_DATA_TABLES = [
  "household",
  "systemSettings",
  "accessKeys",
  "aiChannels",
  "aiModels",
  "users",
  "userSettings",
  "householdPreferences",
  "accountGroups",
  "institutions",
  "counterparties",
  "categories",
  "tags",
  "insuranceProductMasters",
  "wealthProducts",
  "depositProducts",
  "bondProducts",
  "repoProductCustoms",
  "accounts",
  "accountAliases",
  "billOverrides",
  "creditCardCycles",
  "creditCardInstallmentPlans",
  "creditCardBillingDays",
  "fundConfirmDays",
  "fundFeeRates",
  "fundHoldings",
  "preciousMetalTypes",
  "preciousMetalUnits",
  "preciousMetalHoldings",
  "loanRateAdjustments",
  "loanCategories",
  "settlementAgreements",
  "debtAgreements",
  "reimbursements",
  "reimbursementBatches",
  "reimbursementItems",
  "reimbursementTransactions",
  "reimbursementSettlements",
  "reimbursementSettlementTransactions",
  "fundQueryApis",
  "statementRecognitionRules",
  "statementCategoryRules",
  "regularInvestPlans",
  "importBatches",
  "transactions",
  "fxRates",
  "fxConversions",
  "insuranceProducts",
  "fundTransactions",
  "fundTransactionCashFlows",
  "insuranceTransactions",
  "wealthTransactions",
  "depositTransactions",
  "bondTransactions",
  "preciousMetalTransactions",
  "stockSecurities",
  "stockHoldings",
  "stockTransactions",
  "stockPriceCache",
  "stockFeeRules",
  "stockMarketFeeRules",
  "propertyAssets",
  "propertyValuations",
  "propertyTransactions",
  "entryBusinessLinks",
  "fundNavCaches",
  "fundSnapshots",
  "stockBrokerageCatalogs",
  "approvedCurrencies",
  "customCurrencyRequests",
  "distillLogs",
  "commandTestResults",
  "commandAliases",
  "attachments",
  "entryTags",
  "emailAccounts",
  "statementMailAutoImports",
] as const;
