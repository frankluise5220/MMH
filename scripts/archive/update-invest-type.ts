import { prisma } from "../src/lib/db/prisma";

async function main() {
  await prisma.account.update({
    where: { id: "cmpko6vhi02t2wwuudzfa2ci7" },
    data: { investProductType: "fund" },
  });
  console.log("已更新开放基金3924的二级类型为 fund");
  
  const accounts = await prisma.account.findMany({
    where: { kind: "investment" },
  });
  console.log("\n投资账户:");
  accounts.forEach((a) => {
    console.log(`name=${a.name} investProductType=${a.investProductType ?? "null"}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());