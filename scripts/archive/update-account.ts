import { prisma } from "../src/lib/db/prisma";

async function main() {
  const account = await prisma.account.findFirst({
    where: { name: { contains: "3924" } }
  });
  console.log("Target account:", account?.id, account?.name);

  if (!account) {
    console.log("No account found with '3924'");
    return;
  }

  const count = await prisma.transactionEntry.count({
    where: { accountName: { contains: "信用卡8448" } }
  });
  console.log("Records to update:", count);

  if (count > 0) {
    const result = await prisma.transactionEntry.updateMany({
      where: { accountName: { contains: "信用卡8448" } },
      data: { accountId: account.id, accountName: account.name }
    });
    console.log("Updated:", result.count, "records");
  } else {
    console.log("No records found with 信用卡8448");
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
