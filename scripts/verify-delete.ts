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

  console.log("=== 验证删除结果 ===");
  
  const fundEntry = await prisma.fundEntry.findUnique({
    where: { id: entryId },
  });
  
  console.log("FundEntry:", fundEntry ? `仍存在 id=${fundEntry.id}` : "已删除");
  
  const txRecord = await prisma.txRecord.findUnique({
    where: { id: "cmpoz9zc40009rwuudxwvd5is" },
  });
  
  console.log("TxRecord:", txRecord ? `id=${txRecord.id} deletedAt=${txRecord.deletedAt}` : "不存在");

  await prisma.$disconnect();
}

main().catch(console.error);