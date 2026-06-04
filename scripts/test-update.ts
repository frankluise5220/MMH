import { prisma } from "../src/lib/db/prisma";

async function main() {
  // 测试 FundEntry 更新
  const entryId = "cmpmug1g2007qk4uuvkddv586"; // vqs1abby 对应的完整ID
  
  // 查找 entry
  const fundEntry = await prisma.fundEntry.findFirst({
    where: { id: { endsWith: "vqs1abby" } },
    include: { txRecord: true },
  });
  
  if (fundEntry) {
    console.log("找到 FundEntry:");
    console.log(`id=${fundEntry.id}`);
    console.log(`fundEntryId=${fundEntry.fundEntryId ?? "null"}`);
    console.log(`txRecord.id=${fundEntry.txRecord?.id ?? "null"}`);
    
    // 尝试简单更新
    try {
      const updated = await prisma.fundEntry.update({
        where: { id: fundEntry.id },
        data: { fundNav: 1.5 },
      });
      console.log("更新成功:", updated.id);
    } catch (e) {
      console.log("更新失败:", e);
    }
  } else {
    console.log("未找到 FundEntry，搜索所有:");
    const all = await prisma.fundEntry.findMany();
    all.forEach(e => console.log(`id=${e.id.slice(-8)} fundCode=${e.fundCode}`));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());