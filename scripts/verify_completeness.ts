import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 1. 查询fundSubtype为null且有fundCode的记录
  const nullSubtype = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, "fundSubtype", "fundProductType", note, "regularInvestPlanId", "createdAt"
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND "fundSubtype" IS NULL
    AND "deletedAt" IS NULL
    ORDER BY "createdAt" ASC
  `;
  console.log("fundSubtype为null的记录:", nullSubtype.length);

  // 2. 查询fundProductType为null且有fundCode的记录
  const nullProductType = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, "fundSubtype", "fundProductType", note
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND "fundProductType" IS NULL
    AND "deletedAt" IS NULL
  `;
  console.log("fundProductType为null的记录:", nullProductType.length);

  // 3. 查询type为null且有fundCode的记录
  const nullType = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, type, "fundSubtype", note
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND type IS NULL
    AND "deletedAt" IS NULL
  `;
  console.log("type为null的记录:", nullType.length);

  // 4. 综合统计：有多少投资记录缺少任一必需字段
  const anyMissing = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, type, "fundSubtype", "fundProductType", note
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND "deletedAt" IS NULL
    AND ("fundSubtype" IS NULL OR "fundProductType" IS NULL OR type IS NULL)
  `;
  console.log("\n缺少任一必需字段(type/fundSubtype/fundProductType)的记录:", anyMissing.length);
  (anyMissing as any[]).forEach(e => {
    console.log({
      id: e.id,
      fundCode: e.fundCode,
      amount: Number(e.amount),
      type: e.type,
      fundSubtype: e.fundSubtype,
      fundProductType: e.fundProductType,
      note: e.note?.slice(0, 40)
    });
  });

  // 5. 按fundSubtype统计
  const bySubtype = await prisma.$queryRaw`
    SELECT "fundSubtype", COUNT(*) as count
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND "deletedAt" IS NULL
    GROUP BY "fundSubtype"
    ORDER BY count DESC
  `;
  console.log("\n按fundSubtype统计:");
  (bySubtype as any[]).forEach(e => {
    console.log(`  ${e.fundSubtype ?? "NULL"}: ${e.count}`);
  });

  await prisma.$disconnect();
}

main();