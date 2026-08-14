import { prisma } from "../src/lib/db/prisma";
import { getFundNav } from "../src/lib/fund/navCache";
import { getFundConfirmDays } from "../src/lib/fund/confirmDays";
import { addWorkdaysUtc } from "../src/lib/date-utils";

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function test() {
  const accountId = "cmpnh79xe000o7suu6zorfxsq";

  // 查询未确认的基金交易
  const unconfirmedEntries = await prisma.txRecord.findMany({
    where: {
      toAccountId: accountId,
      fundNav: null,
      deletedAt: null,
      OR: [
        { fundSubtype: null },
        { fundSubtype: { in: ["buy"] } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  console.log(`=== 未确认记录 (前10条) ===`);
  console.log(`总数: ${unconfirmedEntries.length}`);

  for (const entry of unconfirmedEntries) {
    if (!entry.fundCode) {
      console.log(`  ${entry.id}: 无基金代码`);
      continue;
    }

    const applyDate = entry.date.toISOString().slice(0, 10);
    const confirmDays = await getFundConfirmDays(accountId, entry.fundCode);
    const confirmDate = addWorkdaysUtc(applyDate, confirmDays);
    const confirmDateObj = utcDate(confirmDate);

    console.log(`\n记录 ${entry.id}:`);
    console.log(`  基金代码: ${entry.fundCode}`);
    console.log(`  申请日期: ${applyDate}`);
    console.log(`  确认天数: T+${confirmDays}`);
    console.log(`  确认日期: ${confirmDate}`);

    // 尝试获取净值
    const navData = await getFundNav(entry.fundCode, confirmDateObj);
    if (navData) {
      console.log(`  净值结果: nav=${navData.nav}, dateMatch=${navData.dateMatch}`);
      if (!navData.dateMatch) {
        console.log(`  → 失败原因: 净值日期不匹配（API返回的不是确认日期的净值）`);
      }
    } else {
      console.log(`  净值结果: null（API无数据）`);
    }
  }

  await (prisma as any).$disconnect();
}

test().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});