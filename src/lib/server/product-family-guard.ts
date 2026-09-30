/**
 * 产品家族守卫：跨家族的产品主数据不得混挂（2026-09-30 用户裁定）。
 *
 * 已确立的家族契约：
 * - **保险家族** `InsuranceProductMaster`：承保机构必须是保险公司（`institution.type === "insurance"`），
 *   违反 → 400 `INSTITUTION_NOT_INSURER`（见 `src/app/api/v1/insurance-products/route.ts`）。
 * - **理财家族** `WealthProduct`：**不得出现保险产品**——即不得挂在保险公司名下，
 *   违反 → 400 `INSTITUTION_IS_INSURER`，列表侧同时做排除，避免历史遗留数据回流。
 *
 * 为什么判据是「机构类型」而不是「产品名」：`WealthProduct` 上没有家族判别字段
 * （`productType` 在 `20260917_add_wealth_bond_fields` 之后已随债券拆表移除），
 * 唯一的结构性信号就是所属机构；用名称关键词判定会把「养老保障管理产品」这类
 * 银行代销的非保险产品误伤。
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export const INSURER_INSTITUTION_TYPES = ["insurance"] as const;

export type ProductFamilyGuardError = {
  ok: false;
  code: string;
  error: string;
};

/** 本户全部保险公司（`type='insurance'`）的机构 id。 */
export async function listInsurerInstitutionIds(householdId: string): Promise<string[]> {
  const rows = await prisma.institution.findMany({
    where: { householdId, type: { in: [...INSURER_INSTITUTION_TYPES] } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * 「不属于保险公司」的产品筛选片段（理财家族列表专用）。
 *
 * ⚠️ 不能简写成 `{ NOT: { institutionId: { in: insurerIds } } }`：
 * `institutionId` 为 NULL 时 `NULL IN (...)` 求值为 NULL，`NOT NULL` 仍是 NULL（不是 true），
 * 会把「未指定机构」的产品一并滤掉。故必须显式放行 NULL。
 */
export function notInsurerOwnedFilter(insurerIds: string[]): Prisma.WealthProductWhereInput {
  if (insurerIds.length === 0) return {};
  return { OR: [{ institutionId: null }, { NOT: { institutionId: { in: insurerIds } } }] };
}

export function isInsurerInstitution(institution: { type: string | null } | null | undefined): boolean {
  return !!institution?.type && (INSURER_INSTITUTION_TYPES as readonly string[]).includes(institution.type);
}

/** 理财家族把产品挂到保险公司名下时的统一响应体（配 400）。 */
export function insurerInstitutionError(): ProductFamilyGuardError {
  return {
    ok: false,
    code: "INSTITUTION_IS_INSURER",
    error: "保险公司只能登记保险产品，请到保险产品的产品管理里新增",
  };
}
