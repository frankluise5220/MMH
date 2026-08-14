import { prisma } from "../src/lib/db/prisma";
import { toNumber } from "../src/lib/date-utils";

async function main() {
  const entries = await prisma.transactionEntry.findMany({
    where: { transaction: { deletedAt: null, type: "investment" } },
    include: { transaction: true },
  });

  const codes = [...new Set(entries.map(e => e.fundCode).filter(Boolean))];
  console.log("Fund codes in entries:", codes);

  const navCaches = codes.length > 0
    ? await prisma.fundNavCache.findMany({ where: { fundCode: { in: codes } } })
    : [];
  console.log("NavCache count:", navCaches.length);
  for (const n of navCaches) {
    console.log(`  ${n.fundCode} ${n.navDate.toISOString()} nav=${toNumber(n.nav)}`);
  }

  for (const e of entries) {
    const amt = toNumber(e.amount);
    const isPending = amt < 0 && !e.fundConfirmDate && e.fundNav == null;
    console.log(`entry id=${e.id} amt=${amt} units=${e.fundUnits} nav=${e.fundNav} pending=${isPending}`);
  }
}
main();