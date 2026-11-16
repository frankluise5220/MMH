import { NextRequest, NextResponse } from "next/server";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  deleteStatementImportDuplicates,
  detectStatementImportDuplicates,
  type StatementDuplicateItemLike,
} from "@/lib/server/statement-import-duplicates";

export const runtime = "nodejs";

/**
 * POST /api/v1/statement/import/duplicates
 *
 * 账单导入前的「重复交易」检查（全项目唯一的判重出口）：
 *   - action=check（默认）：按「日期 + 交易身份」分组，组内笔数一致、再比金额一致才算重复。
 *     转账的身份是 A→B（转出账户 → 转入账户，方向敏感），支出/收入/投资的身份是账户 + 类型；
 *   - action=delete        ：用户选了「覆盖」，软删除这些记录（只认上面检测出来的 id）。
 *
 * Body: { items, action?: "check" | "delete", recordIds?: string[] }
 * Response: { ok: true, total, groups } | { ok: true, deleted }
 *
 * 为什么单独一个接口，而不是塞进 /statement/import：明细页导入是分批提交的，
 * 单批只看到 1/10 的数据，重复判断会漏；这里一次拿到全部行，判定才是全量的。
 */
export async function POST(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    items?: StatementDuplicateItemLike[];
    action?: string;
    recordIds?: string[];
  };
  const items = Array.isArray(body.items) ? body.items.slice(0, 5000) : [];
  if (items.length === 0) {
    return NextResponse.json({ ok: true, total: 0, groups: [], deleted: 0 });
  }

  const detected = await detectStatementImportDuplicates(householdId, items);

  if (body.action === "delete") {
    // 只删本次检测出来的记录：客户端传来的 id 必须落在检测结果里，避免误删。
    const allowed = new Set(detected.groups.flatMap((group) => group.recordIds));
    const ids = (Array.isArray(body.recordIds) ? body.recordIds : []).filter(
      (id): id is string => typeof id === "string" && allowed.has(id),
    );
    const deleted = await deleteStatementImportDuplicates(householdId, ids);
    return NextResponse.json({ ok: true, deleted, total: detected.total, groups: detected.groups });
  }

  return NextResponse.json({ ok: true, total: detected.total, groups: detected.groups });
}
