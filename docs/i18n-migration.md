# 存量中文字面量迁移手册

本文件是 `AGENTS.md`「Language And Internationalization」的执行细则，用于把 `src/` 下存量中文字面量迁移到 i18n 层。目标不是一次性清空全部存量，而是：**新增/改动的代码不再产生中文字面量，改到哪迁移到哪**。

## 现状基线（2026-08 盘点）

- 约 357 个 `src` 文件含中文（8914 行），分为：
  - 组件 UI 文案（86 文件 / 3194 行）→ `t()` 键
  - API 路由（125 文件 / 2260 行）→ 错误串加稳定 `code`，注释改英文
  - 页面（38 文件 / 1806 行）→ `t()` 键
  - lib 逻辑（107 文件 / 1656 行）→ 注释改英文，业务值保留

## 迁移分类（先分类，再动手）

### 1. UI 文案 → `t()` 键（必须迁移）

组件/页面里任何用户可见文字：标签、按钮、标题、占位符、弹窗、空态、toast、表头、确认语、`window.alert`、`title`/`aria-label`、错误兜底串（`throw new Error(data?.error ?? "中文")`、`setError("中文")`）。

### 2. 注释 / JSDoc → 英文（顺带迁移）

改动的文件里，中文注释和 JSDoc 一并改成英文。

### 3. 业务数据 / 匹配值 → 保留（不迁移）

- 用户录入或入库的值：分类名、`"未指定"`、`"支出."` 前缀、`"年"/"月"/"日"` 日期解析、导入表头匹配串。
- 外部内容与测试夹具。
- 判定方法：删掉该字符串后产品语义是否改变。会改变 → 数据，保留；只影响显示 → 文案，迁移。

## 键命名规范

- 点分命名空间 `module.area.key`，新模块用短前缀，例如 `stockFee.*`、`txForm.*`、`fundShell.*`。
- 先查 `src/lib/i18n.ts` 是否已有同义键（如 `table.empty`、`common.save`、`detail.column.date`），优先复用。
- 占位符用 `{name}` 花括号；中文值里也用同一套占位符。

## 每文件工作流

1. **先加键，后替换**。`translate()` 缺失键回退链：目标语言 → `zh-CN` → 原样返回键名。新键必须同时出现在三个目录（`zh-CN`、`en-US`、`ja-JP`），缺任何一个目录都是缺陷。
2. 组件顶部 `const { t, language } = useI18n();`（`import { useI18n } from "@/lib/i18n";`）。
3. 替换字面量为 `t("key")`。
4. **服务端组件（无 `"use client"`，导入 prisma/cookies 的页面）**：不能用 `useI18n()`。用 `import { getServerT } from "@/lib/server/i18n";` + `const t = await getServerT();`（Next 16 的 `cookies()` 是异步的）。i18n 结构：`src/lib/i18n-core.ts` 是纯函数核心（目录 + `translate`，服务端可导入）；`src/lib/i18n.ts` 是客户端壳（`useI18n` hook）；`src/lib/server/i18n.ts` 是服务端助手（读语言 cookie）。新增键时三目录都在 `i18n-core.ts` 里维护。
5. **参数插值**：`t(key, params)` 支持 `{name}` 占位符替换（2026-08 加入），例如 `t("overview.accountCountValue", { count: debtAccounts.length })`。带占位符的键必须传参，否则界面显示原始占位符。
6. 数字格式化用当前语言：`toLocaleString(language, ...)`，不要写死 `"zh-CN"`。
7. 选项列表模式：常量数组存 `labelKey` 而不是 `label`，渲染处 `t(item.labelKey)`；解析函数收 `t` 参数：
   ```ts
   const OPTIONS = [
     { value: "commission", labelKey: "stockFee.feeType.commission" },
   ] as const;
   function optionLabel(t: (k: string) => string, options: readonly { value: string; labelKey: string }[], value?: string | null) {
     const item = options.find((entry) => entry.value === value);
     return item ? t(item.labelKey) : value ?? "-";
   }
   ```
8. API 错误串：**加稳定英文 `code` 字段（附加式，向后兼容），`error` 暂保留中文**——错误会直接显示给中文用户，粗暴改英文是 UX 回归。客户端以 `code` 做逻辑，错误文案本地化后续再做。路由顶部 JSDoc 改英文。
9. 完成后验证：
   - `npm run check:encoding`
   - `npm run codex:rg -- --regex "[\u4e00-\u9fff]" <改动文件>` 确认除数据值外无残留（无 rg 时用 PowerShell `Select-String`）
   - 新增 `t("key")` 在三个目录（`zh-CN`、`en-US`、`ja-JP`）都存在

## 中心合并工具（子代理批次用）

- 子代理只改组件文件，**不碰 `src/lib/i18n.ts`**；它们返回 `{"keys":[{key,zh,en,ja}]}` JSON。
- 主代理用 `_tmp_merge_i18n.cjs`（gitignored 临时脚本）把键合并进三个目录：读取 `_tmp_i18n_keys.json` → 清理旧键行 → 按目录闭合符正确插入（从最后一个目录往前插入，避免位置漂移）。
- 注意：正则定位目录闭合符必须用 `/\n  },(?=\n)/g`，避免误匹配 `useEffect` 的 `}, []);`。

## 参照实现

- `src/components/StockFeeRuleSettingsButton.tsx` — 完整迁移（46 个 `stockFee.*` 键），含选项 `labelKey` 模式、错误兜底串、locale 透传，是组件类迁移的模板。
- `src/components/DateStepper.tsx` — 最简示例（3 个 `dateStepper.*` 键，仅 title/aria-label）。
- `src/components/OverviewDashboard.tsx` — 参数插值示例（`overview.accountCountValue`、`overview.costTitle`），含子组件内独立调用 `useI18n()` 的写法。

## 进度（2026-08）

### 第 20–21 轮（本轮）

新增迁移（0 中文残留，均经 tsc + 三目录平衡 + check:encoding 验证）：

- 批 1（124 键）：`StockTransactionFormModal`（保留 2 行数据：`part !== "股票账户"` 匹配、auto-create 的 `name: "股票账户"` 存储默认名）、`EntityCreateForm`（0 残留）。
- 批 3（116 键）：`DepositFormModal`（0 残留）、`CreditBillSummaryTable`（0 残留）、`InitModal`（0 残留）。
- 批 4 sweep（194 键，36 个小组件）：`AccountFxRateInline`、`AddNavButton`、`AdvancedDataTable`、`BackgroundTaskStatusBar`、`BatchReplacePopoverButton`、`CreditBillMailImportButton`、`DailyPnlCalendar`、`DailyTaskCheck`、`DebitBalanceReconcileButton`、`DetailTablePaginationControls`、`EditBillAmount`、`FillNavButton`、`HoldingPicker`、`IncomeExpenseReportClient`、`InstitutionEditButton`、`InsuranceEntryEditBridge`、`InsuranceEntryEditModal`、`InsurancePolicyDeleteModal`、`InsurancePolicyEditModal`、`InvestHeaderSync`、`InvestmentProfitScopeSelect`、`LanguageSwitcher`、`NewLedgerSetupCheck`、`RefreshNavButton`、`ReportDetailTable`、`ReportResizableSplit`、`ReportTransactionEditHost`、`ResizableVerticalSplit`、`SmartSelect`、`StatisticsFilterPanel`、`TopEntryLauncher`、`UndoLastOperationButton`、`UnifiedEntryLauncher` 等（保留项：`EntryRowActions` 的 `"已取消删除"` 错误串匹配、`UnifiedEntryLauncher` 的 `remark: "银证转账"` 记录备注、`AdvancedDataTable` 的 `action.label.includes("删除"/"编辑"/…)` 图标推断匹配）。
- 主代理自修：`TopEntryLauncher` 缺失键 `topEntry.fx` 改为 `entry.kind.fx`；`UnifiedEntryLauncher` 的 fallback `"记账"`/`"更多记账入口"` 改为 `entry.kind.transaction`/`entryLauncher.more`；`StatisticsCharts` 的 Y 轴 `万` 改为 `common.compactUnit`（zh/ja=`万`，en=`K`，注意 en 除数是 1000 由调用方处理）；`InsuranceOverviewCard` 的 `formatCompactMoney` 线程化 `t` 参数；补 `propertyForm.marketValue`、`debtTx.autoDebitLabel/Hint` 三语遗漏键；`undo.*` 键补齐。

### 第 22 轮（高峰时段收尾）

高峰前启动的 5 个代理全部交付并合并，目录平衡 2931/2931/2931，全项目 0 缺失键：

- 批 2（81 键）：`InsuranceFormModal`（0 残留，`PRODUCT_TYPE_OPTIONS` 改为 `insuranceProduct.type.*` labelKey 模式，与 b5 共享同命名空间）、`StatementImportPreviewDialog`（10 行数据保留：年月日解析正则、银联方向正则、信用卡候选名模式）。
- API codes 批（147 code，8 路由）：`category`（21）、`fx-conversions`（16）、`init`（2）、`settings/backup`（19）、`entries/batch-update`（18）、`entries/delete`（5）、`fund/entry`（6）、`insurance-products`（60）。均保留中文 error、加稳定英文 code；JSDoc 转英文。
- b7（65 键）：`(sidebar)/page.tsx` 服务端组件主页面（getServerT；`"use server"` actions 内用 `const t = await getServerT()`），8 行数据保留（LPR 正则、根分类名集合、`未指定账户`/`未指定` 存储名）。
- b5（22 键 + 补 3 键）：`BasicDetailSelection`（0 残留）、`InsuranceProductEditModal`（0 残留，复用 `insuranceProduct.type.*`，新增 `insuranceProductEdit.*` 与 `insuranceProduct.accountingType.*`）。
- b6（255 键）：`settings/email/page.tsx`（0 残留）、`settings/database/page.tsx`（0 残留）。

主代理修复：批 2 交付遗漏的 `insuranceProduct.accountingType.asset/protection/hybrid` 三语补齐。

### 第 31–32 轮（空闲窗口恢复后）

目标从 blocked 恢复（轮次上限提升至 45），空闲窗口内完成 8 个代理批 + 主代理自修，目录平衡 **3763/3763/3763**，全项目 0 缺失键，全量 tsc 0 错误：

- API 批 2–8（约 50 路由，380+ code）：regular-invest、settings/users、stocks/transactions、loan-repayment/recalculate、settings/delete、bill/installment、fund/nav、regular-invest/execute、db/data、auth/verify、system-update、ai-config、bill/cycle、batch-execute、record/ingest、properties、password-status、fund/position、email-accounts、password-reset、bill/override、access-keys、create-ledger、loan-rate、fee-rate、factory-reset、fee-rules、holdings、account-group、valuations、imap×4、undo、fx-rates、settings/email、wealth-products、statement/import、fund/name、nav/history、nav/missing、shell-data、auto-execute、batch-execute-test、link-cash-flow、test-send、resend、revalidate、income-expense/detail、init、securities、statement/parse、imported-mail、ai/import、ai/models、fund/refresh、preload-nav、fund/entries、debug×4、resend/test、integrity、command-aliases、overview/summary 等。内部 helper 返回（非 NextResponse）不含 code，正确保留。
- 页面批 b8+b9（9 页面，382 键）：accounts/quick-add、accounts/page、batch-import、settings/system-update、ledgers、users、insurance、reports、settings/display。剩余中文均为数据（BANK_NAMES 机构名、导入表头契约、服务端步骤 key、模板 token、文件名）。
- lib 批 1–3（40 文件）：注释/JSDoc 转英文；数据值（AI prompt、正则、关键词映射、默认分类/机构名、错误串）保留。
- b10+b11+b12（11 组件，366 键）：AIPanel、RegularInvestClient、SidebarClient、MobileTransactions、DbClient、settings/ai、settings/categories、settings/insurance-products、mobile×4。自修 MobileOverviewDashboard 的 MobileSectionHeader t 参数线程化、MobileNavigation 类型引用。
- 自修 accounts/[accountId] 服务端页面（3 键）。
- 修复 Prisma client 过期类型（`manualNav`/`manualNavDate` 重新 generate）。

已迁移（0 中文残留）：`StockFeeRuleSettingsButton`、`DateStepper`、`OverviewDashboard`、`MissingFundNavPrompt`、`PropertyShell`、`StockHoldingReport`、`InvestmentProfitReport`、`CalcInput`、`LiabilitiesGuideClient`、`StatisticsCharts`、`CreditBillDetailPanel`、`SettingsDeleteButton`、`BasicDetailPanel`、`DebtShell`、`TransactionFormModal`、`LedgerSwitcher`、`TableColumnFilter`、`FirstUseGuide`、`ViewExcelImportMenuButton`、`DetailViewClient`、`InsuranceShell`、`StockHoldingsPanel`（22 个组件，约 1100 个三语键）。`InsuranceOverviewCard`、`DepositShell` 各剩 1 行数据/匹配值保留；`DebtShell` 保留 3 行 DB 匹配值；`TransactionFormModal` 保留 7 行数据；`ViewExcelImportMenuButton` 保留 10 行导入契约；`DetailViewClient` 保留 5 行数据；`StockHoldingsPanel` 保留 1 行（`"银证转账"` 记录备注）。

服务端组件（sidebar 页面）迁移用 `getServerT()`：`import { getServerT } from "@/lib/server/i18n";` + `const t = await getServerT();`。i18n 三件套：`i18n-core.ts`（纯核心，服务端可导入）/ `i18n.ts`（客户端壳）/ `server/i18n.ts`（服务端助手）。合并脚本目标已改为 `src/lib/i18n-core.ts`。

子代理键交付流程（已验证）：代理只改组件并返回键 JSON → 主代理让代理把 JSON 直接写入 `_tmp_i18n_keys_*.json` → `node _tmp_merge_i18n.cjs <文件>` 合并三目录。避免手抄错误。

数据 vs 文案的实战案例：
- `ViewExcelImportMenuButton` 的 `NORMAL_HEADERS`（中文表头数组）是**导入识别契约**——解析器按中文字段名匹配旧文件，不能迁移；模板内样本数据（餐饮/麦当劳等）是数据保留。
- `DetailViewClient` 的 `"还贷款"` 备注匹配、`linkedBusinessLabels.includes("理财交易")` 业务类型标签比较是数据保留；模块级标签函数迁移需把 `t` 作为参数传入（不能在模块作用域调 useI18n）。
- `StatisticsCharts` 的 `+` 前缀判断从 `c.label !== "总支出"` 改为稳定 `kind` 字段。

统计图表注意点：汇总卡片上的 `+` 前缀判断曾用 `c.label !== "总支出"` 比较中文标签，迁移时改为卡片对象的稳定 `kind` 字段（`c.kind !== "expense"`），避免依赖本地化标签。

### 第 31 轮（空闲窗口继续）

- b13（38 键）：`MobileTransactionForm`（22 行错误串/弹窗文案 → mobileTxForm.*）、`lib/client/colors.ts`（注释英文化）、`lib/api/entries-delete.ts`（弹窗文案 → entriesDelete.*，`已取消删除` 匹配契约保留）、`lib/server/household-scope.ts`（注释英文化 + 错误模板英文化，DB 种子数据保留）、`lib/account-kinds.tsx`（新增 t-aware `kindLabel(k, t?)`/`institutionTypeLabel(type, t?)`，无 t 调用方保留中文 label 数据 map）。
- 主代理自修：10 个小 API 路由补 code（statistics、accounts/investment、entries/purge、settings/bootstrap、settings/catalog、settings/color-scheme、statement/category-rules、statement/recognition-rules、regular-invest/records、reports/stock-holdings）。

目录平衡 **3801/3801/3801**，全项目 0 缺失键，全量 tsc 0 错误，check:encoding 636 文件 OK。全局中文行 **3446**（自 8914 下降 61.3%）。

### 第 32 轮

- 自修 `app/test-results/page.tsx`（15 键）：调试页面 UI 文案 → testResults.*（getServerT）。
- lib 批 4（16 文件）：auth/encrypt、client/useOutsideClose、server/cached-data、server/auth 等注释英文化；mail/passwordReset、mail/resend、mail/smtp、server/placeholder-account、server/import-debt-account、statement/preview-meta、stock/securities、fund-actions、ai/config 等注释转英文、数据值（邮件模板、错误串、存储账户名、正则、渠道标签）保留；ai/client、mail/imap-client、fund/regular-invest-display 纯数据文件验证后未改。

目录平衡 **3816/3816/3816**，全项目 0 缺失键，全量 tsc 0 错误，check:encoding 636 文件 OK。全局中文行 **3371**（自 8914 下降 62.2%），含中文文件 248/460。

### 第 33 轮

- 路由注释批（19 文件，70 条注释行）：households、household-password-status、cleanup/dividend-cash、fund/entry、entries/purge、transactions/detail、db/models、entries/batch-edit、settings/email/status、settings/bootstrap、settings/color-scheme、statement/import、onboarding/status、precious-metals/dictionaries、households/switch、entries/delete、accounts/recalc-balances、record/ingest、accounts/internal 的中文 JSDoc/注释全部英文化；错误串、正则、匹配值（`现金红利` startsWith、`金额`/`改成` 正则、MODEL_CN 标题等）原样保留。
- 全项目注释类中文清零：仅剩 4 处英文注释中引用中文数据模式（`"限制"` 状态值、`"XX的往来款"` 模式、`"空白"` 存储名）——数据契约引用，正确保留。

目录平衡 **3817/3817/3817**，全项目 0 缺失键，全量 tsc 0 错误，check:encoding 636 文件 OK。全局中文行 **3270**（自 8914 下降 63.3%），含中文文件 245/460。

### 第 34 轮

- 终审修复最后残留的 JSX 渲染文案：`DebtTransactionModal` 的 5 个还款方式 `<option>` 显示文本 → `debtTx.method.*` 键（5 键：等额本息/等额本金/自由还款/先还利息一次性还本/免息分期还本），value 保留中文数据。
- **全项目 JSX 渲染中文清零（0 处）**——所有用户可见 UI 文本均已走 i18n。
- 系统终审确认：剩余中文全部为 AGENTS.md 第 3、4 条的数据类别（DB 分类/机构名、AI prompt、命令正则、商户规则、导入契约、API 错误串、匹配值、邮件模板），无遗漏 UI 文案或注释。

目录平衡 **3822/3822/3822**，全项目 0 缺失键，全量 tsc 0 错误，check:encoding 636 文件 OK。全局中文行 **3270**（自 8914 下降 63.3%），含中文文件 245/460。

### 第 35 轮（收尾清扫）

- `urlInput.ts`：`PORT_SUGGESTIONS` 的 `label`/`description` 中文字段改为 `labelKey`（新增 `urlInput.portSuggestion.*` 三语键，替换原 `settings.ai.client.portSuggestion.*`）；两个消费页（`settings/fund-api`、`settings/ai/client`）改为 `t(s.labelKey)`；删除死导出 `PATH_PLACEHOLDER`。
- `investment-config.ts`：`PRODUCT_LABELS` 中文 label map 改为 `PRODUCT_TYPES` 数组，消费方（`EntityCreateForm`、`settings/accounts`）改用 `labelKey`；删除无消费方的 `SUBTYPE_LABELS`/`DEPOSIT_LABELS`/`amountLabel`；`DISPLAY_MAP` 的 `label` 改为 `labelKey`（复用 `fund.subtype.*`/`fundShell.subtype.*`），sidebar 主页 `fundSubtypeInfo` 改为 `t(base.labelKey)`。
- 目录平衡 **3822/3822/3822**，全项目 0 缺失键，全量 tsc 0 错误，check:encoding 636 文件 OK。

待迁移（按优先级）：剩余少数 API 路由（transactions/detail 126 中 error 中文保留、settings/users 补 4 code、ai/chat 内部 error 保留）→ lib 数据文件（default-categories 104、commandParser 53 等为纯数据/匹配值，按规则保留）→ 少量零散组件（AdvancedDataTable 3、RegularInvestForm 11、DebtTransactionModal 10 等均为数据保留）。当前全项目约 245 文件 / 3270 行含中文（2026-08-15 实测），剩余中文绝大多数为业务数据/匹配值/错误串（按 AGENTS.md 第 3、4 条保留）。

### 第 36 轮（DELETE_CANCELLED 契约改造）

为将来 API error 英文化铺路：`lib/api/entries-delete.ts` 的两个 `ok: false` 返回（用户取消删除场景）新增稳定 code `DELETE_CANCELLED`，`EntriesDeleteResponse` 类型扩展 `code?: string`；5 个客户端组件（DepositShell、EntryRowActions、FundShell×2、InvestmentFormModal）的 `已取消删除` 判断改为 `code === "DELETE_CANCELLED" || error === "已取消删除"`（优先 code，兼容旧响应）。全量 tsc 0 错误——客户端逻辑不再依赖中文 error 字符串。

### 第 37 轮（系统自带分类进 i18n）

用户要求软件自带分类显示本地化。确认分类匹配机制：**记录关联用 `categoryId`，但分类创建/解析/模板判断仍用 name**（`ensureDefaultCategory` 按 name 幂等创建、`resolveCategorySnapshot` 按 name 查、`systemCategoryTemplateNames` 按 name 判模板）——DB 存储 name 不可变。

方案：**显示层映射**。新增 `src/lib/system-category-labels.ts`（`systemCategoryLabel(name, t)` + `isSystemCategoryName`，60 个系统分类名映射到 `systemCategory.*` 键；未知名返回原样），新增 59 个三语键（3879/3879/3879）。

接入显示点（wire 批，10 文件，tsc 0 错误）：
- `settings/categories/client.tsx`：分类树/下拉 label（isSystem 条件映射）3 处
- `reports/page.tsx`：报表行 + CSV 导出行名
- `StatementImportPreviewDialog.tsx`：预览分类列/选项 4 处
- `batch-import/page.tsx`：分类选项/列 5 处
- `DetailViewClient.tsx`：明细分类列（借款转移/债务/投资/明细 fallback）4 处
- `(sidebar)/page.tsx`：导出分类名/批量替换选项 6 处
- `TransactionFormModal.tsx`：分类选择器选项（display 层映射，AI 创建/查重保留原名匹配）2 处

明确不改：DB 写/查询逻辑（resolveCategorySnapshot、ensure*、创建 payload、筛选比较、原名匹配）——`getDetailFilterColumnValue` 的分类分支是 URL 参数比较，保留原样。RegularInvestForm/InvestmentFormModal/WealthFormModal/DebtTransactionModal 无分类显示，无需接入。

### 第 38 轮（收支模板分类进 i18n）

用户确认：**安装时自带的全部系统分类**都应进 i18n（用户自定义分类不处理）。此前第 37 轮只覆盖 60 个投资/结算分类；本轮补齐 `default-categories.ts` 的收支模板分类：

- 键生成代理产出 **186 个 `systemCategory.*` 三语键**（餐饮费→Dining/食費、房租→Rent/家賃、工资→Salary/給与、人情往来→Gifts & Social 等），合并后目录 **4066/4066/4066** 平衡。
- `system-category-labels.ts` 映射表扩展至 **245 条**（60 投资/结算 + 186 收支模板 - 1 去重），覆盖全部 196 个模板分类名（覆盖校验：missing 0）。
- 既有 wire 批接入的显示点（分类树/报表/明细/导入预览/表单选择器）自动受益——`systemCategoryLabel` 查映射表，无需再改调用点。
- DB 存储/匹配逻辑继续不变（name 为存储与匹配标识，显示本地化）。

目录平衡 **4066/4066/4066**，全项目 0 缺失键，全量 tsc 0 错误，check:encoding 640 文件 OK。
