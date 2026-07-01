import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const VALID_TYPES = ["family_member", "person", "organization", "company", "friend", "other"];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "person";

  if (!name) {
    return NextResponse.json({ ok: false, error: "往来对象名称不能为空" }, { status: 400 });
  }

  const { hidFilter } = await getHouseholdScope();
  const existing = await prisma.counterparty.findFirst({ where: { name, ...hidFilter } });
  if (existing) {
    return NextResponse.json({ ok: false, error: `往来对象“${name}”已存在` }, { status: 409 });
  }

  const safeType = VALID_TYPES.includes(type) ? type : "person";
  const counterparty = await prisma.counterparty.create({
    data: { name, shortName: shortName || null, type: safeType, ...hidFilter },
  });

  return NextResponse.json({
    ok: true,
    counterparty: {
      id: counterparty.id,
      name: counterparty.name,
      shortName: counterparty.shortName,
      type: counterparty.type,
    },
  });
}
