/**
 * 数据迁移脚本：将 TxRecord.fundEntryId 数据迁移到 linkId/linkType
 * 
 * 运行方式：npx tsx scripts/migrate-linkId.ts
 * 
 * 迁移步骤：
 * 1. TxRecord: fundEntryId → linkId + linkType="FundEntry"（使用 raw SQL 绕过 Prisma 类型限制）
 * 2. FundEntry: linkId ← 对应的 TxRecord.id（反向关联）
 * 3. 验证迁移结果
 * 
 * 迁移完成后，下一步：修改 schema 移除 fundEntryId，运行 prisma db push
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ log: ["error"], adapter });

async function main() {
  console.log("=== 开始迁移: fundEntryId → linkId/linkType ===");

  // Step 1: TxRecord.fundEntryId → TxRecord.linkId + linkType="FundEntry"
  // 使用 raw SQL，因为 Prisma client 类型可能不包含 linkId/linkType
  const step1Result = await prisma.$executeRaw`
    UPDATE transactions
    SET "linkId" = "fundEntryId", "linkType" = 'FundEntry'
    WHERE "fundEntryId" IS NOT NULL
      AND ("linkId" IS NULL OR "linkId" != "fundEntryId" OR "linkType" != 'FundEntry')
  `;
  console.log(`Step 1 完成: 更新了 ${step1Result} 条 TxRecord (fundEntryId → linkId/linkType)`);

  // Step 2: FundEntry.linkId ← 对应的 TxRecord.id（反向关联）
  // 找出所有还没有 linkId 的 FundEntry，为其设置反向关联
  const step2Result = await prisma.$executeRaw`
    UPDATE "FundEntry"
    SET "linkId" = sub.tx_id
    FROM (
      SELECT t.id AS tx_id, t."linkId" AS fe_id
      FROM transactions t
      WHERE t."linkType" = 'FundEntry' AND t."linkId" IS NOT NULL AND t."deletedAt" IS NULL
    ) AS sub
    WHERE "FundEntry"."linkId" IS NULL
      AND "FundEntry".id = sub.fe_id
  `;
  console.log(`Step 2 完成: 更新了 ${step2Result} 条 FundEntry (反向关联 linkId)`);

  // Step 3: 验证
  console.log("\n=== 验证迁移结果 ===");

  // 检查 TxRecord: fundEntryId 和 linkId 是否一致
  const mismatches = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM transactions
    WHERE "fundEntryId" IS NOT NULL
      AND ("linkId" != "fundEntryId" OR "linkType" != 'FundEntry')
  `;
  const mismatchCount = Number(mismatches[0]?.count ?? 0);
  if (mismatchCount === 0) {
    console.log("✅ TxRecord: 所有 fundEntryId 数据已正确迁移到 linkId/linkType");
  } else {
    console.log(`❌ TxRecord: ${mismatchCount} 条记录不一致`);
  }

  // 检查 FundEntry 反向关联
  const reverseMismatches = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM "FundEntry" fe
    WHERE fe."linkId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.id = fe."linkId"
          AND t."linkId" = fe.id
          AND t."linkType" = 'FundEntry'
      )
  `;
  const reverseMismatchCount = Number(reverseMismatches[0]?.count ?? 0);
  if (reverseMismatchCount === 0) {
    console.log("✅ FundEntry: 所有反向关联验证通过");
  } else {
    console.log(`❌ FundEntry: ${reverseMismatchCount} 条反向关联不匹配`);
  }

  // 统计
  const txWithLinkId = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count FROM transactions WHERE "linkId" IS NOT NULL AND "linkType" = 'FundEntry'
  `;
  const txWithFundEntryId = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count FROM transactions WHERE "fundEntryId" IS NOT NULL
  `;
  const feWithLinkId = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count FROM "FundEntry" WHERE "linkId" IS NOT NULL
  `;
  console.log(`\n统计:`);
  console.log(`  TxRecord.linkId="FundEntry" = ${Number(txWithLinkId[0]?.count ?? 0)}`);
  console.log(`  TxRecord.fundEntryId != null = ${Number(txWithFundEntryId[0]?.count ?? 0)}`);
  console.log(`  FundEntry.linkId != null     = ${Number(feWithLinkId[0]?.count ?? 0)}`);

  if (mismatchCount === 0 && reverseMismatchCount === 0) {
    console.log("\n✅ 迁移完成！下一步: 修改 prisma/schema.prisma 移除 fundEntryId，然后运行 prisma db push");
  } else {
    console.log("\n❌ 迁移有问题，请检查上述不一致记录");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());