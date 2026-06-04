import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

export async function GET() {
  try {
    const tags = await prisma.tag.findMany({
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ ok: true, tags });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "查询失败" }, { status: 500 });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "名称必填（1-40字）" }, { status: 400 });
  }

  const { name, color } = parsed.data;
  const tag = await prisma.tag.create({ data: { name, color: color || null } });
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, tag });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "标签不存在" }, { status: 404 });

  await prisma.tag.delete({ where: { id } });
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true });
}
