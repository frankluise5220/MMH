import { prisma } from "../src/lib/db/prisma";

async function main() {
  const entryId = "cmpnf2ii50008kkuuvqs1abby";
  
  const fundEntry = await prisma.fundEntry.findUnique({
    where: { id: entryId },
    include: { txRecord: true },
  });
  
  if (!fundEntry) {
    console.log("未找到");
    return;
  }
  
  console.log("测试更新 FundEntry...");
  
  // 测试删除净值、份额、确认日期
  try {
    await prisma.fundEntry.update({
      where: { id: entryId },
      data: {
        fundNav: null,
        fundUnits: null,
        fundConfirmDate: null,
      },
    });
    console.log("更新成功");
  } catch (e) {
    console.log("更新失败:", e);
  }
  
  // 测试 TxRecord 更新
  if (fundEntry.txRecord) {
    console.log("测试更新 TxRecord...");
    try {
      await prisma.txRecord.update({
        where: { id: fundEntry.txRecord.id },
        data: {
          date: new Date(),
          amount: -500,
          fundCode: "007100",
          note: "测试",
        },
      });
      console.log("TxRecord 更新成功");
    } catch (e) {
      console.log("TxRecord 更新失败:", e);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());