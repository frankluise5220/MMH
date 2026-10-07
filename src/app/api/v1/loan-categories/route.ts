/**
 * GET /api/v1/loan-categories
 *
 * 贷款类别（LoanCategory）列表：房贷 / 消费贷 / 抵押贷 / 其他贷款 四个内置类别（2026-10-07 定版）。
 * 内置类别是**固有**的，用户不新增，所以这里只提供读取；读取时顺带幂等补齐内置类别，
 * 保证新建账簿、老备份恢复之后也一定有这四项。
 *
 * 展示名：内置类别（isSystem）请按 `loan.type.<baseType>` 走 i18n 文案；自建类别用 name。
 *
 * Response 200: { ok: true, categories: [{ id, name, baseType, sortOrder, isSystem, isActive }] }
 * Response 500: { ok: false, code, error }
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ensureBuiltinLoanCategories } from "@/lib/server/loan-category";

export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    await ensureBuiltinLoanCategories(prisma, householdId);
    const categories = await prisma.loanCategory.findMany({
      where: { householdId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, baseType: true, sortOrder: true, isSystem: true, isActive: true },
    });
    return NextResponse.json({ ok: true, categories });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read loan categories";
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: message }, { status: 500 });
  }
}
