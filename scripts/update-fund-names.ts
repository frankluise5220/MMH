import { prisma } from "../src/lib/db/prisma";

async function main() {
  // 基金代码与名称映射
  const fundNames: Record<string, string> = {
    "000573": "天弘通利混合A",
    "007100": "招商中证白酒指数",
    "017093": "景顺长城纳斯达克科技ETF联接(QDII)C人民币",
  };
  
  const fundEntries = await prisma.fundEntry.findMany();
  
  for (const e of fundEntries) {
    const name = fundNames[e.fundCode] || "";
    if (name) {
      await prisma.fundEntry.update({
        where: { id: e.id },
        data: { fundName: name },
      });
      console.log(`更新 ${e.fundCode}: fundName=${name}`);
    }
  }
  
  const updated = await prisma.fundEntry.findMany();
  updated.forEach((e) => {
    console.log(`fundCode=${e.fundCode} fundName=${e.fundName ?? "null"}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());