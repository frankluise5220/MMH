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

  console.log("=== 找一条可删除的 FundEntry ===");
  const entry = await prisma.fundEntry.findFirst({
    where: { fundCode: "019059" },
    orderBy: { createdAt: "desc" },
  });

  if (!entry) {
    console.log("没有找到 019059 的记录，找第一条...");
    const anyEntry = await prisma.fundEntry.findFirst({ orderBy: { createdAt: "desc" } });
    if (!anyEntry) {
      console.log("没有 FundEntry 可测试");
      await prisma.$disconnect();
      return;
    }
    console.log("找到:", anyEntry.id, "fundCode:", anyEntry.fundCode);
    await testDelete(anyEntry.id);
  } else {
    console.log("找到:", entry.id, "fundCode:", entry.fundCode, "amount:", entry.amount);
    await testDelete(entry.id);
  }

  await prisma.$disconnect();
}

async function testDelete(entryId: string) {
  console.log("\n=== 测试删除 API ===");
  console.log("entryId:", entryId);
  console.log("调用: POST /api/v1/entries/delete");
  console.log("body:", JSON.stringify({ entryIds: [entryId] }));

  try {
    const res = await fetch("http://localhost:3000/api/v1/entries/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: [entryId] }),
    });

    const data = await res.json();
    console.log("\n响应 status:", res.status);
    console.log("响应 body:", JSON.stringify(data));

    if (data.ok) {
      const { prisma } = await import("../src/lib/db/prisma");
      const check = await prisma.fundEntry.findUnique({ where: { id: entryId } });
      console.log("\n验证数据库:", check ? "记录仍存在！" : "记录已删除 ✓");
    } else {
      console.log("\nAPI 返回错误:", data.error);
    }
  } catch (e) {
    console.log("\n请求失败:", e instanceof Error ? e.message : String(e));
    console.log("\n注意: 请确保 dev server 正在运行 (npm run dev)");
  }
}

main().catch(console.error);