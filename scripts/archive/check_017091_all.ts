import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询所有017091的交易明细（不限定账户）
  const all017091 = await prisma.txRecord.findMany({
    where: {
      fundCode: "017091",
      deletedAt: null
    },
    select: {
      id: true,
      toAccountId: true,
      toAccountName: true,
      accountId: true,
      accountName: true,
      amount: true,
      fundSubtype: true,
      fundUnits: true,
      fundProductType: true,
      createdAt: true
    },
    orderBy: { createdAt: "asc" }
  });

  console.log("所有017091交易明细数量:", all017091.length);
  all017091.forEach(e => {
    console.log({
      id: e.id,
      toAccountId: e.toAccountId,
      toAccountName: e.toAccountName,
      accountId: e.accountId,
      accountName: e.accountName,
      amount: Number(e.amount),
      subtype: e.fundSubtype,
      units: e.fundUnits ? Number(e.fundUnits) : null,
      productType: e.fundProductType,
      createdAt: e.createdAt.toISOString().slice(0, 10)
    });
  });

  // 查询开放基金1100账户的id
  const account = await prisma.account.findFirst({
    where: { name: "开放基金1100" }
  });
  console.log("\n开放基金1100账户ID:", account?.id);

  // 查询该账户作为toAccountId的所有交易（包括非基金的）
  const allToAccount = await prisma.txRecord.findMany({
    where: {
      toAccountId: account?.id,
      deletedAt: null
    },
    select: {
      id: true,
      fundCode: true,
      fundProductType: true,
      amount: true,
      createdAt: true
    }
  });

  console.log("\n该账户作为toAccountId的所有交易数量:", allToAccount.length);
  const byCode = new Map<string, number>();
  allToAccount.forEach(e => {
    const code = e.fundCode ?? "null";
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  });
  console.log("按基金代码分组:");
  byCode.forEach((count, code) => {
    console.log(`${code}: ${count}条`);
  });

  await prisma.$disconnect();
}

main();