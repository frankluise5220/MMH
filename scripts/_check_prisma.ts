import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");
  const keys = Object.keys(prisma as object).filter(k => k.toLowerCase().includes('fund') || k.toLowerCase().includes('query'));
  console.log("keys:", keys);
  console.log("has fundQueryApi:", "fundQueryApi" in (prisma as object));

  // Try accessing it directly
  const apis = await prisma.fundQueryApi.findMany({ orderBy: { priority: "asc" } });
  console.log("APIs found:", apis.length);
  await prisma.$disconnect();
}
main();