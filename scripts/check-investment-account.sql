-- 查找投资交易中 accountId 设置错误的记录（accountId 应为资金账户，不应为基金账户）
-- 检查 type = investment 且 accountId 指向投资类型账户的记录

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
  acc.name as account_actual_name,
  acc.kind as account_kind,
  CASE
    WHEN acc.kind = 'investment' THEN 'ERROR: accountId should be cash account, not investment account'
    ELSE 'OK'
  END as validation_result
FROM TxRecord tx
LEFT JOIN Account acc ON tx.accountId = acc.id
WHERE
  tx.type = 'investment'
  AND tx.deletedAt IS NULL
  AND acc.kind = 'investment'
ORDER BY tx.date DESC
LIMIT 100;