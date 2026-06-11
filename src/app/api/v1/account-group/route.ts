import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json({ ok: false, error: "分组名称不能为空" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();

  const lastGroup = await prisma.accountGroup.findFirst({
    where: { householdId },
    orderBy: { sortOrder: "desc" },
  });
  const nextSortOrder = (lastGroup?.sortOrder ?? 0) + 1;

  const created = await prisma.accountGroup.create({
    data: { name, sortOrder: nextSortOrder, householdId },
  }).catch(() => null);

  if (!created) {
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }

  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, group: { id: created.id, name: created.name } });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!id || !name) {
    return NextResponse.json({ ok: false, error: "缺少必填字段" }, { status: 400 });
  }

  const { householdId, user } = await getHouseholdScope();

  const group = await prisma.accountGroup.findUnique({ where: { id } });
  if (!group) return NextResponse.json({ ok: false, error: "分组不存在" }, { status: 404 });
  if (!isAdmin(user) && group.householdId !== householdId) return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403 });

  await prisma.accountGroup.update({ where: { id }, data: { name } });
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true });
}