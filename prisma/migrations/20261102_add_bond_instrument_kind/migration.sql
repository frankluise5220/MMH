-- 国债逆回购复用 bond_transactions 的「存单」语义：
-- 借出 = buy 行、到期回款 = redeem 子行，用 instrumentKind 把逆回购与债券分流
-- （债券视图/债券明细只取 bond，逆回购视图只取 repo）。
-- 老数据全部是债券，默认值 'bond' 即为正确归属。
ALTER TABLE "bond_transactions" ADD COLUMN "instrumentKind" TEXT NOT NULL DEFAULT 'bond';
