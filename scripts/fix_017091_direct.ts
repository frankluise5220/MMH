import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  const account1100 = "cmpnh79xe000o7suu6zorfxsq"; // 开放基金1100

  // 直接删除017091在开放基金1100的错误持仓（该账户已无017091交易明细）
  const deleted = await prisma.fundHolding.deleteMany({
    where: { accountId: account1100, fundCode: "017091" }
  });
  console.log("删除017091在开放基金1100的持仓:", deleted.count);

  // 确认删除
  const holding = await prisma.fundHolding.findFirst({
    where: { accountId: account1100, fundCode: "017091" }
  });
  console.log("017091在开放基金1100:", holding ? "仍存在" : "已删除");

  await prisma.$disconnect();
}

main();