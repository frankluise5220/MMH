import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { recalcFundPositions } = await import("../src/lib/fund/recalcPosition");
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询开放基金3924账户
  const account3924 = await prisma.account.findFirst({
    where: { name: "开放基金3924" }
  });
  console.log("开放基金3924账户:", account3924);

  // 查询开放基金1100账户
  const account1100 = await prisma.account.findFirst({
    where: { name: "开放基金1100" }
  });
  console.log("开放基金1100账户:", account1100);

  if (!account3924 || !account1100) {
    console.log("账户查询失败");
    await prisma.$disconnect();
    return;
  }

  // 重算开放基金3924账户的持仓
  console.log("\n重算开放基金3924账户的持仓...");
  await recalcFundPositions(account3924.id);

  // 重算开放基金1100账户的持仓
  console.log("重算开放基金1100账户的持仓...");
  await recalcFundPositions(account1100.id);

  // 查询开放基金3924账户的持仓
  const holdings3924 = await prisma.fundHolding.findMany({
    where: { accountId: account3924.id }
  });
  console.log("\n开放基金3924持仓数量:", holdings3924.length);
  holdings3924.forEach(h => {
    console.log({
      fundCode: h.fundCode,
      fundName: h.fundName,
      units: Number(h.units),
      cost: Number(h.cost),
      pendingCost: Number(h.pendingCost)
    });
  });

  // 查询开放基金1100账户的持仓
  const holdings1100 = await prisma.fundHolding.findMany({
    where: { accountId: account1100.id }
  });
  console.log("\n开放基金1100持仓数量:", holdings1100.length);
  holdings1100.forEach(h => {
    console.log({
      fundCode: h.fundCode,
      fundName: h.fundName,
      units: Number(h.units),
      cost: Number(h.cost),
      pendingCost: Number(h.pendingCost)
    });
  });

  // 检查017091是否在正确的账户
  const holding017091_3924 = await prisma.fundHolding.findFirst({
    where: { accountId: account3924.id, fundCode: "017091" }
  });
  const holding017091_1100 = await prisma.fundHolding.findFirst({
    where: { accountId: account1100.id, fundCode: "017091" }
  });

  console.log("\n017091持仓位置:");
  console.log("开放基金3924:", holding017091_3924 ? "存在" : "不存在");
  console.log("开放基金1100:", holding017091_1100 ? "存在" : "不存在");

  await prisma.$disconnect();
}

main();