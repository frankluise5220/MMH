-- 2026-11-18 股票收盘价可配置源
--
-- 此前股票收盘价只能走 src/lib/stock/queryApi.ts 里写死的东财 / 腾讯两条链路：
-- 东财挂了只能靠腾讯，用户既看不到也加不了第三条通道。本表把「行情源」变成数据：
--   market       适用市场（当前只有 CN 实现）
--   baseUrl      请求模板，支持 {code} {exchange} {exchangeLower} {secid} {date} {dateCompact}
--   parser       解析器标识（eastmoney_kline / tencent_kline / json）
--   parserConfig 仅 parser = "json"：字段路径与鉴权方式
--   builtin      true = 代码内置的默认源，可停用、可调序，不可删除
--
-- 内置的两条由 src/lib/stock/quoteSourceDefaults.ts 在查询侧自愈补齐，不在这里插数据：
-- 迁移只建结构，避免和「整表为空时自动补默认源」的幂等逻辑打架。
CREATE TABLE "stock_quote_apis" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'CN',
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT,
    "parser" TEXT,
    "parserConfig" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "householdId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_quote_apis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_quote_apis_code_key" ON "stock_quote_apis"("code");
CREATE INDEX "stock_quote_apis_market_isActive_priority_idx" ON "stock_quote_apis"("market", "isActive", "priority");
