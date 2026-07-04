import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "person";

  if (!name) {
    return NextResponse.json({ ok: false, error: "往来对象名称不能为空" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();
  const safeType = type === "organization" ? "organization" : "person";

  const existing = await prisma.counterparty.findFirst({
    where: {
      householdId,
      OR: [
        { name },
        ...(shortName ? [{ name: shortName }, { shortName }] : []),
      ],
    },
  });
  if (existing) {
    return NextResponse.json({ ok: false, error: `往来对象“${name}”已存在` }, { status: 409 });
  }

  const created = await prisma.counterparty.create({
    data: {
      name,
      shortName: shortName || null,
      type: safeType,
      householdId,
    },
  });

  return NextResponse.json({
    ok: true,
    counterparty: {
      id: created.id,
      name: created.name,
      shortName: created.shortName,
      type: created.type,
    },
  });
}
