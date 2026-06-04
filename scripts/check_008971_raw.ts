import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询008971的原始数据（包含toAccountName）
  const rawEntries = await prisma.txRecord.findMany({
    where: {
      toAccountId: "cmpnh79xe000o7suu6zorfxsq", // 008971持仓的账户ID
      fundCode: "008971",
      deletedAt: null
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      fundCode: true,
      fundName: true,
      toAccountId: true,
      toAccountName: true,
      amount: true,
      fundUnits: true,
      fundSubtype: true,
      createdAt: true
    }
  });

  console.log("008971 原始数据（包含toAccountName）:");
  rawEntries.forEach(e => {
    console.log({
      id: e.id,
      fundCode: e.fundCode,
      fundName: e.fundName,
      toAccountId: e.toAccountId,
      toAccountName: e.toAccountName,
      amount: Number(e.amount),
      fundUnits: e.fundUnits ? Number(e.fundUnits) : null,
      subtype: e.fundSubtype,
      createdAt: e.createdAt
    });
  });

  // 查询账户信息
  const account = await prisma.account.findUnique({
    where: { id: "cmpnh79xe000o7suu6zorfxsq" },
    select: { id: true, name: true, kind: true }
  });
  console.log("\n账户信息:", account);

  await prisma.$disconnect();
}

main();