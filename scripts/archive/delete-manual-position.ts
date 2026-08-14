import { prisma } from "../src/lib/db/prisma";

async function main() {
  // 删除手动创建的007100持仓快照
  const deleted = await prisma.fundPosition.deleteMany({
    where: { accountId: "cmpko6vhi02t2wwuudzfa2ci7", symbol: "007100" },
  });
  console.log(`已删除 ${deleted.count} 条手动创建的007100持仓快照`);
  
  // 持仓应该从 FundEntry 实时计算
  const fundEntries = await prisma.fundEntry.findMany({
    where: { accountId: "cmpko6vhi02t2wwuudzfa2ci7" },
  });
  
  // 按基金代码汇总
  const unitsByCode = new Map<string, number>();
  const costByCode = new Map<string, number>();
  
  for (const e of fundEntries) {
    const code = e.fundCode;
    const units = Number(e.fundUnits) || 0;
    const amount = Number(e.amount);
    
    if (!e.fundSubtype || e.fundSubtype === "buy" || e.fundSubtype === "regular_invest") {
      unitsByCode.set(code, (unitsByCode.get(code) ?? 0) + units);
      costByCode.set(code, (costByCode.get(code) ?? 0) + amount);
    }
  }
  
  console.log("\n持仓汇总（从FundEntry实时计算）:");
  for (const [code, units] of unitsByCode.entries()) {
    const cost = costByCode.get(code) ?? 0;
    console.log(`symbol=${code} units=${units.toFixed(2)} cost=${cost.toFixed(2)}`);
  }
  
  console.log("\n注意：FundPosition 表是可选快照，不应手动修改。持仓由 FundEntry 实时汇总。");
}

main().catch(console.error).finally(() => prisma.$disconnect());