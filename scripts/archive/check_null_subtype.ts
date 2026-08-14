import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  // 查询fundSubtype为null且fundCode不为null的记录
  const nullSubtype = await prisma.txRecord.findMany({
    where: {
      fundCode: { not: null },
      fundSubtype: null,
      deletedAt: null
    },
    select: {
      id: true,
      fundCode: true,
      amount: true,
      note: true,
      regularInvestPlanId: true,
      createdAt: true
    },
    orderBy: { createdAt: "asc" }
  });

  console.log("fundSubtype为null的记录数量:", nullSubtype.length);

  if (nullSubtype.length === 0) {
    console.log("没有需要修复的记录");
    await prisma.$disconnect();
    return;
  }

  // 分析这些记录的特征
  const byNote = new Map<string, number>();
  nullSubtype.forEach(e => {
    const noteKey = e.note?.includes("定期定额申购") ? "定期定额申购" : e.note ?? "null";
    byNote.set(noteKey, (byNote.get(noteKey) ?? 0) + 1);
  });

  console.log("\n按备注分组:");
  byNote.forEach((count, key) => console.log(`${key}: ${count}条`));

  // 统计有regularInvestPlanId的记录
  const withPlanId = nullSubtype.filter(e => e.regularInvestPlanId).length;
  console.log("\n有regularInvestPlanId的:", withPlanId);

  // 统计amount符号
  const negative = nullSubtype.filter(e => Number(e.amount) < 0).length;
  const positive = nullSubtype.filter(e => Number(e.amount) >= 0).length;
  console.log("金额为负（买入类）:", negative);
  console.log("金额为正（赎回类）:", positive);

  // 显示前5条记录
  console.log("\n前5条记录:");
  nullSubtype.slice(0, 5).forEach(e => {
    console.log({
      id: e.id,
      fundCode: e.fundCode,
      amount: Number(e.amount),
      note: e.note,
      planId: e.regularInvestPlanId,
      createdAt: e.createdAt.toISOString().slice(0, 10)
    });
  });

  await prisma.$disconnect();
}

main();