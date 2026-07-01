import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "bank";

  if (!name) {
    return NextResponse.json({ ok: false, error: "机构名称不能为空" }, { status: 400 });
  }

  const { hidFilter } = await getHouseholdScope();

  const existing = await prisma.institution.findFirst({ where: { name, ...hidFilter } });
  if (existing) {
    return NextResponse.json({ ok: false, error: `机构“${name}”已存在` }, { status: 409 });
  }

  const validTypes = ["bank", "insurance", "brokerage", "payment", "ewallet", "other"];
  const safeType = validTypes.includes(type) ? type : "bank";

  const created = await prisma.institution.create({
    data: { name, shortName: shortName || null, type: safeType, ...hidFilter },
  }).catch(() => null);

  if (!created) {
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }

  // Client-side handles page refresh
  return NextResponse.json({
    ok: true,
    institution: { id: created.id, name: created.name, shortName: created.shortName, type: created.type },
  });
}
