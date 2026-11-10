-- 邮箱账单「下期自动导入」（2026-11-09）：
-- 1) StatementMailAutoImport  ：用户勾选的自动抓取计划（每邮箱 + 目标账户一条）
-- 2) StatementMailAutoImportJob：抓到的账单原文，等待用户确认导入（不自动落账）

CREATE TABLE IF NOT EXISTS "StatementMailAutoImport" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT,
    "fromIncludes" TEXT,
    "subjectIncludes" TEXT,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "hourOfDay" INTEGER NOT NULL DEFAULT 9,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementMailAutoImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatementMailAutoImportJob" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "emailAccountId" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "hash" TEXT,
    "subject" TEXT,
    "fromAddress" TEXT,
    "mailDate" TIMESTAMP(3),
    "content" TEXT NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementMailAutoImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StatementMailAutoImport_householdId_enabled_idx" ON "StatementMailAutoImport"("householdId", "enabled");
CREATE INDEX IF NOT EXISTS "StatementMailAutoImport_enabled_nextRunAt_idx" ON "StatementMailAutoImport"("enabled", "nextRunAt");
CREATE UNIQUE INDEX IF NOT EXISTS "StatementMailAutoImportJob_householdId_emailAccountId_uid_key" ON "StatementMailAutoImportJob"("householdId", "emailAccountId", "uid");
CREATE INDEX IF NOT EXISTS "StatementMailAutoImportJob_householdId_status_createdAt_idx" ON "StatementMailAutoImportJob"("householdId", "status", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StatementMailAutoImport_householdId_fkey') THEN
    ALTER TABLE "StatementMailAutoImport" ADD CONSTRAINT "StatementMailAutoImport_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StatementMailAutoImport_emailAccountId_fkey') THEN
    ALTER TABLE "StatementMailAutoImport" ADD CONSTRAINT "StatementMailAutoImport_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StatementMailAutoImportJob_householdId_fkey') THEN
    ALTER TABLE "StatementMailAutoImportJob" ADD CONSTRAINT "StatementMailAutoImportJob_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StatementMailAutoImportJob_scheduleId_fkey') THEN
    ALTER TABLE "StatementMailAutoImportJob" ADD CONSTRAINT "StatementMailAutoImportJob_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "StatementMailAutoImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
