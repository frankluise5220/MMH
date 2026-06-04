import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查找账户"开放基金1100"
  const account = await prisma.account.findFirst({
    where: { name: "开放基金1100" }
  });
  console.log("账户信息:", account);

  if (!account) {
    console.log("未找到账户");
    await prisma.$disconnect();
    return;
  }

  // 查找该账户的017091持仓
  const holding = await prisma.fundHolding.findFirst({
    where: {
      accountId: account.id,
      fundCode: "017091"
    }
  });
  console.log("\n017091 持仓:", JSON.stringify(holding, null, 2));

  // 查找该账户的017091交易明细（未删除）
  const entries = await prisma.txRecord.findMany({
    where: {
      toAccountId: account.id,
      fundCode: "017091",
      deletedAt: null
    },
    select: {
      id: true,
      toAccountId: true,
      toAccountName: true,
      amount: true,
      fundSubtype: true,
      fundUnits: true,
      createdAt: true
    },
    orderBy: { createdAt: "asc" }
  });
  console.log("\n017091 未删除的交易明细数量:", entries.length);
  entries.forEach(e => {
    console.log({
      id: e.id,
      amount: Number(e.amount),
      subtype: e.fundSubtype,
      units: e.fundUnits ? Number(e.fundUnits) : null,
      createdAt: e.createdAt.toISOString().slice(0, 10)
    });
  });

  // 查找该账户的所有017091交易明细（包括已删除）
  const allEntries = await prisma.txRecord.findMany({
    where: {
      toAccountId: account.id,
      fundCode: "017091"
    },
    select: {
      id: true,
      amount: true,
      fundSubtype: true,
      fundUnits: true,
      deletedAt: true,
      createdAt: true
    },
    orderBy: { createdAt: "asc" }
  });
  console.log("\n017091 所有交易明细数量（含已删除）:", allEntries.length);
  allEntries.forEach(e => {
    console.log({
      id: e.id,
      amount: Number(e.amount),
      subtype: e.fundSubtype,
      units: e.fundUnits ? Number(e.fundUnits) : null,
      deletedAt: e.deletedAt ? e.deletedAt.toISOString().slice(0, 10) : null,
      createdAt: e.createdAt.toISOString().slice(0, 10)
    });
  });

  await prisma.$disconnect();
}

main();