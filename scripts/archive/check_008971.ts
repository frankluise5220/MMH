import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询008971的持仓
  const holding = await prisma.fundHolding.findFirst({
    where: { fundCode: "008971" }
  });
  console.log("008971 持仓:", JSON.stringify(holding, null, 2));

  // 查询008971的所有交易明细
  const entries = await prisma.txRecord.findMany({
    where: { fundCode: "008971", deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      date: true,
      amount: true,
      fundCode: true,
      fundName: true,
      fundUnits: true,
      fundFee: true,
      fundConfirmDate: true,
      fundSubtype: true,
      createdAt: true
    }
  });
  console.log("\n008971 交易明细数量:", entries.length);
  entries.forEach(e => {
    console.log({
      id: e.id,
      date: e.date,
      amount: Number(e.amount),
      fundName: e.fundName,
      units: e.fundUnits ? Number(e.fundUnits) : null,
      fee: e.fundFee ? Number(e.fundFee) : null,
      subtype: e.fundSubtype,
      confirmDate: e.fundConfirmDate,
      pending: e.fundConfirmDate == null
    });
  });

  // 手动计算验证
  let totalCost = 0;
  let totalUnits = 0;
  let pendingCost = 0;

  for (const e of entries) {
    const amt = Number(e.amount);
    const units = e.fundUnits ? Number(e.fundUnits) : null;
    const subtype = e.fundSubtype;
    const isPending = e.fundConfirmDate == null;

    if (subtype === "buy" || subtype === "regular_invest" || subtype === "switch_in" || subtype === "dividend_reinvest") {
      if (isPending) {
        pendingCost += Math.abs(amt);
        console.log("未确认买入:", amt, "累计未确认:", pendingCost);
      } else {
        totalCost += Math.abs(amt);
        if (units) totalUnits += units;
        console.log("确认买入:", amt, "units:", units, "累计成本:", totalCost, "累计份额:", totalUnits);
      }
    }
  }

  const avgCost = totalUnits > 0 ? totalCost / totalUnits : 0;
  console.log("\n手动计算结果:");
  console.log("确认成本:", totalCost);
  console.log("确认份额:", totalUnits);
  console.log("均价:", avgCost);
  console.log("未确认成本:", pendingCost);
  console.log("总成本(确认+未确认):", totalCost + pendingCost);

  await prisma.$disconnect();
}

main();