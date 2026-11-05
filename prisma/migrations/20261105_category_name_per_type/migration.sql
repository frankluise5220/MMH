-- 分类名称唯一性：从「整本账唯一」放宽到「账本 + 收支类型内唯一」（2026-11-05）。
-- 起因：支出大类里已有系统分类「娱乐休闲 → 棋牌」，用户在收入大类下建同名「棋牌」
-- 被旧的全局唯一索引拦住（提示「分类名称已存在」）。收入/支出本来就是两棵独立的树，
-- 名称不应互相占用命名空间；父分类依旧不参与唯一性判定。
-- 旧索引是 Prisma 为 @@unique([householdId, name]) 生成的名字，用 IF EXISTS 兼容
-- 早期由 db push 建库、索引名可能已被重建过的库。
DROP INDEX IF EXISTS "Category_householdId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Category_householdId_type_name_key"
  ON "Category" ("householdId", "type", "name");
