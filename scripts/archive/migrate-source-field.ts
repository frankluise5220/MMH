import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // Step 1: fundSubtype='regular_invest' → source='regular_invest', fundSubtype='buy'
  const r1 = await prisma.$executeRaw`
    UPDATE transactions
    SET source = 'regular_invest', "fundSubtype" = 'buy'::"FundSubtype"
    WHERE "fundSubtype" = 'regular_invest'
    AND "deletedAt" IS NULL
  `;
  console.log("regular_invest → buy, source=regular_invest:", r1);

  // Step 2: fundSubtype='switch_in' → source='switch', fundSubtype='buy'
  const r2 = await prisma.$executeRaw`
    UPDATE transactions
    SET source = 'switch', "fundSubtype" = 'buy'::"FundSubtype"
    WHERE "fundSubtype" = 'switch_in'
    AND "deletedAt" IS NULL
  `;
  console.log("switch_in → buy, source=switch:", r2);

  // Step 3: fundSubtype='dividend_reinvest' → source='dividend', fundSubtype='buy'
  const r3 = await prisma.$executeRaw`
    UPDATE transactions
    SET source = 'dividend', "fundSubtype" = 'buy'::"FundSubtype"
    WHERE "fundSubtype" = 'dividend_reinvest'
    AND "deletedAt" IS NULL
  `;
  console.log("dividend_reinvest → buy, source=dividend:", r3);

  // Step 4: fundSubtype='buy' + regularInvestPlanId IS NOT NULL → source='regular_invest'
  const r4 = await prisma.$executeRaw`
    UPDATE transactions
    SET source = 'regular_invest'
    WHERE "fundSubtype" = 'buy'
    AND "regularInvestPlanId" IS NOT NULL
    AND source = 'manual'
    AND "deletedAt" IS NULL
  `;
  console.log("buy + regularInvestPlanId → source=regular_invest:", r4);

  // Step 5: All remaining fundCode records with source='manual' are already manual
  // (no migration needed, default is 'manual')

  // Verify
  const bySource = await prisma.$queryRaw`
    SELECT source, "fundSubtype", COUNT(*) as count
    FROM transactions
    WHERE "fundCode" IS NOT NULL
    AND "deletedAt" IS NULL
    GROUP BY source, "fundSubtype"
    ORDER BY source, "fundSubtype"
  `;
  console.log("\n按source和fundSubtype统计:");
  (bySource as any[]).forEach(e => {
    console.log(`  source=${e.source}, fundSubtype=${e.fundSubtype}: ${e.count}`);
  });

  await prisma.$disconnect();
}

main();