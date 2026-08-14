import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询007100的所有交易明细（含已删除）
  const all = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, type, "fundSubtype", "fundProductType",
           note, "toAccountId", "toAccountName", "deletedAt", "createdAt"
    FROM transactions
    WHERE "fundCode" = '007100'
    ORDER BY "createdAt" ASC
  `;
  console.log("007100 所有记录数量:", (all as any[]).length);
  (all as any[]).forEach(e => {
    console.log({
      id: e.id,
      amount: Number(e.amount),
      type: e.type,
      fundSubtype: e.fundSubtype,
      fundProductType: e.fundProductType,
      toAccountId: e.toAccountId,
      toAccountName: e.toAccountName,
      note: e.note?.slice(0, 50),
      deletedAt: e.deletedAt ? "已删除" : null,
      createdAt: e.createdAt.toISOString().slice(0, 10)
    });
  });

  // 也查一下007100有没有通过note关联的记录
  const byNote = await prisma.$queryRaw`
    SELECT id, "fundCode", amount, type, "fundSubtype", note, "deletedAt"
    FROM transactions
    WHERE note LIKE '%007100%'
    AND "fundCode" IS NULL
    AND "deletedAt" IS NULL
  `;
  console.log("\n通过备注关联但fundCode为空的记录:", (byNote as any[]).length);
  (byNote as any[]).forEach(e => {
    console.log({
      id: e.id,
      amount: Number(e.amount),
      type: e.type,
      fundSubtype: e.fundSubtype,
      note: e.note?.slice(0, 50)
    });
  });

  await prisma.$disconnect();
}

main();