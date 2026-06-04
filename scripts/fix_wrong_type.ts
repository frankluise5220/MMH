import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询所有fundCode不为null但type不是investment的记录
  const wrongType = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, type, "fundSubtype", "fundProductType", note
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND type != 'investment'
    AND "deletedAt" IS NULL
    ORDER BY "createdAt" ASC
  `;
  console.log("type错误的投资记录数量:", (wrongType as any[]).length);
  (wrongType as any[]).forEach(e => {
    console.log({
      id: e.id,
      fundCode: e.fundCode,
      amount: Number(e.amount),
      type: e.type,
      fundSubtype: e.fundSubtype,
      fundProductType: e.fundProductType,
      note: e.note?.slice(0, 60)
    });
  });

  if ((wrongType as any[]).length === 0) {
    console.log("\n没有需要修复的记录");
    await prisma.$disconnect();
    return;
  }

  // 修复：将所有有fundCode但type不是investment的记录的type改为investment
  const fixed = await prisma.$executeRaw`
    UPDATE transactions
    SET type = 'investment'::"TransactionType"
    WHERE "fundCode" IS NOT NULL
    AND type != 'investment'
    AND "deletedAt" IS NULL
  `;
  console.log("\n已修复记录数量:", fixed);

  // 验证修复结果
  const remaining = await prisma.$queryRaw`
    SELECT COUNT(*) as count
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND type != 'investment'
    AND "deletedAt" IS NULL
  `;
  console.log("剩余错误记录:", (remaining as any[])[0].count);

  await prisma.$disconnect();
}

main();