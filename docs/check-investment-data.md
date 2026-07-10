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

## 买入退回与确认份额

- 买入存在退回时，确认份额统一按 `买入金额 - 关联退回金额 - 手续费` 后再除以净值计算。
- 买入记录的 `fundUnits` 存储“净确认份额”，不是原始买入金额对应的份额。
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
5. 同时更新 `accountName` 和 `toAccountName`
6. 保存

### 批量修复脚本（谨慎使用）

如果数据量较大，可以编写批量修复脚本，但建议先备份数据。

## 验证修复结果

修复后，重新运行检查步骤，确认：
- 所有 investment 类型记录的 `account.kind` ≠ `investment`
- `accountId` 指向的是现金/银行账户
- `toAccountId` 指向的是投资账户
