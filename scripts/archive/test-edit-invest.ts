import { prisma } from "../src/lib/db/prisma";
import { FundSubtype } from "@prisma/client";

async function main() {
  const entryId = "cmpnf2ii50008kkuuvqs1abby";
  
  const fundEntry = await prisma.fundEntry.findUnique({
    where: { id: entryId },
    include: { txRecord: true },
  });
  
  if (!fundEntry) {
    console.log("未找到 FundEntry");
    return;
  }
  
  console.log("测试 editInvestment 逻辑:");
  console.log(`fundEntry.id=${fundEntry.id}`);
  console.log(`fundEntry.txRecord=${fundEntry.txRecord ? fundEntry.txRecord.id : "null"}`);
  
  // 测试更新
  try {
    await prisma.fundEntry.update({
      where: { id: entryId },
      data: {
        fundCode: "007100",
        fundSubtype: FundSubtype.buy,
        fundUnits: 342.163,
        fundNav: 1.4591,
        fundFee: 0,
        fundConfirmDate: new Date("2026-05-09"),
        fundName: "招商中证白酒指数",
        amount: 500,
      },
    });
    console.log("FundEntry 更新成功");
    
    if (fundEntry.txRecord) {
      await prisma.txRecord.update({
        where: { id: fundEntry.txRecord.id },
        data: {
          date: new Date("2026-05-08"),
          amount: -500,
          fundCode: "007100",
          note: "招商中证白酒指数",
        },
      });
      console.log("TxRecord 更新成功");
    }
    
    // 测试 recalcFundPositions
    console.log("测试 recalcFundPositions...");
    const { recalcFundPositions } = await import("../src/lib/fund/recalcPosition");
    await recalcFundPositions(fundEntry.accountId, ["007100"]);
    console.log("recalcFundPositions 成功");
    
  } catch (e) {
    console.log("错误:", e);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());