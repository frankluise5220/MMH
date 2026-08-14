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

  const entryId = "cmpoz9zbf0008rwuuujqlzhda";

  console.log("=== 检查 FundEntry ===");
  const fundEntry = await prisma.fundEntry.findUnique({
    where: { id: entryId },
    include: { txRecord: true, account: true },
  });

  if (fundEntry) {
    console.log("找到 FundEntry:");
    console.log("  id:", fundEntry.id);
    console.log("  fundCode:", fundEntry.fundCode);
    console.log("  fundName:", fundEntry.fundName);
    console.log("  amount:", fundEntry.amount);
    console.log("  fundSubtype:", fundEntry.fundSubtype);
    console.log("  accountId:", fundEntry.accountId);
    console.log("  accountName:", fundEntry.accountName);
    console.log("  createdAt:", fundEntry.createdAt.toISOString());
    console.log("  txRecord:", fundEntry.txRecord ? `id=${fundEntry.txRecord.id} deletedAt=${fundEntry.txRecord.deletedAt}` : "无");
    
    if (fundEntry.txRecord) {
      console.log("\n=== 检查关联的 TxRecord ===");
      console.log("  id:", fundEntry.txRecord.id);
      console.log("  date:", fundEntry.txRecord.date.toISOString());
      console.log("  amount:", fundEntry.txRecord.amount);
      console.log("  note:", fundEntry.txRecord.note);
      console.log("  deletedAt:", fundEntry.txRecord.deletedAt);
      console.log("  fundEntryId:", fundEntry.txRecord.fundEntryId);
    }
  } else {
    console.log("FundEntry 不存在，尝试查找 TxRecord...");
    
    const txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
    });
    
    if (txRecord) {
      console.log("找到 TxRecord:");
      console.log("  id:", txRecord.id);
      console.log("  amount:", txRecord.amount);
      console.log("  deletedAt:", txRecord.deletedAt);
      console.log("  fundEntryId:", txRecord.fundEntryId);
      
      if (txRecord.fundEntryId) {
        const linkedFundEntry = await prisma.fundEntry.findUnique({
          where: { id: txRecord.fundEntryId },
        });
        console.log("  关联的 FundEntry:", linkedFundEntry ? `id=${linkedFundEntry.id}` : "不存在");
      }
    } else {
      console.log("TxRecord 也不存在！");
    }
  }

  console.log("\n=== 模拟删除操作 ===");
  if (fundEntry) {
    try {
      console.log("尝试删除 FundEntry...");
      const result = await prisma.fundEntry.delete({ where: { id: entryId } });
      console.log("删除成功:", result.id);
    } catch (e) {
      console.log("删除失败:", e instanceof Error ? e.message : e);
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);