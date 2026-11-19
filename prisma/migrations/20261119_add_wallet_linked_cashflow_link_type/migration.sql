-- 电子钱包收支 ↔ 关联货基赎回/申购的专用 link 类型（2026-11-19 用户裁定 A）
--
-- 创建联动时除资金腿的 cash_flow link 之外，再给**原收支流水**挂一条本类型 link：
--   - 删除该支出/转入时，删除影响分析能找到赎回（申购）业务行与资金腿，整笔删除；
--   - 编辑金额/日期时，syncWalletLinkedCashflowOnEdit 能改写赎回腿。
-- findFundTransactionForEntryId 必须忽略本类型，否则编辑普通支出会被判成编辑基金赎回。
ALTER TYPE "EntryBusinessLinkType" ADD VALUE IF NOT EXISTS 'wallet_linked_cashflow';
