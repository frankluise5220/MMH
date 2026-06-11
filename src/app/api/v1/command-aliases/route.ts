/**
 * 命令别名管理 API
 *
 * GET  /api/v1/command-aliases?category=fundSubtype → 列出别名
 * POST /api/v1/command-aliases                         → 设置别名 { category, key, value }
 */
import { NextRequest, NextResponse } from "next/server";
import { listAliases, setAlias, deleteAlias } from "@/lib/commandAlias";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category")?.trim() || undefined;
  const data = await listAliases(category);
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { category, key, value } = body;
    if (!category || !key || !value) {
      return NextResponse.json({ ok: false, error: "缺少 category/key/value" }, { status: 400 });
    }
    if (body._action === "delete") {
      const ok = await deleteAlias(category, key);
      return NextResponse.json({ ok, deleted: ok });
    }
    await setAlias(category, String(key).trim(), String(value).trim());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}
