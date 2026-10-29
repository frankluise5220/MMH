/**
 * 分期条目的账单月归属只能有一个口径 —— `npm run check:credit-installment`。
 *
 * 用户报告过的现象：账单日调整之后，同一分期计划的期供行散落在两个账单月，
 * 账单表的金额与分期计划总额对不上。根因是归属算法有三份：
 * 1. `normalizeCreditCardInstallmentStatementMonths` 用**账户当前**账单日；
 * 2. `materializeDueInstallmentPayments` 用**建计划时**的快照账单日；
 * 3. 账单表的周期由**账单日规则链**按日期回溯算出。
 * 1 与 2 互相打架，且都不等于 3。
 *
 * 现在两者共用 `creditInstallmentStatementMonthForDate`（按条目日期回溯规则历史）。
 * 本脚本断言：
 * 1. 规则历史变化后，历史条目按当时的账单日归属，不受当前账单日影响；
 * 2. 归属期 current / next 的边界与账单期边界一致；
 * 3. 两个写入入口都走同一个纯函数（静态检查，防止再长出第二份实现）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { creditInstallmentStatementMonthForDate } from "../src/lib/credit/installment";
import { billingDayAtDate } from "../src/lib/credit/billing";
import { toStatementMonth } from "../src/lib/date-utils";

const rules = [
  { effectiveDate: new Date(Date.UTC(1900, 0, 1)), billingDay: 9 },
  { effectiveDate: new Date(Date.UTC(2026, 4, 1)), billingDay: 31 },
];

function ymd(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

// 1：历史条目按当时的账单日归属（2017 年账单日为 9 号）
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2017-06-10"),
    billingDayRules: rules,
    fallbackBillingDay: 31,
  }),
  "2017-07",
  "2017-06-10 在 9 号账单日下属于 2017-07 账单，不能被当前账单日 31 拉到 2017-06",
);
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2017-06-09"),
    billingDayRules: rules,
    fallbackBillingDay: 31,
  }),
  "2017-06",
  "账单日当天按 current 归属本期",
);
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2026-06-10"),
    billingDayRules: rules,
    fallbackBillingDay: 9,
  }),
  "2026-06",
  "账单日改为 31 之后，2026-06-10 属于 2026-06",
);

// 2：归属期 next 的边界与账单期一致（账单日当天的交易归下一期）
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2017-06-09"),
    billingDayRules: rules,
    fallbackBillingDay: 31,
    billingDayTxPeriod: "next",
  }),
  "2017-07",
  "billingDayTxPeriod=next 时账单日当天归下一期",
);

// 月末账单日的极端月份：2 月只有 28 天，按 31 号账单日归属仍在 2 月
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2027-02-27"),
    billingDayRules: rules,
    fallbackBillingDay: 9,
  }),
  "2027-02",
  "31 号账单日在 2 月夹到 02-28，02-27 仍属 2027-02 账单",
);
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2027-02-28"),
    billingDayRules: rules,
    fallbackBillingDay: 9,
  }),
  "2027-02",
  "月末当天归本期账单",
);
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2027-03-01"),
    billingDayRules: rules,
    fallbackBillingDay: 9,
  }),
  "2027-03",
  "越过月末后归下一期",
);

// 3：没有规则历史时回落到账户账单日，且与 toStatementMonth 同源
assert.equal(
  creditInstallmentStatementMonthForDate({
    date: ymd("2026-02-28"),
    billingDayRules: [],
    fallbackBillingDay: 31,
  }),
  toStatementMonth(ymd("2026-02-28"), 31, null),
  "无规则时回落到账单日字段，口径与账单期一致",
);
assert.equal(
  billingDayAtDate(rules, ymd("2017-06-10"), 31),
  9,
  "billingDayAtDate 必须按日期回溯",
);

// 4：静态检查——两个写入入口只能调用同一个纯函数
const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/lib/server/credit-card-installment.ts"),
  "utf8",
);
const sharedCalls = source.match(/creditInstallmentStatementMonthForDate\(/g)?.length ?? 0;
assert.ok(
  sharedCalls >= 2,
  "normalize 与 materialize 都必须走 creditInstallmentStatementMonthForDate",
);
const directCalls = source.match(/(?<![\w.])toStatementMonth\(/g)?.length ?? 0;
assert.ok(
  directCalls <= 1,
  "除回退兜底外不允许再自己调 toStatementMonth 算分期归属（会重新长出第二份口径）",
);

console.log("credit installment statement month ok");
