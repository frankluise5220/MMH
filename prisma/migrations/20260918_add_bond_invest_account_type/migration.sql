-- 债券账户成为独立投资账户类型（Account.investProductType = 'bond'），与理财并列。
-- 交易数据仍走理财 bond 单一路线（WealthProduct.productType = 'bond'），此枚举值只用于账户分类。
ALTER TYPE "FundProductType" ADD VALUE IF NOT EXISTS 'bond';
