import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope, type HouseholdContext } from "@/lib/server/household-scope";
import { verifySensitiveOperationPassword } from "@/lib/server/sensitive-operation-auth";
import {
  cascadeDeleteProductRecords,
  summarizeProductRefs,
  type ProductFamily,
} from "@/lib/server/product-master-refs";

export type ProductDeleteOutcome = {
  status: number;
  payload: Record<string, unknown>;
};

/** 按产品家族取产品主数据行（存款 / 理财 / 债券共用）。 */
export async function findProductRow(
  family: ProductFamily,
  householdId: string,
  productId: string,
): Promise<{ id: string; name: string; institutionId: string | null } | null> {
  if (family === "deposit") {
    return prisma.depositProduct.findFirst({
      where: { id: productId, householdId },
      select: { id: true, name: true, institutionId: true },
    });
  }
  if (family === "wealth") {
    return prisma.wealthProduct.findFirst({
      where: { id: productId, householdId },
      select: { id: true, name: true, institutionId: true },
    });
  }
  return prisma.bondProduct.findFirst({
    where: { id: productId, householdId },
    select: { id: true, name: true, institutionId: true },
  });
}

/**
 * 存款 / 理财 / 债券产品主数据的统一删除流程（带引用保护）。
 *
 * 三个家族的引用保护语义完全一致，因此抽成一处，避免三份拷贝各自漂移：
 * 1. 未被引用 → 直接物理删除。
 * 2. 被引用且未确认 → 409 `PRODUCT_HAS_LINKED_DATA`，回传各项计数。
 * 3. 被引用且已确认 → 校验当前用户密码 → 走余额安全的级联清理 → 再删产品行。
 *
 * `remove` 由调用方注入，只负责删除产品主数据行本身。
 */
export async function deleteProductMaster(input: {
  family: ProductFamily;
  productId: string;
  body: { cascade?: boolean; password?: string } | null;
  remove: (ctx: HouseholdContext) => Promise<void>;
}): Promise<ProductDeleteOutcome> {
  const { family, productId } = input;
  const scope = await getHouseholdScope();
  const { householdId } = scope;

  const product = await findProductRow(family, householdId, productId);
  if (!product) {
    return { status: 404, payload: { ok: false, code: "PRODUCT_NOT_FOUND", error: "产品不存在" } };
  }

  const cascade = input.body?.cascade === true;
  const refs = await summarizeProductRefs(householdId, family, productId);

  if (refs.referenced && !cascade) {
    return {
      status: 409,
      payload: {
        ok: false,
        code: "PRODUCT_HAS_LINKED_DATA",
        needCascade: true,
        refs,
        error: `该产品下还有 ${refs.lotCount} 笔持仓、${refs.entryCount} 条记录、${refs.planCount} 个计划任务，请勾选「同时删除关联记录」后再确认`,
      },
    };
  }

  if (refs.referenced) {
    const password = String(input.body?.password ?? "").trim();
    if (!password) {
      return {
        status: 409,
        payload: {
          ok: false,
          code: "DELETE_PASSWORD_REQUIRED",
          needPassword: true,
          refs,
          error: "请输入当前用户密码确认删除",
        },
      };
    }
    const verification = await verifySensitiveOperationPassword(password);
    if (!verification.ok) {
      return {
        status: verification.status ?? 401,
        payload: {
          ok: false,
          code: verification.code ?? "INVALID_PASSWORD",
          error: verification.error ?? "密码错误",
        },
      };
    }
    await cascadeDeleteProductRecords(scope, family, productId);
  }

  await input.remove(scope);
  return { status: 200, payload: { ok: true, data: { id: productId, cascaded: refs.referenced } } };
}
