import { prisma } from "../src/lib/db/prisma";
import { recalcFundPositions } from "../src/lib/fund/recalcPosition";
import { AccountKind } from "@prisma/client";

async function main() {
  const accounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, isActive: true },
    select: { id: true, name: true },
  });
  console.log("投资账户:", accounts.map(a => a.name));

  for (const a of accounts) {
    console.log(`重算 ${a.name} (${a.id})...`);
    await recalcFundPositions(a.id);
    const holdings = await prisma.fundHolding.findMany({
      where: { accountId: a.id },
      select: { fundCode: true, cost: true, pendingCost: true, units: true, avgCost: true },
      orderBy: { fundCode: "asc" },
    });
    for (const h of holdings) {
      console.log(`  ${h.fundCode}: cost=${h.cost}, pending=${h.pendingCost}, units=${h.units}, avgCost=${h.avgCost}`);
    }
  }

  await prisma.$disconnect();
  console.log("完成");
}

main().catch(e => { console.error(e); process.exit(1); });
