import { prisma } from "../src/lib/db/prisma";
import { toNumber } from "../src/lib/date-utils";

async function main() {
  const fundEntries = await prisma.fundEntry.findMany({
    where: { accountId: "cmpko6vhi02t2wwuudzfa2ci7", fundCode: "007100" },
  });
  
  const units = fundEntries.reduce((s, e) => s + toNumber(e.fundUnits ?? 0), 0);
  const cost = fundEntries.reduce((s, e) => s + toNumber(e.amount), 0);
  const nav = fundEntries.find(e => e.fundNav)?.fundNav;
  
  console.log(`007100汇总: units=${units.toFixed(2)} cost=${cost.toFixed(2)} nav=${nav ? toNumber(nav).toFixed(4) : "null"}`);
  
  const existingPos = await prisma.fundPosition.findFirst({
    where: { accountId: "cmpko6vhi02t2wwuudzfa2ci7", symbol: "007100" },
  });
  
  if (existingPos) {
    console.log("007100已有FundPosition记录");
  } else {
    await prisma.fundPosition.create({
      data: {
        accountId: "cmpko6vhi02t2wwuudzfa2ci7",
        symbol: "007100",
        name: "招商中证白酒指数",
        units: units,
        avgCost: units > 0 ? cost / units : 0,
        marketValue: cost,
        nav: nav,
        snapshotDate: new Date("2026-05-26"),
      },
    });
    console.log("已创建007100的FundPosition记录");
  }
  
  const positions = await prisma.fundPosition.findMany({
    where: { accountId: "cmpko6vhi02t2wwuudzfa2ci7" },
  });
  console.log("\nFundPosition表:");
  positions.forEach((p) => {
    console.log(`symbol=${p.symbol} units=${toNumber(p.units).toFixed(2)} marketValue=${toNumber(p.marketValue).toFixed(2)}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());