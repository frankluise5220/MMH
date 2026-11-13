-- 股息税双向：tax_adjustment = 券商补扣（资金流出、冲减历史收益），
-- tax_refund = 券商退还多扣的税（资金流入、回补历史收益）。
-- 金额仍恒为正，方向只由 action 决定，与 buy/sell/dividend 的口径保持一致。
ALTER TYPE "StockTransactionAction" ADD VALUE IF NOT EXISTS 'tax_refund';
