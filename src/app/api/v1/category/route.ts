import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "expense";

  if (!name) {
    return NextResponse.json({ ok: false, error: "分类名称不能为空" }, { status: 400 });
  }

  const safeType = type === "income" ? "income" : "expense";

  const created = await prisma.category.create({
    data: { name, type: safeType },
  }).catch(() => null);

  if (!created) {
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }

  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, category: { id: created.id, name: created.name, type: created.type } });
}
