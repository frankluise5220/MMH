# 检查和修复投资交易账户设置错误

## 问题描述

根据 DESIGN.md 规范，投资交易的账户结构应该是：
- `accountId` = 资金来源账户（现金账户）
- `toAccountId` = 基金账户（投资账户）
- `amount` 为负数表示买入（资金从左流向右）

历史数据中可能存在错误：`accountId` 设置为基金账户（应该设置为资金账户）。

## 基金身份字段

- `fundCode` 是基金记录的身份字段，也是持仓重算、匹配、分组和去重的计算键。
- `fundName` 只用于显示、补全和导入辅助，不参与持仓、成本、份额、收益计算。
- 同一个基金改名、名称缺失或名称被导入备注污染时，不应影响持仓计算结果。
- 基金账户的 `tradingCalendar` 是确认日期、到账日期、T+N 推导的账户级规则。核对净值日期/入账日期时，不能只看确认天数和到账天数，还要同时确认该账户使用的是哪一种交易日历。
- 基金交易 Excel 如果填写了资金账户，导入预览必须把该值匹配成资金侧 `Account.id`；匹配不到应阻断导入。导入成功后，应能在资金侧看到对应 `TxRecord`，在 `FundTransactionCashFlow` 中看到现金流，并通过 `EntryBusinessLink` 关联到基金业务交易。

## 股票身份和持仓字段

- 股票账户使用 `Account.kind = "investment"` + `investProductType = "stock"`；同一账簿可有多个股票账户，账户 ID 是账户身份来源。
- 创建或更新股票账户时，如果有证券机构，应自动确保同账簿、同所有人、同证券机构、同币种下存在一个现金/钱包类“证券资金账户”；核对时不要把银证转账目标设成股票账户或基金账户。
- 股票标的身份使用 `StockSecurity.id` / `securityId`，展示和导入辅助字段是 `market`、`stockCode`、`stockName`；不要把股票代码写入或核对到 `fundCode`。
- 股票交易事实字段以 `StockTransaction` 为准，现金流水只在需要时创建普通 `TxRecord`，二者通过 `EntryBusinessLink.stockTransactionId` 和返回的 `linkId` 关联。
- 股票买入、卖出、分红和税费调整使用 `cashAccountId` 指向的证券资金账户/券商可用资金账户；同一证券公司名下的股票和基金可以共用同一个现金/钱包类资金账户。检查余额时应把证券资金账户现金和 `StockHolding` 市值区分开。银证转账是银行/现金账户与证券资金账户之间的普通转账，不写入 `StockTransaction`。
- 股票持仓以 `StockHolding` 为准，数量、成本、最新价、市值、浮盈和历史收益都由 `src/lib/stock/recalcPosition.ts` 重算；最新收盘价写入 `StockPriceCache`，刷新后必须再次重算 `StockHolding`。不要从 `FundHolding` 或基金净值缓存推断股票值。
- 报表页「股票持仓盈亏」必须与股票账户持仓表使用同一套 `StockHolding` 数字：市值、成本、浮动盈亏、已实现收益。核对时先看股票账户页，再看 `/reports?report=stock-holdings`，两边同一只股票的金额不能各算各的。
- 股票手续费规则先看账户级 `StockFeeRule`，未命中时使用市场默认 `StockMarketFeeRule`；证券公司公开名录和别名存入 `StockBrokerageCatalog`。这些规则支持佣金、印花税、过户费、经手费、监管费、平台费、最低收费和买卖方向；不要复用 `fundFeeRate`。
- 股票买入/卖出窗口只直接展示费用合计、成交金额和预计应付/到账，佣金、印花税、过户费、经手费、证管费、其他费用只在费用合计 hover 明细中展示；这些值只是同一套 `src/lib/stock/feeRule.ts` 计算结果的只读预估。保存交易时服务端再次按该规则计算并写入 `StockTransaction`，买入现金侧 `TxRecord` 金额应等于成交金额 + 费用合计，卖出现金侧 `TxRecord` 金额应等于成交金额 - 费用合计。
- 券商导入或成交单去重使用 `externalLinkId` / `brokerTradeId`；它们不是基金买入退回 link，也不是 `fundSourceEntryId`。

## 房产资产字段

- 房产账户使用 `Account.kind = "investment"` + `investProductType = "property"`；同一账簿可有多个房产账户，账户 ID 是归属来源。
- 房产资产以 `PropertyAsset` 为准，字段包括名称、地址、币种、购入日期、购入价、累计成本、当前市值、最近估值日期和状态；不要把房产身份或市值写入基金字段。
- 房产购入、装修投入和出售以 `PropertyTransaction` 为业务事实，现金侧只在传入资金账户时创建 `TxRecord`，并通过 `EntryBusinessLink.propertyTransactionId` 关联。
- 成本口径为交易金额 + 手续费 + 税费；装修投入增加累计成本。手动估值只写 `PropertyValuation` 并更新市值，不产生收入/支出/转账现金流水。
- 房贷或按揭仍应作为贷款/负债账户核对；房产持仓市值和贷款余额不能混在同一房产资产表里计算。

## 最新净值刷新

- 启动后的轻量后台检查和基金页手动“获取净值”都应刷新当前持仓基金的最新净值。
- 当前持仓以 `FundHolding` 中 `units > 0` 或 `pendingCost > 0` 的基金/货币基金账户行判断，不依赖该基金是否存在定投计划。
- 待确认买入记录的确认日净值补填仍按交易确认日期处理；持仓最新净值刷新只负责更新最新可用交易日净值缓存和显示名称。
- 投资收益表的每日市值收益必须检查持仓基金在已发生工作日是否有当日净值缓存。缺失时提示用户批量获取；获取会按基金合并日期范围写入 `FundNavCache`。周末/非交易日市值可沿用上一可用交易日净值。

## 买入退回与确认份额

- 持仓表显示的未确认金额按待确认买入记录的 `买入金额 - 关联退回金额` 汇总，不扣申购手续费；这是显示口径，不要求改写 `FundHolding.pendingCost` 缓存。
- 买入确认份额统一按 `买入金额 - 关联退回金额 - 申购手续费` 后再除以净值计算；买入记录的 `fundUnits` 存储扣费后的确认份额。
- 持仓成本价使用扣除关联退回、但不扣申购手续费的买入金额（买入金额 - 关联退回金额）作为成本基础；申购手续费属于用户投入成本，但不形成份额。赎回收益使用净到账金额，若没有单独保存到账金额，`TxRecord.amount` 已经是现金侧净到账，重算时不能再扣一次赎回费。
- 退回记录只表示资金回流和与买入记录的关联，不应在展示、持仓重算、净值补全、导入或批量编辑中再次扣减份额。
- 基金明细统一使用“金额”列表达交易金额：买入主记录（包括买入失败）显示原买入金额正数，关联买入退回记录显示负数，二者可直接相加对冲；状态只显示“买入失败”“买入退回”或“部分确认”等简洁状态。确认净额只用于编辑窗口的派生确认金额、份额和持仓计算。退回行只是资金回流和关联关系记录，不能改成普通买入，否则会影响成本和未确认金额。
- 核对问题记录时，先看退回记录是否通过 `fundSourceEntryId` 关联到源买入记录；没有显式关联的旧数据才允许按日期规则做兼容匹配。

## 如何检查

### 方法1：使用 Prisma Studio（推荐）

Prisma Studio 已启动在：http://localhost:51212

1. 打开 TxRecord 表
2. 添加筛选条件：
   - `type` = `investment`
   - `deletedAt` = `null`
3. 查看每条记录的 `accountId` 和 `account` 关联
4. 如果 `account.kind` = `investment`，则该记录存在错误

### 方法2：使用 SQL 查询

在数据库工具中运行 `scripts/archive/check-investment-account.sql`：

```sql
SELECT
  tx.id,
  tx.date,
  tx.type,
  tx.accountId,
  tx.accountName,
  tx.toAccountId,
  tx.toAccountName,
  tx.amount,
  tx.fundCode,
  acc.kind as account_kind,
  CASE
    WHEN acc.kind = 'investment' THEN 'ERROR: accountId should be cash account'
    ELSE 'OK'
  END as validation_result
FROM TxRecord tx
LEFT JOIN Account acc ON tx.accountId = acc.id
WHERE
  tx.type = 'investment'
  AND tx.deletedAt IS NULL
  AND acc.kind = 'investment'
ORDER BY tx.date DESC;
```

## 如何修复

对于发现的错误记录，需要交换 `accountId` 和 `toAccountId`：

### Prisma Studio 手动修复

1. 在 TxRecord 表中找到错误记录
2. 点击编辑
3. 将 `accountId` 改为原来的 `toAccountId` 值
4. 将 `toAccountId` 改为原来的 `accountId` 值
5. 保存；`accountName` 和 `toAccountName` 是旧兼容字段，显示和导出应优先从账户 ID 关联的 Account 表生成

### 批量修复脚本（谨慎使用）

如果数据量较大，可以编写批量修复脚本，但建议先备份数据。

## 验证修复结果

修复后，重新运行检查步骤，确认：
- 所有 investment 类型记录的 `account.kind` ≠ `investment`
- `accountId` 指向的是现金/银行账户
- `toAccountId` 指向的是投资账户
