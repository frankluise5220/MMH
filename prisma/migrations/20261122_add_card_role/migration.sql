-- 信用卡卡别（主卡 / 副卡）：与账单模式并存的独立属性。
-- 存量账户一律视为主卡；副卡持卡人/主卡字段沿用的 20261122_add_supplementary_card 两列。
CREATE TYPE "AccountCardRole" AS ENUM ('primary', 'supplementary');

ALTER TABLE "Account"
  ADD COLUMN "cardRole" "AccountCardRole" NOT NULL DEFAULT 'primary';
