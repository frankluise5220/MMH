-- 2026-10-06 口径定版：贷款 = loan，往来款 = settlement，负债 = liability。
-- `debt` 这个名字在库中释放，留给未来真正的「债务」概念。
--
-- 迁移内容（全部无损）：
--   1) 往来款约定表 DebtAgreement → SettlementAgreement（含约束与索引改名）
--   2) 方向枚举 DebtDirection → LiabilityDirection（值 payable / receivable 不变）
--   3) 列改名：Account.debtDirection → liabilityDirection；
--      TxRecord.debtPrincipalAmount / debtInterestAmount / debtFeeAmount →
--      principalAmount / interestAmount / feeAmount（贷款与往来款共用，故不叫 loan*）
--   4) 历史 source 值 debt_* → liability_*
--   5) 机构类型 debt（放款机构）→ lender

-- 1) 往来款约定表改名（幂等：只在旧表存在、新表不存在时执行）
DO $$
BEGIN
  IF to_regclass('public."DebtAgreement"') IS NOT NULL
     AND to_regclass('public."SettlementAgreement"') IS NULL THEN
    ALTER TABLE "DebtAgreement" RENAME TO "SettlementAgreement";
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public."SettlementAgreement"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DebtAgreement_pkey') THEN
      ALTER TABLE "SettlementAgreement" RENAME CONSTRAINT "DebtAgreement_pkey" TO "SettlementAgreement_pkey";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DebtAgreement_accountId_fkey') THEN
      ALTER TABLE "SettlementAgreement" RENAME CONSTRAINT "DebtAgreement_accountId_fkey" TO "SettlementAgreement_accountId_fkey";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DebtAgreement_householdId_fkey') THEN
      ALTER TABLE "SettlementAgreement" RENAME CONSTRAINT "DebtAgreement_householdId_fkey" TO "SettlementAgreement_householdId_fkey";
    END IF;
    IF to_regclass('public."DebtAgreement_accountId_key"') IS NOT NULL THEN
      ALTER INDEX "DebtAgreement_accountId_key" RENAME TO "SettlementAgreement_accountId_key";
    END IF;
    IF to_regclass('public."DebtAgreement_householdId_dueDate_idx"') IS NOT NULL THEN
      ALTER INDEX "DebtAgreement_householdId_dueDate_idx" RENAME TO "SettlementAgreement_householdId_dueDate_idx";
    END IF;
  END IF;
END
$$;

-- 2) 枚举改名
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DebtDirection')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LiabilityDirection') THEN
    ALTER TYPE "DebtDirection" RENAME TO "LiabilityDirection";
  END IF;
END
$$;

-- 3) 列改名
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'debtDirection')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'liabilityDirection') THEN
    ALTER TABLE "Account" RENAME COLUMN "debtDirection" TO "liabilityDirection";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'debtPrincipalAmount')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'principalAmount') THEN
    ALTER TABLE "transactions" RENAME COLUMN "debtPrincipalAmount" TO "principalAmount";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'debtInterestAmount')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'interestAmount') THEN
    ALTER TABLE "transactions" RENAME COLUMN "debtInterestAmount" TO "interestAmount";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'debtFeeAmount')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'feeAmount') THEN
    ALTER TABLE "transactions" RENAME COLUMN "debtFeeAmount" TO "feeAmount";
  END IF;
END
$$;

-- 4) 历史 source 值（贷款/往来款共用一套前缀，不按账户类型拆分）
UPDATE "transactions"
SET "source" = 'liability_' || substring("source" from 6)
WHERE "source" LIKE 'debt\_%' ESCAPE '\';

-- 5) 机构类型：放款机构 debt → lender
UPDATE "Institution"
SET "type" = 'lender'
WHERE "type" = 'debt';
