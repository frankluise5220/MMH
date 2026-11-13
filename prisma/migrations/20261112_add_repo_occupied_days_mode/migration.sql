-- 逆回购占款天数口径：让账簿自己选（actual / term / arrival_gap）。
-- actual 与券商实付利息一致，作为默认值。
ALTER TABLE "HouseholdPreference"
  ADD COLUMN IF NOT EXISTS "repoOccupiedDaysMode" TEXT NOT NULL DEFAULT 'actual';
