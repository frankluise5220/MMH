-- 2026-11-18 净值源可配置化：FundQueryApi.parser / parserConfig
--
-- 原来「用哪个解析器」只能由 code 决定，而解析器写死在 queryApi.ts 的 PARSERS 里，
-- 换一家 API 就得改代码。现在把解析器标识单独存一列，并给「配置驱动」的 JSON 源
-- 留一份配置：
--   parser       解析器标识（eastmoney / eastmoney_history / danjuan / alipay / json）
--   parserConfig 只对 parser = "json" 生效：净值路径、日期路径、鉴权方式、代码后缀
--
-- 两列全部可空：存量行的 parser 为空时回退到 code（旧数据 code 本来就是解析器），
-- 内置的 4 个源永远不需要 parserConfig，行为与升级前完全一致。
-- 表名注意：FundQueryApi 没有 @@map，PG 与 SQLite 都用模型名。
ALTER TABLE "FundQueryApi" ADD COLUMN "parser" TEXT;
ALTER TABLE "FundQueryApi" ADD COLUMN "parserConfig" JSONB;
