CREATE TABLE "DepositProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "annualRate" DECIMAL(10,6),
    "termDays" INTEGER,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "householdId" TEXT NOT NULL,
    "institutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DepositProduct_householdId_institutionId_name_key" ON "DepositProduct"("householdId", "institutionId", "name");
CREATE INDEX "DepositProduct_householdId_isActive_name_idx" ON "DepositProduct"("householdId", "isActive", "name");
CREATE INDEX "DepositProduct_institutionId_idx" ON "DepositProduct"("institutionId");

ALTER TABLE "transactions" ADD COLUMN "depositProductId" TEXT;
CREATE INDEX "transactions_depositProductId_idx" ON "transactions"("depositProductId");
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_depositProductId_fkey" FOREIGN KEY ("depositProductId") REFERENCES "DepositProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "deposit_transactions" ADD COLUMN "depositProductId" TEXT;
CREATE INDEX "deposit_transactions_depositProductId_idx" ON "deposit_transactions"("depositProductId");
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_depositProductId_fkey" FOREIGN KEY ("depositProductId") REFERENCES "DepositProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DepositProduct" ADD CONSTRAINT "DepositProduct_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DepositProduct" ADD CONSTRAINT "DepositProduct_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "DepositProduct" ("id", "name", "currency", "isActive", "householdId", "institutionId", "createdAt", "updatedAt")
SELECT
    'dprod_' || md5(src."householdId" || E'\u001f' || COALESCE(src."institutionId", '') || E'\u001f' || src."productName"),
    src."productName",
    'CNY',
    true,
    src."householdId",
    src."institutionId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT
        dt."householdId",
        acc."institutionId",
        dt."productName"
    FROM "deposit_transactions" dt
    JOIN "Account" acc ON acc."id" = dt."accountId"
    WHERE dt."deletedAt" IS NULL
      AND dt."householdId" IS NOT NULL
      AND COALESCE(dt."productName", '') <> ''
    UNION
    SELECT DISTINCT
        t."householdId",
        acc."institutionId",
        t."fundName" AS "productName"
    FROM "transactions" t
    JOIN "Account" acc ON acc."id" = CASE
      WHEN t."fundSubtype" IN ('redeem', 'switch_out') THEN t."accountId"
      ELSE COALESCE(t."toAccountId", t."accountId")
    END
    WHERE t."deletedAt" IS NULL
      AND t."householdId" IS NOT NULL
      AND t."fundProductType" = 'deposit'
      AND COALESCE(t."fundName", '') <> ''
) src
ON CONFLICT ("householdId", "institutionId", "name") DO NOTHING;

UPDATE "deposit_transactions" dt
SET "depositProductId" = dp."id"
FROM "DepositProduct" dp
JOIN "Account" acc ON acc."id" = dt."accountId"
WHERE dt."depositProductId" IS NULL
  AND dt."householdId" = dp."householdId"
  AND dt."productName" = dp."name"
  AND COALESCE(acc."institutionId", '') = COALESCE(dp."institutionId", '')
  AND COALESCE(dt."productName", '') <> '';

UPDATE "transactions" t
SET "depositProductId" = dp."id"
FROM "DepositProduct" dp
JOIN "Account" acc ON acc."id" = CASE
  WHEN t."fundSubtype" IN ('redeem', 'switch_out') THEN t."accountId"
  ELSE COALESCE(t."toAccountId", t."accountId")
END
WHERE t."depositProductId" IS NULL
  AND t."householdId" = dp."householdId"
  AND t."fundProductType" = 'deposit'
  AND t."fundName" = dp."name"
  AND COALESCE(acc."institutionId", '') = COALESCE(dp."institutionId", '')
  AND COALESCE(t."fundName", '') <> '';
