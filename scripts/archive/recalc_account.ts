import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { recalcFundPositions } = await import("../src/lib/fund/recalcPosition");
  const { prisma } = await import("../src/lib/db/prisma");

  const accountId = "cmpnh79xe000o7suu6zorfxsq"; // 开放基金1100

  console.log("开始重算开放基金1100账户的持仓...");
  await recalcFundPositions(accountId);
  console.log("已完成持仓重算");

  // 查询重算后的持仓
  const holdings = await prisma.fundHolding.findMany({
    where: { accountId }
  });
  console.log("\n重算后的持仓数量:", holdings.length);
  holdings.forEach(h => {
    console.log({
      fundCode: h.fundCode,
      fundName: h.fundName,
      units: Number(h.units),
      cost: Number(h.cost),
      pendingCost: Number(h.pendingCost)
    });
  });

  // 检查017091是否还存在
  const holding017091 = await prisma.fundHolding.findFirst({
    where: { accountId, fundCode: "017091" }
  });
  console.log("\n017091 持仓:", holding017091 ? "仍然存在" : "已删除");

  await prisma.$disconnect();
}

main();