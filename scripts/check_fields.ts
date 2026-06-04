import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import { prisma } from "../src/lib/db/prisma";

async function main() {
  // 查看这9条记录的完整信息
  const details = await prisma.$queryRaw`
    SELECT id, "fundCode", "fundName", type, "fundSubtype", "fundProductType", "regularInvestPlanId", amount, "accountId", "toAccountId", date, note, "createdAt"
    FROM transactions 
    WHERE "fundCode" IS NOT NULL 
    AND "fundSubtype" IS NULL 
    AND "deletedAt" IS NULL 
    ORDER BY "createdAt" DESC
  `;
  console.log("Records missing fundSubtype (full details):");
  (details as any[]).forEach(r => {
    console.log({
      id: r.id,
      fundCode: r.fundCode,
      fundName: r.fundName,
      type: r.type,
      fundSubtype: r.fundSubtype,
      fundProductType: r.fundProductType,
      regularInvestPlanId: r.regularInvestPlanId,
      amount: r.amount,
      accountId: r.accountId,
      toAccountId: r.toAccountId,
      date: r.date,
      note: r.note,
      createdAt: r.createdAt
    });
  });

  // 统计总数
  const total = await prisma.$queryRaw`
    SELECT COUNT(*) as count FROM transactions 
    WHERE "fundCode" IS NOT NULL AND "deletedAt" IS NULL
  `;
  console.log("\nTotal records with fundCode:", total);

  const missingSubtype = await prisma.$queryRaw`
    SELECT COUNT(*) as count FROM transactions 
    WHERE "fundCode" IS NOT NULL AND "fundSubtype" IS NULL AND "deletedAt" IS NULL
  `;
  console.log("Records missing fundSubtype:", missingSubtype);
}

main().finally(() => prisma.$disconnect());
