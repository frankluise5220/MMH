import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { recalcFundPositions } = await import("../src/lib/fund/recalcPosition");

  // 重新计算008971的持仓
  await recalcFundPositions("cmpnh79xe000o7suu6zorfxsq", ["008971"]);
  console.log("已重新计算008971持仓");

  // 查询更新后的持仓
  const { prisma } = await import("../src/lib/db/prisma");
  const holding = await prisma.fundHolding.findFirst({
    where: { fundCode: "008971" }
  });
  console.log("更新后的持仓:", JSON.stringify(holding, null, 2));

  // 验证计算逻辑
  console.log("\n验证:");
  const units = Number(holding?.units ?? 0);
  const cost = Number(holding?.cost ?? 0);
  const pendingCost = Number(holding?.pendingCost ?? 0);
  const avgCost = Number(holding?.avgCost ?? 0);

  console.log("确认份额:", units);
  console.log("总成本:", cost);
  console.log("未确认成本:", pendingCost);
  console.log("均价:", avgCost);
  console.log("基金名称:", holding?.fundName);

  await prisma.$disconnect();
}

main();