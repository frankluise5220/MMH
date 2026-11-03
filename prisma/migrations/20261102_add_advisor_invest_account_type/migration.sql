-- 投顾组合成为独立投资账户类型（Account.investProductType = 'advisor'），与理财并列。
-- 交易数据仍走理财链路（WealthTransaction / WealthProduct），此枚举值只用于账户与流水分类。
ALTER TYPE "FundProductType" ADD VALUE IF NOT EXISTS 'advisor';
