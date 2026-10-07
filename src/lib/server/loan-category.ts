import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { LoanTypeValue } from "@/lib/loan-type";

/**
 * 贷款类别（LoanCategory）主数据：2026-10-07 定版
 *
 * 贷款类型从「固定枚举」升级为「可管理的类别」：房贷 / 消费贷 / 抵押贷 / 其他贷款 是每本账簿
 * 的四个**内置类别**（`isSystem = true`），用户可以再自建（车贷、装修贷…），但每个类别必须
 * 绑定一个 `baseType`（口径），由它继承现有的贷款行为：
 * - home     房贷：强制自动扣款 + LPR 折扣
 * - consumer 消费贷：代购放款 + 必选用途分类 + 账单式计划
 * - mortgage 抵押贷：必须关联抵押物
 * - other    其他贷款：可 0 利率、期数可 0（不建计划任务）
 *
 * `Account.loanType` 保留为口径快照（= category.baseType），所有既有行为分支继续读它。
 */

export const BUILTIN_LOAN_CATEGORIES: ReadonlyArray<{
  baseType: LoanTypeValue;
  name: string;
  sortOrder: number;
}> = [
  { baseType: "home", name: "房贷", sortOrder: 0 },
  { baseType: "consumer", name: "消费贷", sortOrder: 1 },
  { baseType: "mortgage", name: "抵押贷", sortOrder: 2 },
  { baseType: "other", name: "其他贷款", sortOrder: 3 },
];

/**
 * 内置类别 id 是**确定性**的：`lc_<householdId>_<baseType>`。
 * PG 迁移、Docker 回填、SQLite 迁移、备份恢复四条路径都按这个规则生成，保证一致且幂等。
 */
export function builtinLoanCategoryId(householdId: string, baseType: LoanTypeValue) {
  return `lc_${householdId}_${baseType}`;
}

/** 与 default-categories 同一写法：普通客户端和事务客户端都能传进来。 */
export type LoanCategoryWriter = typeof prisma | Prisma.TransactionClient;

export type ResolvedLoanCategory = {
  loanCategoryId: string;
  loanType: LoanTypeValue;
};

/**
 * 写入前的类别解析（账户新建/编辑、贷款借入流程统一走这里）：
 * - 显式给了 `loanCategoryId`：必须是本账簿的类别，否则返回 null（上层报错，**不静默兜底**）；
 * - 没给类别但有口径（loanType / isConsumerLoan）：回退到该口径的内置类别；
 * - 返回的 `loanType` 一律取类别的 baseType，保证「口径快照」与类别永远一致。
 */
export async function resolveLoanCategoryForWrite(
  writer: LoanCategoryWriter,
  householdId: string,
  input: { loanCategoryId?: string | null; loanType?: LoanTypeValue | null; isConsumerLoan?: boolean | null },
): Promise<ResolvedLoanCategory | null> {
  await ensureBuiltinLoanCategories(writer, householdId);
  const requestedId = String(input.loanCategoryId ?? "").trim();
  if (requestedId) {
    const category = await writer.loanCategory.findFirst({
      where: { id: requestedId, householdId },
      select: { id: true, baseType: true },
    });
    return category ? { loanCategoryId: category.id, loanType: category.baseType as LoanTypeValue } : null;
  }
  const baseType: LoanTypeValue = input.loanType ?? (input.isConsumerLoan === true ? "consumer" : "home");
  const fallback = await writer.loanCategory.findFirst({
    where: { householdId, baseType },
    select: { id: true, baseType: true },
    orderBy: { sortOrder: "asc" },
  });
  return fallback ? { loanCategoryId: fallback.id, loanType: fallback.baseType as LoanTypeValue } : null;
}

/**
 * 幂等补齐四个内置类别。新账簿、老备份恢复、以及任何"读到类别列表"的地方都先调它，
 * 保证每个 household 至少有这四项（不要去重写用户自建类别）。
 */
export async function ensureBuiltinLoanCategories(writer: LoanCategoryWriter, householdId: string) {
  const existing = await writer.loanCategory.findMany({ where: { householdId }, select: { id: true } });
  const existingIds = new Set(existing.map((row) => row.id));
  const missing = BUILTIN_LOAN_CATEGORIES.filter(
    (category) => !existingIds.has(builtinLoanCategoryId(householdId, category.baseType)),
  );
  if (missing.length === 0) return;
  await writer.loanCategory.createMany({
    data: missing.map((category) => ({
      id: builtinLoanCategoryId(householdId, category.baseType),
      householdId,
      name: category.name,
      baseType: category.baseType,
      sortOrder: category.sortOrder,
      isSystem: true,
      isActive: true,
    })),
  });
}
