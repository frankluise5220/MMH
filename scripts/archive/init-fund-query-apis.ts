/**
 * 初始化基金查询 API 预设数据
 * 运行: npx tsx scripts/init-fund-query-apis.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

async function main() {
  const { prisma } = await import("../src/lib/db/prisma");

  const apis = [
    {
      code: "eastmoney",
      name: "天天基金",
      baseUrl: "http://fundgz.1234567.com.cn/js/{code}.js",
      priority: 1,
      isActive: true,
    },
    {
      code: "eastmoney_history",
      name: "东方财富历史净值",
      baseUrl: "http://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=5&startDate={date}&endDate={date}",
      priority: 2,
      isActive: true,
    },
    {
      code: "danjuan",
      name: "蛋卷基金",
      baseUrl: "https://danjuanfunds.com/djapi/fund/{code}",
      priority: 3,
      isActive: false,
    },
    {
      code: "sina",
      name: "新浪基金",
      baseUrl: "https://finance.sina.com.cn/fund/api/openapi/{code}/nav",
      priority: 4,
      isActive: false,
    },
    {
      code: "alipay",
      name: "支付宝基金",
      baseUrl: "https://fundapi.eastmoney.com/fundapi/{code}/nav",
      priority: 5,
      isActive: false,
    },
  ];

  for (const api of apis) {
    await prisma.fundQueryApi.upsert({
      where: { code: api.code },
      create: api,
      update: {
        name: api.name,
        baseUrl: api.baseUrl,
        priority: api.priority,
      },
    });
    console.log(`已初始化: ${api.code} - ${api.name}`);
  }

  console.log("\n初始化完成，共", apis.length, "条API记录");
  await prisma.$disconnect();
}

main();