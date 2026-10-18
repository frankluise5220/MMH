import { prisma } from "@/lib/db/prisma";
import {
  DEFAULT_FUND_REDEEM_COST_DAYS,
  formatFundEffectiveDate,
  fundArrivalDate,
  fundConfirmDate,
  normalizeNonNegativeDays,
  resolveFundTradingCalendar,
  type FundConfirmRule,
  type FundDates,
} from "./fund-dates";

/**
 * 基金确认日/到账日（T+N）的唯一数据源：`FundConfirmDays`（accountId + fundCode）。
 *
 * 规则：
 * - 读取一律走本模块，不要再用 `Account.defaultConfirmDays/defaultArrivalDays`、
 *   `RegularInvestPlan.confirmDays/arrivalDays` 作为第二来源。
 * - 记账口径：确认日 = 申请日 + days 个交易日；到账日 = 确认日 + arrivalDays 个交易日。
 *   交易日按账户 `tradingCalendar`（缺省 `cn_fund`）计算，服务端与前端必须同一个算法。
 * - 纯计算部分在 `./fund-dates`（无 prisma），客户端组件必须从那里 import，
 *   否则会把 better-sqlite3 的原生依赖打进浏览器包（构建报 Can't resolve 'fs'）。
 */

// 纯函数/常量/类型仍从这里转出，服务端调用方的既有 import 不受影响。
export * from "./fund-dates";

export async function getFundConfirmDays(accountId: string, fundCode: string): Promise<number> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
    select: { days: true },
  });
  return normalizeNonNegativeDays(record?.days, 0);
}

export async function getFundArrivalDays(accountId: string, fundCode: string): Promise<number> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
    select: { arrivalDays: true },
  });
  return normalizeNonNegativeDays(record?.arrivalDays, 2);
}

export async function getFundConfirmRule(accountId: string, fundCode: string): Promise<FundConfirmRule> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
    select: { days: true, arrivalDays: true, redeemCostDays: true, effectiveDate: true, manualOverride: true },
  });
  return {
    days: normalizeNonNegativeDays(record?.days, 0),
    arrivalDays: normalizeNonNegativeDays(record?.arrivalDays, 2),
    redeemCostDays: normalizeNonNegativeDays(record?.redeemCostDays, DEFAULT_FUND_REDEEM_COST_DAYS),
    effectiveDate: formatFundEffectiveDate(record?.effectiveDate),
    manualOverride: Boolean(record?.manualOverride),
    exists: record != null,
  };
}

export type FundDateContext = {
  days: number;
  arrivalDays: number;
  tradingCalendar: string;
  /** 用户已在设置页「基金确认日」表保存过 → 自动写入路径不再覆盖。 */
  manualOverride: boolean;
};

/** 只取规则（天数 + 交易日历），适合一个账户内批量推算多个日期。 */
export async function getFundDateContext(accountId: string, fundCode: string): Promise<FundDateContext> {
  const [record, account] = await Promise.all([
    prisma.fundConfirmDays.findUnique({
      where: { accountId_fundCode: { accountId, fundCode } },
      select: { days: true, arrivalDays: true, manualOverride: true },
    }),
    prisma.account.findUnique({
      where: { id: accountId },
      select: { tradingCalendar: true },
    }),
  ]);
  return {
    days: normalizeNonNegativeDays(record?.days, 0),
    arrivalDays: normalizeNonNegativeDays(record?.arrivalDays, 2),
    tradingCalendar: resolveFundTradingCalendar(account?.tradingCalendar),
    manualOverride: Boolean(record?.manualOverride),
  };
}

/**
 * 一次性解析「确认日 + 到账日」。所有需要按 T+N 推进日期的服务端流程都应调用这里，
 * 不要各自组合 getFundConfirmDays / addWorkdaysUtc。
 */
export async function resolveFundDates(
  accountId: string,
  fundCode: string,
  applyDateYmd: string,
): Promise<FundDates> {
  const { days, arrivalDays, tradingCalendar: calendar } = await getFundDateContext(accountId, fundCode);
  const confirmDate = fundConfirmDate(applyDateYmd, days, calendar);
  return {
    days,
    arrivalDays,
    tradingCalendar: calendar,
    confirmDate,
    arrivalDate: fundArrivalDate(confirmDate, arrivalDays, calendar),
  };
}

/**
 * 用确认库的值覆盖计划上的 confirmDays/arrivalDays 后再下发给界面。
 * 计划表不再是 T+N 的来源，读出时一律按 (accountId, fundCode) 补成规则表的值。
 */
export async function withFundDateRules<T extends { accountId: string; fundCode: string | null }>(
  plans: T[],
): Promise<Array<T & { confirmDays: number; arrivalDays: number }>> {
  const targets = plans
    .filter((plan) => plan.fundCode)
    .map((plan) => ({ accountId: plan.accountId, fundCode: String(plan.fundCode) }));
  const rules = targets.length > 0
    ? await prisma.fundConfirmDays.findMany({
        where: { OR: targets },
        select: { accountId: true, fundCode: true, days: true, arrivalDays: true },
      })
    : [];
  const ruleByKey = new Map(rules.map((rule) => [`${rule.accountId}|${rule.fundCode}`, rule]));
  return plans.map((plan) => {
    const rule = plan.fundCode ? ruleByKey.get(`${plan.accountId}|${plan.fundCode}`) : undefined;
    return {
      ...plan,
      confirmDays: rule?.days ?? 0,
      arrivalDays: rule?.arrivalDays ?? 2,
    };
  });
}

export type FundDateRuleWrite = {
  days?: number | null;
  arrivalDays?: number | null;
};

/**
 * 自动写入路径（投资交易表单、定投表单、导入、初始化）共用。
 *
 * 规则：**库里已有该 accountId + fundCode 的行就永不改写**——T+N 只在第一次
 * 建行时赋值（首次赋值 = 表单里当时填的 T+N 或日期差），此后只有设置页
 * 「基金确认日」表能改。交易表单于是只能改自己的记录日期，不会动全局 T+N。
 * 返回是否真的写入了。
 */
async function applyFundDateRuleAuto(
  client: any,
  accountId: string,
  fundCode: string,
  values: FundDateRuleWrite,
): Promise<boolean> {
  const data: { days?: number; arrivalDays?: number } = {};
  if (values.days != null && Number.isFinite(Number(values.days))) {
    data.days = normalizeNonNegativeDays(values.days, 0);
  }
  if (values.arrivalDays != null && Number.isFinite(Number(values.arrivalDays))) {
    data.arrivalDays = normalizeNonNegativeDays(values.arrivalDays, 2);
  }
  if (Object.keys(data).length === 0) return false;

  const where = { accountId_fundCode: { accountId, fundCode } };
  const existing = await client.fundConfirmDays.findUnique({
    where,
    select: { id: true },
  });
  // 已有行：静默跳过（不能抛错，否则会毒化外层事务）。
  if (existing) return false;
  // 不存在则建行（第一次、也是唯一一次赋值）；并发下用 upsert + 空 update，避免唯一键冲突把事务打挂。
  await client.fundConfirmDays.upsert({
    where,
    create: {
      accountId,
      fundCode,
      days: data.days ?? 0,
      ...(data.arrivalDays != null ? { arrivalDays: data.arrivalDays } : {}),
    },
    update: {},
  });
  return true;
}

export async function setFundDateRuleAuto(accountId: string, fundCode: string, values: FundDateRuleWrite): Promise<boolean> {
  return applyFundDateRuleAuto(prisma, accountId, fundCode, values);
}

export async function setFundDateRuleAutoInTx(tx: any, accountId: string, fundCode: string, values: FundDateRuleWrite): Promise<boolean> {
  return applyFundDateRuleAuto(tx, accountId, fundCode, values);
}

