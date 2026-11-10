-- FundNavCache 只回答「某基金某天的净值」，不再持有基金名。
-- 基金名是基金维度主数据，唯一归属 FundProfile，且只允许在基金资料页写入。
ALTER TABLE "FundNavCache" DROP COLUMN IF EXISTS "name";
