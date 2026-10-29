/**
 * 信用卡账单周期边界必须与账单日一致 —— `npm run check:credit-cycle`。
 *
 * 用户在账单日设为 31（月末）后看到「2017-06 = 05.01 ~ 05.31、2017-07 =
 * 06.01 ~ 07.31」：邻月被重复覆盖、本月流水没有周期可落、后面每期还被挤成两个月
 * 一期。本脚本对**纯函数**做穷举断言，保证计算层永远产出正确的周期：
 *
 * 1. 账单日 1-31 × 归属期 current/next：每一期的结束日都必须落在自己的账单月
 *    内（`next` 只允许提前到上个月最后一天），并且与上一个月首尾相接；
 * 2. 账单日为 31 时，每期结束日必须是该月最后一天（2 月 28/29、4 月 30 ……）；
 * 3. 账单日历史（规则切换）任意插入点：切换前后的周期仍然满足 1 与 2；
 * 4. `selectConsistentPersistedCycles` 必须丢掉「结束日跑到邻月」的坏周期，以及
 *    顺着那个坏日期推出来的下一期，同时保留真实的手工改期/对账单导入周期。
 */

import assert from "node:assert/strict";
import {
  buildCreditBillCycleDefinitionsFromBillingDayRules,
  isCreditCyclePeriodInStatementMonth,
  selectConsistentPersistedCycles,
  type BillingDayTxPeriod,
} from "../src/lib/credit/billing";

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthKeys(fromYear: number, toYear: number) {
  const months: string[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 1; month <= 12; month++) months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

function lastDayOfMonth(month: string) {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, m!, 0)).getUTCDate();
}

const months = monthKeys(2016, 2017); // 含闰年 2 月
const txPeriods: BillingDayTxPeriod[] = ["current", "next"];

function assertBoundaries(params: {
  label: string;
  rules: Array<{ effectiveDate: Date; billingDay: number }>;
  txPeriod: BillingDayTxPeriod;
}) {
  const definitions = buildCreditBillCycleDefinitionsFromBillingDayRules({
    months,
    billingDayRules: params.rules as never,
    repaymentDay: 20,
    now: new Date(Date.UTC(2026, 9, 29)),
    billingDayTxPeriod: params.txPeriod,
  });
  assert.equal(definitions.size, months.length, `${params.label}: 每个月都要有周期`);

  let previousEnd: Date | null = null;
  for (const month of months) {
    const cycle = definitions.get(month);
    assert.ok(cycle, `${params.label}: ${month} 缺少周期`);
    const [year, monthNumber] = month.split("-").map(Number);

    assert.ok(
      isCreditCyclePeriodInStatementMonth({
        statementMonth: month,
        periodEnd: cycle.end,
        billingDayTxPeriod: params.txPeriod,
      }),
      `${params.label}: ${month} 的结束日 ${ymd(cycle.end)} 不在该账单月内`,
    );
    if (params.txPeriod === "current") {
      assert.ok(
        cycle.end.getUTCFullYear() === year && cycle.end.getUTCMonth() === monthNumber! - 1,
        `${params.label}: ${month} 的结束日 ${ymd(cycle.end)} 落到了邻月`,
      );
    }
    assert.ok(cycle.start <= cycle.end, `${params.label}: ${month} 开始日晚于结束日`);
    if (previousEnd) {
      assert.equal(
        ymd(cycle.start),
        ymd(new Date(previousEnd.getTime() + 86400000)),
        `${params.label}: ${month} 没有接上上一期`,
      );
    }
    previousEnd = cycle.end;
  }
}

// 1 + 2：账单日 1-31，两种归属期，逐月校验
for (let billingDay = 1; billingDay <= 31; billingDay++) {
  for (const txPeriod of txPeriods) {
    assertBoundaries({
      label: `billingDay=${billingDay} txPeriod=${txPeriod}`,
      rules: [{ effectiveDate: new Date(Date.UTC(1900, 0, 1)), billingDay }],
      txPeriod,
    });
  }
}

// 2：月终日必须贴合当月实际天数
for (const txPeriod of txPeriods) {
  const definitions = buildCreditBillCycleDefinitionsFromBillingDayRules({
    months,
    billingDayRules: [{ effectiveDate: new Date(Date.UTC(1900, 0, 1)), billingDay: 31 }] as never,
    repaymentDay: 20,
    now: new Date(Date.UTC(2026, 9, 29)),
    billingDayTxPeriod: txPeriod,
  });
  for (const month of months) {
    const expectedDay = txPeriod === "next" ? lastDayOfMonth(month) - 1 : lastDayOfMonth(month);
    assert.equal(
      definitions.get(month)!.end.getUTCDate(),
      expectedDay,
      `billingDay=31 txPeriod=${txPeriod}: ${month} 应结束于 ${expectedDay} 日`,
    );
  }
}

// 3：账单日历史切换（含 31 与普通日期互换）任意插入点
for (const fromDay of [31, 30, 9, 25]) {
  for (const toDay of [31, 30, 9, 25]) {
    for (let year = 2016; year <= 2017; year++) {
      for (let month = 1; month <= 12; month++) {
        for (const day of [1, 9, 15, 25, 28]) {
          for (const txPeriod of txPeriods) {
            assertBoundaries({
              label: `switch ${fromDay}->${toDay} @ ${year}-${month}-${day} txPeriod=${txPeriod}`,
              rules: [
                { effectiveDate: new Date(Date.UTC(1900, 0, 1)), billingDay: fromDay },
                { effectiveDate: new Date(Date.UTC(year, month - 1, day)), billingDay: toDay },
              ],
              txPeriod,
            });
          }
        }
      }
    }
  }
}

// 4：坏周期识别（用户截图里的形态）
{
  const corrupted = [
    { statementMonth: "2017-05", periodStart: "2017-05-01", periodEnd: "2017-05-31" },
    { statementMonth: "2017-06", periodStart: "2017-05-01", periodEnd: "2017-05-31" },
    { statementMonth: "2017-07", periodStart: "2017-06-01", periodEnd: "2017-07-31" },
    { statementMonth: "2017-08", periodStart: "2017-08-01", periodEnd: "2017-08-31" },
    { statementMonth: "2017-09", periodStart: "2017-09-01", periodEnd: "2017-09-30" },
  ];
  const { accepted, rejectedMonths } = selectConsistentPersistedCycles(corrupted, "current");
  assert.deepEqual(
    Array.from(rejectedMonths).sort(),
    ["2017-06", "2017-07"],
    "结束日跑到邻月的周期、以及顺着它推出来的下一期都必须重算",
  );
  assert.deepEqual(
    accepted.map((cycle) => cycle.statementMonth),
    ["2017-05", "2017-08", "2017-09"],
    "正常的月份不能被误删",
  );
}

// 4b：合法的手工改期 / 对账单导入周期必须保留
{
  const manual = [
    // 账单日 25 的正常周期
    { statementMonth: "2017-05", periodStart: "2017-04-26", periodEnd: "2017-05-25" },
    // 用户手工把这一期改到银行实际日期（同月内），下一期紧接着它
    { statementMonth: "2017-06", periodStart: "2017-05-26", periodEnd: "2017-06-26" },
    { statementMonth: "2017-07", periodStart: "2017-06-27", periodEnd: "2017-07-25" },
  ];
  const { accepted, rejectedMonths } = selectConsistentPersistedCycles(manual, "current");
  assert.equal(rejectedMonths.size, 0, "合法的自定义周期不能被重算");
  assert.equal(accepted.length, manual.length);
}

// 4c：归属期 next（账单日 1 号 → 结束日落在上个月最后一天）必须被接受
{
  const cycles = [
    { statementMonth: "2017-05", periodStart: "2017-04-01", periodEnd: "2017-04-30" },
    { statementMonth: "2017-06", periodStart: "2017-05-01", periodEnd: "2017-05-31" },
  ];
  assert.equal(
    isCreditCyclePeriodInStatementMonth({
      statementMonth: "2017-05",
      periodEnd: "2017-04-30",
      billingDayTxPeriod: "next",
    }),
    true,
    "归属于下个月的交易：账单日前一天结账，属于预期行为",
  );
  const { accepted } = selectConsistentPersistedCycles(cycles, "next");
  assert.equal(accepted.length, 2);
}

console.log("credit cycle boundaries ok");
