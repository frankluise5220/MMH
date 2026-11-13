-- 2026-11-13 贵金属行情：PreciousMetalHolding.latestPrice / latestPriceDate / priceSource
--
-- 此前持仓的 unitPrice 只是「最后一笔成交单价」，不做任何行情刷新，市值永远停在买入价。
-- 新增字段按 metalUnitId 计价（克 / 盎司 / 千克）存最近一次行情价：
--   latestPrice     行情单价（与 unitPrice 同精度）
--   latestPriceDate 行情归属的交易日（日历日，UTC 零点）
--   priceSource     数据源标识，便于说明「这一行价格是谁给的」
-- 三列全部可空：存量持仓没有行情，读取侧回退到 unitPrice（最后一笔成交价）。
-- 表名注意：PreciousMetalHolding 没有 @@map（PG 与 SQLite 都用模型名），
-- 同族的 PreciousMetalTransaction 才是蛇形 precious_metal_transactions。
ALTER TABLE "PreciousMetalHolding" ADD COLUMN "latestPrice" DECIMAL(20,6);
ALTER TABLE "PreciousMetalHolding" ADD COLUMN "latestPriceDate" TIMESTAMP(3);
ALTER TABLE "PreciousMetalHolding" ADD COLUMN "priceSource" TEXT;
