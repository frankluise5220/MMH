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

  console.log("=== 1. 创建一条测试 FundEntry ===");
  
  const account = await prisma.account.findFirst({
    where: { kind: "investment", investProductType: "fund" },
  });
  
  if (!account) {
    console.log("找不到投资账户");
    await prisma.$disconnect();
    return;
  }
  
  const testEntry = await prisma.fundEntry.create({
    data: {
      accountId: account.id,
      accountName: account.name,
      fundCode: "TESTDEL",
      fundName: "测试删除",
      fundSubtype: "buy",
      amount: 100,
    },
  });
  
  console.log("创建成功:", testEntry.id);
  console.log("fundCode:", testEntry.fundCode);
  
  console.log("\n=== 2. 模拟前端调用删除 API（程序逻辑测试）===");
  console.log("调用 URL: /api/v1/entries/delete");
  console.log("请求体:", JSON.stringify({ entryIds: [testEntry.id] }));
  
  const res = await fetch("http://localhost:3000/api/v1/entries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryIds: [testEntry.id] }),
  });
  
  const data = await res.json();
  console.log("HTTP status:", res.status);
  console.log("API 返回:", JSON.stringify(data));
  
  console.log("\n=== 3. 验证结果 ===");
  const verifyEntry = await prisma.fundEntry.findUnique({ where: { id: testEntry.id } });
  
  if (data.ok && !verifyEntry) {
    console.log("✅ 程序正确：API 返回 ok=true，数据库中 FundEntry 已被删除");
  } else if (!data.ok) {
    console.log("❌ API 返回失败:", data.error);
    if (verifyEntry) {
      await prisma.fundEntry.delete({ where: { id: testEntry.id } });
    }
  } else if (verifyEntry) {
    console.log("❌ 程序错误：API 返回 ok=true，但数据库中记录仍存在！");
    await prisma.fundEntry.delete({ where: { id: testEntry.id } });
  }
  
  console.log("\n测试完成");
  await prisma.$disconnect();
}

main().catch(console.error);