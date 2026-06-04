import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "bank";

  if (!name) {
    return NextResponse.json({ ok: false, error: "机构名称不能为空" }, { status: 400 });
  }

  const validTypes = ["bank", "brokerage", "payment", "ewallet", "other"];
  const safeType = validTypes.includes(type) ? type : "bank";

  const created = await prisma.institution.create({
    data: { name, type: safeType },
  }).catch((e) => {
    if (e.code === "P2002") return null;
    return null;
  });

  if (!created) {
    const existing = await prisma.institution.findFirst({ where: { name } });
    if (existing) {
      return NextResponse.json({ ok: true, institution: { id: existing.id, name: existing.name, type: existing.type } });
    }
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }

  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, institution: { id: created.id, name: created.name, type: created.type } });
}
