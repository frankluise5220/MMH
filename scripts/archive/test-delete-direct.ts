import { readFileSync } from "fs";
import { resolve } from "path";

const envFiles = [".env", ".env.local"];
for (const f of envFiles) {
  try {
    const content = readFileSync(resolve(process.cwd(), f), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          let val = trimmed.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  } catch {}
}

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");
  const { recalcFundPositions } = await import("../src/lib/fund/recalcPosition");

  const entryId = "cmpozrf5d000erwuunnecgpgs";

  console.log("=== 模拟删除 API 逻辑 ===\n");

  const fundEntry = await prisma.fundEntry.findUnique({
    where: { id: entryId },
    include: { txRecord: true },
  });

  console.log("1. 查找 FundEntry:", fundEntry ? "找到" : "不存在");
  
  if (fundEntry) {
    console.log("   id:", fundEntry.id);
    console.log("   fundCode:", fundEntry.fundCode);
    console.log("   accountId:", fundEntry.accountId);
    console.log("   txRecord:", fundEntry.txRecord ? `id=${fundEntry.txRecord.id}` : "无");

    const { accountId, fundCode } = fundEntry;

    console.log("\n2. 软删除关联的 TxRecord...");
    if (fundEntry.txRecord) {
      await prisma.txRecord.update({
        where: { id: fundEntry.txRecord.id },
        data: { deletedAt: new Date() },
      });
      console.log("   ✓ TxRecord.deletedAt 已设置");
    } else {
      console.log("   无 TxRecord，跳过");
    }

    console.log("\n3. 删除 FundEntry...");
    await prisma.fundEntry.delete({ where: { id: fundEntry.id } });
    console.log("   ✓ FundEntry 已删除");

    console.log("\n4. 重算持仓...");
    await recalcFundPositions(accountId, [fundCode]);
    console.log("   ✓ recalcFundPositions 完成");

    console.log("\n=== 验证结果 ===");
    const checkEntry = await prisma.fundEntry.findUnique({ where: { id: entryId } });
    console.log("FundEntry:", checkEntry ? "仍存在！" : "已删除 ✓");
    
    const checkTx = await prisma.txRecord.findUnique({ where: { id: fundEntry.txRecord?.id! } });
    console.log("TxRecord:", checkTx ? `deletedAt=${checkTx.deletedAt}` : "不存在");
  } else {
    console.log("\n   FundEntry 不存在，检查是否是 TxRecord ID...");
    
    const txRecord = await prisma.txRecord.findUnique({ where: { id: entryId } });
    if (txRecord) {
      console.log("   找到 TxRecord:", txRecord.id, "deletedAt:", txRecord.deletedAt);
      if (txRecord.fundEntryId) {
        const linked = await prisma.fundEntry.findUnique({ where: { id: txRecord.fundEntryId } });
        console.log("   关联的 FundEntry:", linked ? linked.id : "不存在");
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);