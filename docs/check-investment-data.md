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

## 股票身份和持仓字段

- 股票账户使用 `Account.kind = "investment"` + `investProductType = "stock"`；同一账簿可有多个股票账户，账户 ID 是账户身份来源。
- 创建或更新股票账户时，如果有证券机构，应自动确保同账簿、同所有人、同证券机构、同币种下存在一个现金/钱包类“证券资金账户”；核对时不要把银证转账目标设成股票账户或基金账户。
- 股票标的身份使用 `StockSecurity.id` / `securityId`，展示和导入辅助字段是 `market`、`stockCode`、`stockName`；不要把股票代码写入或核对到 `fundCode`。
- 股票交易事实字段以 `StockTransaction` 为准，现金流水只在需要时创建普通 `TxRecord`，二者通过 `EntryBusinessLink.stockTransactionId` 和返回的 `linkId` 关联。
- 股票买入、卖出、分红和税费调整使用 `cashAccountId` 指向的证券资金账户/券商可用资金账户；同一证券公司名下的股票和基金可以共用同一个现金/钱包类资金账户。检查余额时应把证券资金账户现金和 `StockHolding` 市值区分开。银证转账是银行/现金账户与证券资金账户之间的普通转账，不写入 `StockTransaction`。
- 股票持仓以 `StockHolding` 为准，数量、成本、最新价、市值、浮盈和历史收益都由 `src/lib/stock/recalcPosition.ts` 重算；不要从 `FundHolding` 或基金净值缓存推断股票值。
- 股票手续费规则以 `StockFeeRule` 为准，支持佣金、印花税、过户费、经手费、监管费、平台费、最低收费和买卖方向；不要复用 `fundFeeRate`。
- 券商导入或成交单去重使用 `externalLinkId` / `brokerTradeId`；它们不是基金买入退回 link，也不是 `fundSourceEntryId`。

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

在数据库工具中运行 `scripts/check-investment-account.sql`：

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
