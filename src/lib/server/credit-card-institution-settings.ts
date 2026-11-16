import { AccountKind, type CreditBillMode, type CreditBillingDayTxPeriod, type Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type AccountWriter = typeof prisma | Prisma.TransactionClient;

const CREDIT_BILL_MODE_SEPARATE: CreditBillMode = "separate";
const CREDIT_BILL_MODE_CONSOLIDATED: CreditBillMode = "consolidated";

type CreditCardInstitutionDefaults = {
  billingDay: number | null;
  repaymentDay: number | null;
  repaymentOffsetDays: number | null;
  creditLimit: string | null;
  creditBillMode: CreditBillMode;
  billingDayTxPeriod: CreditBillingDayTxPeriod;
};

export function normalizeCreditBillMode(value: unknown): CreditBillMode {
  return String(value ?? "").trim() === CREDIT_BILL_MODE_CONSOLIDATED
    ? CREDIT_BILL_MODE_CONSOLIDATED
    : CREDIT_BILL_MODE_SEPARATE;
}

export function normalizeCreditBillingDayTxPeriod(value: unknown): CreditBillingDayTxPeriod {
  return String(value ?? "").trim() === "next" ? "next" : "current";
}

export async function getCreditCardInstitutionDefaults(
  writer: AccountWriter,
  householdId: string,
  institutionId: string | null | undefined,
  options?: { excludeAccountId?: string; groupId?: string | null },
): Promise<CreditCardInstitutionDefaults | null> {
  if (!institutionId) return null;
  const accounts = await writer.account.findMany({
    where: {
      householdId,
      institutionId,
      kind: AccountKind.bank_credit,
      isActive: true,
      // 新建信用卡的默认值只在「同机构 + 同所有人」内继承。
      ...(options?.groupId ? { groupId: options.groupId } : {}),
      ...(options?.excludeAccountId ? { NOT: { id: options.excludeAccountId } } : {}),
    },
    select: {
      billingDay: true,
      repaymentDay: true,
      repaymentOffsetDays: true,
      creditLimit: true,
      creditBillMode: true,
      billingDayTxPeriod: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (accounts.length === 0) return null;
  const template = [...accounts].sort((a, b) => {
    const completeness = (row: typeof a) =>
      Number(row.billingDay != null) +
      Number(row.repaymentDay != null || row.repaymentOffsetDays != null) +
      Number(row.creditLimit != null);
    return completeness(b) - completeness(a) || b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0];
  return {
    billingDay: template.billingDay,
    repaymentDay: template.repaymentDay,
    repaymentOffsetDays: template.repaymentOffsetDays,
    creditLimit: template.creditLimit?.toString() ?? null,
    creditBillMode: template.creditBillMode,
    billingDayTxPeriod: template.billingDayTxPeriod,
  };
}

export async function syncCreditCardInstitutionSettings(
  writer: AccountWriter,
  input: {
    householdId: string;
    institutionId: string | null | undefined;
    billingDay?: number | null;
    repaymentDay: number | null;
    repaymentOffsetDays?: number | null;
    creditBillMode: CreditBillMode;
    billingDayTxPeriod?: CreditBillingDayTxPeriod;
    groupId?: string | null;
  },
) {
  if (!input.institutionId) return;
  const data: Prisma.AccountUpdateManyMutationInput = {
    repaymentDay: input.repaymentDay,
    creditBillMode: input.creditBillMode,
    ...(Object.prototype.hasOwnProperty.call(input, "billingDay")
      ? { billingDay: input.billingDay ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "repaymentOffsetDays")
      ? { repaymentOffsetDays: input.repaymentOffsetDays ?? null }
      : {}),
    ...(input.billingDayTxPeriod ? { billingDayTxPeriod: input.billingDayTxPeriod } : {}),
  };
  // 同步范围与账单分组一致：同机构 + 同所有人。改 A 的账单模式不能把 B 的卡
  // 一起改成合并账单。
  await writer.account.updateMany({
    where: {
      householdId: input.householdId,
      institutionId: input.institutionId,
      kind: AccountKind.bank_credit,
      ...(input.groupId ? { groupId: input.groupId } : {}),
    },
    data,
  });
}

/**
 * 合并账单的分组键：同 household + 同机构 + **同所有人**。
 *
 * 「所有人」就是 `Account.groupId`（`AccountGroup`，比如「付斌」「墨斗鱼」「amanda」）。
 * 不同家庭成员在同一家银行各出各的账单，所以组键必须带 groupId —— 只按
 * household + 机构分组会把两个人的卡并成一份账单（2026-11-16 用户再次强调）。
 * 这里不引入 `userId`：本账簿里所有人一律由 groupId 表达，两套口径并存只会
 * 在 groupId 相同、userId 不同时又分叉。
 *
 * `institutionId` / `groupId` 任一缺失时返回 null，调用方必须退化成「单卡」，
 * 绝不允许退化成「同机构全量合并」。
 */
export function creditBillGroupKey(account: {
  householdId: string;
  institutionId?: string | null;
  groupId?: string | null;
}): string | null {
  if (!account.institutionId || !account.groupId) return null;
  return `${account.householdId}|${account.institutionId}|${account.groupId}`;
}

export async function getCreditBillAccountIds(
  writer: AccountWriter,
  account: {
    id: string;
    householdId: string;
    institutionId: string | null;
    kind: AccountKind;
    creditBillMode: CreditBillMode;
    groupId?: string | null;
  },
) {
  if (
    account.kind !== AccountKind.bank_credit ||
    account.creditBillMode !== CREDIT_BILL_MODE_CONSOLIDATED ||
    !account.institutionId
  ) {
    return [account.id];
  }
  // 合并账单 = 同机构 + 同所有人（AccountGroup）。不同家庭成员在同一家银行的
  // 信用卡各出各的账单；groupId 缺失时按账户 id 回查一次，查不到就退回单卡，
  // 绝不退化成「同机构全量合并」。
  const groupId = account.groupId ?? (await writer.account.findFirst({
    where: { id: account.id, householdId: account.householdId },
    select: { groupId: true },
  }))?.groupId ?? null;
  if (!groupId) return [account.id];
  const rows = await writer.account.findMany({
    where: {
      householdId: account.householdId,
      institutionId: account.institutionId,
      groupId,
      kind: AccountKind.bank_credit,
      creditBillMode: CREDIT_BILL_MODE_CONSOLIDATED,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.length > 0 ? rows.map((row) => row.id) : [account.id];
}
