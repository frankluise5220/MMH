import { AccountKind, type AccountCardRole, type CreditBillMode, type CreditBillingDayTxPeriod, type Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type AccountWriter = typeof prisma | Prisma.TransactionClient;

const CREDIT_BILL_MODE_SEPARATE: CreditBillMode = "separate";
const CREDIT_BILL_MODE_CONSOLIDATED: CreditBillMode = "consolidated";
const CREDIT_BILL_MODE_SUPPLEMENTARY: CreditBillMode = "supplementary";

type CreditCardInstitutionDefaults = {
  billingDay: number | null;
  repaymentDay: number | null;
  repaymentOffsetDays: number | null;
  creditLimit: string | null;
  creditBillMode: CreditBillMode;
  billingDayTxPeriod: CreditBillingDayTxPeriod;
};

export function normalizeCreditBillMode(value: unknown): CreditBillMode {
  const mode = String(value ?? "").trim();
  if (mode === CREDIT_BILL_MODE_CONSOLIDATED) return CREDIT_BILL_MODE_CONSOLIDATED;
  if (mode === CREDIT_BILL_MODE_SUPPLEMENTARY) return CREDIT_BILL_MODE_SUPPLEMENTARY;
  return CREDIT_BILL_MODE_SEPARATE;
}

/** 卡别：与账单模式并存的独立属性；未知值一律视为主卡（存量账户也是主卡）。 */
export function normalizeAccountCardRole(value: unknown): AccountCardRole {
  return String(value ?? "").trim() === "supplementary" ? "supplementary" : "primary";
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
      // 附属卡不提供默认值：它的账单参数归主卡，不能被新建卡继承成
      // mode=supplementary（那样新卡会莫名其妙挂到别人的主卡上）。
      creditBillMode: { not: CREDIT_BILL_MODE_SUPPLEMENTARY },
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
    cardRole?: string | null;
    billingDayTxPeriod?: CreditBillingDayTxPeriod;
    groupId?: string | null;
  },
) {
  if (!input.institutionId) return;
  // 附属卡不属于「同机构同所有人」批量同步的范围：每张附属卡各挂自己的主卡。
  // 从附属卡出发同步会把同机构所有卡一起改成 supplementary；把 mode 同步给
  // 附属卡又会把它的主卡指向冲掉。两种方向都必须挡住。
  if (input.cardRole === "supplementary" || input.creditBillMode === CREDIT_BILL_MODE_SUPPLEMENTARY) return;
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
      // 附属卡不被主卡的规则变更波及（否则会把 mode 改回 consolidated）。
      cardRole: { not: "supplementary" },
      creditBillMode: { not: CREDIT_BILL_MODE_SUPPLEMENTARY },
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

type CreditBillAccountInput = {
  id: string;
  householdId: string;
  institutionId: string | null;
  kind: AccountKind;
  creditBillMode: CreditBillMode;
  /** 卡别=附属卡必然并入主卡账单；billMode=supplementary 仅作历史数据兼容。 */
  cardRole?: string | null;
  groupId?: string | null;
  primaryCardId?: string | null;
};

/** 附属卡判定：卡别优先，兼容尚未回填卡别的历史账单模式=附属卡数据。 */
function isSupplementaryBillAccount(account: Pick<CreditBillAccountInput, "cardRole" | "creditBillMode">) {
  return account.cardRole === "supplementary" || account.creditBillMode === CREDIT_BILL_MODE_SUPPLEMENTARY;
}

const CREDIT_BILL_ACCOUNT_SELECT = {
  id: true,
  householdId: true,
  institutionId: true,
  groupId: true,
  kind: true,
  creditBillMode: true,
  cardRole: true,
  primaryCardId: true,
} as const;

/** 独立账单 / 合并账单本身的一组账户 id（不含附属卡），[0] 是账单存储账户。 */
async function baseCreditBillAccountIds(writer: AccountWriter, account: CreditBillAccountInput) {
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

/**
 * 一份账单涉及的**全部**账户 id，[0] 恒为账单存储账户（主卡）。
 *
 * - 独立账单：只有自己；
 * - 合并账单：同机构 + 同所有人的卡；
 * - 附属卡（2026-11-22 裁定）：卡别=附属卡时无条件并入指定主卡账单，没有例外，
 *   账单模式对附属卡不再可选。主卡独立账单时 = 主卡 + 挂它的附属卡；主卡合并账单时
 *   = 整个合并组 + 挂组内任意卡的附属卡。
 *
 * 主卡 id 缺失 / 跨 household / 非信用卡 / 又是附属卡时，附属卡退化成单卡，
 * 绝不退化成「同机构全量合并」。
 */
export async function getCreditBillAccountIds(
  writer: AccountWriter,
  account: CreditBillAccountInput,
): Promise<string[]> {
  if (!account || account.kind !== AccountKind.bank_credit) return [account.id];

  let billOwner: CreditBillAccountInput = account;
  if (isSupplementaryBillAccount(account)) {
    if (!account.primaryCardId || account.primaryCardId === account.id) return [account.id];
    const primary = await writer.account.findFirst({
      where: {
        id: account.primaryCardId,
        householdId: account.householdId,
        kind: AccountKind.bank_credit,
        // 不允许附属卡再挂附属卡：链路只能一层，避免成环/递归。
        cardRole: { not: "supplementary" },
        creditBillMode: { not: CREDIT_BILL_MODE_SUPPLEMENTARY },
      },
      select: CREDIT_BILL_ACCOUNT_SELECT,
    });
    if (!primary) return [account.id];
    billOwner = primary;
  }

  const baseIds = await baseCreditBillAccountIds(writer, billOwner);
  const supplements = await writer.account.findMany({
    where: {
      householdId: account.householdId,
      kind: AccountKind.bank_credit,
      OR: [{ cardRole: "supplementary" }, { creditBillMode: CREDIT_BILL_MODE_SUPPLEMENTARY }],
      primaryCardId: { in: baseIds },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const supplementIds = supplements.map((row) => row.id).filter((id) => !baseIds.includes(id));
  const result = [...baseIds, ...supplementIds];
  return result.length > 0 ? result : [account.id];
}
