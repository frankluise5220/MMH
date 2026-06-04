import { prisma } from "../src/lib/db/prisma";

async function main() {
  // 获取所有关联的投资交易
  const txRecords = await prisma.txRecord.findMany({
    where: { type: "investment", fundEntryId: { not: null } },
    include: { fundEntry: true },
  });
  
  console.log("当前关联数据:");
  txRecords.forEach((t) => {
    console.log(`TxRecord ${t.id.slice(-8)} date=${t.date.toISOString().slice(0,10)} amount=${t.amount} fundCode=${t.fundCode}`);
    console.log(`  -> FundEntry ${t.fundEntry?.id?.slice(-8) ?? "null"} fundCode=${t.fundEntry?.fundCode ?? "null"} amount=${t.fundEntry?.amount ?? "null"}`);
  });
  
  // 从 TxRecord 更新 FundEntry
  for (const t of txRecords) {
    if (t.fundEntry) {
      await prisma.fundEntry.update({
        where: { id: t.fundEntry.id },
        data: {
          fundCode: t.fundCode ?? t.fundEntry.fundCode,
          memo: t.note ?? t.fundEntry.memo,
        },
      });
      console.log(`更新 FundEntry ${t.fundEntry.id.slice(-8)}: fundCode=${t.fundCode ?? t.fundEntry.fundCode}`);
    }
  }
  
  console.log("\n更新完成！");
}

main().catch(console.error).finally(() => prisma.$disconnect());