import { prisma } from "../src/lib/db/prisma";
import { TransactionType, FundSubtype } from "@prisma/client";

async function main() {
  console.log("清除旧数据...");
  await prisma.fundEntry.deleteMany({});
  await prisma.txRecord.deleteMany({});
  
  console.log("重新迁移...");
  
  const oldTx = await prisma.ledgerTransaction.findMany({
    include: { entries: true },
    where: { deletedAt: null },
    orderBy: { date: "asc" },
  });
  
  for (const tx of oldTx) {
    const entries = tx.entries;
    
    if (tx.type === TransactionType.investment) {
      const fundAccountIds = ["cmpko6vhi02t2wwuudzfa2ci7", "cmpkpfpym0003dcuuvokbkw9p"];
      
      // 找资金转出 entry
      const cashEntry = entries.find(e => 
        e.amount < 0 && !fundAccountIds.includes(e.accountId ?? "")
      );
      // 找基金买入 entry
      const fundEntry = entries.find(e => 
        fundAccountIds.includes(e.accountId ?? "") || (e.fundCode && e.amount > 0)
      );
      
      if (cashEntry) {
        // 先创建 FundEntry
        const fundCode = fundEntry?.fundCode || cashEntry.fundCode || (tx.note?.match(/\b(\d{6})\b/)?.[1]);
        if (!fundCode) continue;
        
        const newFundEntry = await prisma.fundEntry.create({
          data: {
            accountId: fundEntry?.accountId ?? cashEntry.toAccountId ?? "",
            accountName: fundEntry?.accountName ?? cashEntry.toAccountName ?? "",
            fundCode: fundCode,
            fundSubtype: fundEntry?.fundSubtype as any || FundSubtype.buy,
            fundProductType: fundEntry?.fundProductType as any,
            amount: Math.abs(fundEntry?.amount ?? cashEntry.amount),
            fundUnits: fundEntry?.fundUnits,
            fundNav: fundEntry?.fundNav,
            fundFee: fundEntry?.fundFee,
            fundConfirmDate: fundEntry?.fundConfirmDate,
            fundCashAccountId: cashEntry.accountId,
            memo: fundEntry?.memo ?? tx.note,
            createdAt: tx.date,
          },
        });
        
        // 再创建 TxRecord 并关联 FundEntry
        const newTxRecord = await prisma.txRecord.create({
          data: {
            date: tx.date,
            type: TransactionType.investment,
            amount: cashEntry.amount,
            accountId: cashEntry.accountId ?? "",
            accountName: cashEntry.accountName,
            toAccountId: cashEntry.toAccountId,
            toAccountName: cashEntry.toAccountName,
            fundCode: fundCode,
            note: tx.note,
            fundEntryId: newFundEntry.id,
            createdAt: tx.date,
          },
        });
        
        console.log(`投资 ${tx.date.toISOString().slice(0,10)}: TxRecord ${newTxRecord.id.slice(-8)} <-> FundEntry ${newFundEntry.id.slice(-8)} (${fundCode})`);
      }
    } else if (tx.type === TransactionType.transfer) {
      const fromEntry = entries.find(e => e.amount < 0);
      if (fromEntry) {
        await prisma.txRecord.create({
          data: {
            date: tx.date,
            type: TransactionType.transfer,
            amount: fromEntry.amount,
            accountId: fromEntry.accountId ?? "",
            accountName: fromEntry.accountName,
            toAccountId: fromEntry.toAccountId,
            toAccountName: fromEntry.toAccountName,
            note: tx.note,
            createdAt: tx.date,
          },
        });
        console.log(`转账 ${tx.date.toISOString().slice(0,10)}`);
      }
    } else {
      const entry = entries[0];
      if (entry) {
        await prisma.txRecord.create({
          data: {
            date: tx.date,
            type: tx.type,
            amount: entry.amount,
            accountId: entry.accountId ?? "",
            accountName: entry.accountName,
            categoryId: entry.categoryId,
            categoryName: entry.categoryName,
            note: tx.note,
            statementMonth: entry.statementMonth,
            createdAt: tx.date,
          },
        });
        console.log(`${tx.type} ${tx.date.toISOString().slice(0,10)}`);
      }
    }
  }
  
  const counts = await Promise.all([
    prisma.txRecord.count(),
    prisma.fundEntry.count(),
  ]);
  console.log(`\n完成！TxRecord: ${counts[0]}, FundEntry: ${counts[1]}`);
  
  // 验证关联
  const linked = await prisma.fundEntry.findMany({
    include: { txRecord: true },
  });
  linked.forEach((e) => {
    console.log(`FundEntry ${e.id.slice(-8)} (${e.fundCode}) -> TxRecord ${e.txRecord?.id?.slice(-8) ?? "null"} date=${e.txRecord?.date?.toISOString().slice(0,10) ?? "null"}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());