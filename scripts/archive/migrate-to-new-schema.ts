import { prisma } from "../src/lib/db/prisma";
import { TransactionType, FundSubtype } from "@prisma/client";

async function main() {
  console.log("清除旧迁移数据...");
  await prisma.fundEntry.deleteMany({});
  await prisma.txRecord.deleteMany({});
  
  console.log("开始重新迁移数据...");
  
  const oldTransactions = await prisma.ledgerTransaction.findMany({
    include: { entries: true },
    where: { deletedAt: null },
  });
  
  console.log(`找到 ${oldTransactions.length} 条旧交易记录`);
  
  for (const oldTx of oldTransactions) {
    const entries = oldTx.entries;
    
    if (oldTx.type === TransactionType.investment) {
      const fundAccountIds = ["cmpko6vhi02t2wwuudzfa2ci7", "cmpkpfpym0003dcuuvokbkw9p"];
      
      const cashEntry = entries.find(e => 
        e.amount < 0 && !fundAccountIds.includes(e.accountId ?? "")
      );
      const fundEntry = entries.find(e => 
        fundAccountIds.includes(e.accountId ?? "") || (e.fundCode && e.amount > 0)
      );
      
      if (cashEntry) {
        const newTx = await prisma.txRecord.create({
          data: {
            date: oldTx.date,
            type: TransactionType.investment,
            amount: cashEntry.amount,
            accountId: cashEntry.accountId ?? "",
            accountName: cashEntry.accountName,
            toAccountId: cashEntry.toAccountId,
            toAccountName: cashEntry.toAccountName,
            categoryId: null,
            fundCode: cashEntry.fundCode || (oldTx.note?.match(/\b(\d{6})\b/)?.[1]) || null,
            fundProductType: cashEntry.fundProductType as any,
            note: oldTx.note,
            deletedAt: null,
          },
        });
        
        if (fundEntry && fundEntry.fundCode) {
          await prisma.fundEntry.create({
            data: {
              transactionId: newTx.id,
              accountId: fundEntry.accountId ?? "",
              accountName: fundEntry.accountName,
              fundCode: fundEntry.fundCode ?? "",
              fundSubtype: fundEntry.fundSubtype as any || FundSubtype.buy,
              fundProductType: fundEntry.fundProductType as any,
              amount: Math.abs(fundEntry.amount),
              fundUnits: fundEntry.fundUnits,
              fundNav: fundEntry.fundNav,
              fundFee: fundEntry.fundFee,
              fundConfirmDate: fundEntry.fundConfirmDate,
              fundCashAccountId: cashEntry.accountId,
              memo: fundEntry.memo,
            },
          });
          console.log(`投资 ${oldTx.id.slice(-8)} -> Tx:${newTx.id.slice(-8)} + FundEntry`);
        } else {
          const fundCode = cashEntry.fundCode || (oldTx.note?.match(/\b(\d{6})\b/)?.[1]);
          if (fundCode) {
            await prisma.fundEntry.create({
              data: {
                transactionId: newTx.id,
                accountId: cashEntry.toAccountId ?? "",
                accountName: cashEntry.toAccountName ?? "",
                fundCode: fundCode,
                fundSubtype: FundSubtype.buy,
                amount: Math.abs(cashEntry.amount),
                fundCashAccountId: cashEntry.accountId,
              },
            });
            console.log(`投资 ${oldTx.id.slice(-8)} -> Tx:${newTx.id.slice(-8)} + FundEntry (from cash)`);
          }
        }
      } else {
        console.log(`跳过投资交易 ${oldTx.id.slice(-8)}: 没有找到资金转出 entry`);
      }
    } else if (oldTx.type === TransactionType.transfer) {
      const fromEntry = entries.find(e => e.amount < 0);
      if (fromEntry) {
        await prisma.txRecord.create({
          data: {
            date: oldTx.date,
            type: TransactionType.transfer,
            amount: fromEntry.amount,
            accountId: fromEntry.accountId ?? "",
            accountName: fromEntry.accountName,
            toAccountId: fromEntry.toAccountId,
            toAccountName: fromEntry.toAccountName,
            note: oldTx.note,
          },
        });
        console.log(`转账 ${oldTx.id.slice(-8)} -> Tx`);
      }
    } else {
      const entry = entries[0];
      if (entry) {
        await prisma.txRecord.create({
          data: {
            date: oldTx.date,
            type: oldTx.type,
            amount: entry.amount,
            accountId: entry.accountId ?? "",
            accountName: entry.accountName,
            categoryId: entry.categoryId,
            categoryName: entry.categoryName,
            note: oldTx.note,
            statementMonth: entry.statementMonth,
          },
        });
        console.log(`${oldTx.type} ${oldTx.id.slice(-8)} -> Tx`);
      }
    }
  }
  
  const counts = await Promise.all([
    prisma.txRecord.count(),
    prisma.fundEntry.count(),
  ]);
  console.log(`\n迁移完成！TxRecord: ${counts[0]} 条, FundEntry: ${counts[1]} 条`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());