-- Keep the persisted NAV publication-lag mode binary and normalize rows
-- written by the earlier configurable-offset implementation.
UPDATE "FundProfile" AS profile
SET "navDateOffset" = CASE
  WHEN latest."latestNavDate"::date >= CURRENT_DATE THEN 0
  ELSE 1
END
FROM (
  SELECT "fundCode", MAX("navDate") AS "latestNavDate"
  FROM "FundNavCache"
  GROUP BY "fundCode"
) AS latest
WHERE profile."fundCode" = latest."fundCode";

UPDATE "FundProfile"
SET "navDateOffset" = CASE WHEN "navDateOffset" = 1 THEN 1 ELSE 0 END;

ALTER TABLE "FundProfile"
  ADD CONSTRAINT "FundProfile_navDateOffset_binary_check"
  CHECK ("navDateOffset" IN (0, 1));
