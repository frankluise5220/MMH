-- 2026-10-13 记录绑定当时的 MMH 会员邮箱（User.registrationEmail）
--
-- `User.email` 是本地可编辑的联系邮箱，改掉之后就看不出这个账号绑定的到底是
-- 哪个 MMH 会员账号；`registrationEmail` 只在绑定 / 自愈时写入，作为展示与
-- 重新匹配用的稳定来源。
-- 可空：存量账号在下次 MMH 登录时由自愈逻辑补齐。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "registrationEmail" TEXT;
