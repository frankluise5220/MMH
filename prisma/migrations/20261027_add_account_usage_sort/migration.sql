-- 「按使用频率调整账户顺序」开关（2026-10-27），默认开启以保持原有行为。
ALTER TABLE "HouseholdPreference" ADD COLUMN "accountUsageSortEnabled" BOOLEAN NOT NULL DEFAULT true;
