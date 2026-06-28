import { NextResponse } from "next/server";
import { revalidateAfterTxChange, revalidateAfterInvestChange, revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/revalidate
 *
 * 强制刷新服务端缓存（unstable_cache / revalidateTag）。
 * 用于在数据库被外部工具直接修改后，让 Web 重新读取最新数据。
 * 仅管理员可操作。
 *
 * Response:
 *   { ok: true } 成功
 *   { ok: false, error } 失败
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || !isAdmin(user)) {
    return NextResponse.json(
      { ok: false, error: "仅管理员可执行此操作" },
      { status: 403 },
    );
  }

  try {
    revalidateAfterTxChange();
    revalidateAfterInvestChange();
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "刷新缓存失败" },
      { status: 500 },
    );
  }
}
