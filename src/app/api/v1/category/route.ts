import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const parentId = typeof body?.parentId === "string" ? body.parentId.trim() : null;

  if (!name) {
    return NextResponse.json({ ok: false, error: "分类名称不能为空" }, { status: 400 });
  }

  const { hidFilter } = await getHouseholdScope();

  // Inherit type from parent, or use explicit type, or default to expense
  let type = "expense";
  if (parentId) {
    const parent = await prisma.category.findUnique({ where: { id: parentId } });
    if (parent) type = parent.type;
  } else if (typeof body?.type === "string") {
    const raw = body.type.trim();
    if (["expense", "income", "investment", "transfer"].includes(raw)) type = raw;
  }

  const created = await prisma.category.create({
    data: { name, type, parentId: parentId || null, ...hidFilter },
  }).catch(() => null);

  if (!created) {
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }

  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, category: { id: created.id, name: created.name, type: created.type, parentId: created.parentId } });
}