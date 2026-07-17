import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { ensureCounterpartyForInstitution } from "@/lib/server/counterparty-sync";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

/**
 * POST /api/v1/institution
 * Body: { name: string, shortName?: string, type?: string }
 * Success: { ok: true, institution: { id, name, shortName, type } }
 * Error: { ok: false, error }, including 409 when any institution full name or short name
 * in the current household already uses the submitted full name or short name.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "bank";

  if (!name) {
    return NextResponse.json({ ok: false, error: "机构名称不能为空" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();

  const validTypes = ["family_member", "person", "organization", "bank", "insurance", "brokerage", "payment", "ewallet", "debt", "other"];
  const safeType = validTypes.includes(type) ? type : "organization";

  try {
    const created = await prisma.$transaction(async (tx) => {
      await assertInstitutionDisplayNamesUnique(tx, { householdId, name, shortName });
      const institution = await tx.institution.create({
        data: { name, shortName: shortName || null, type: safeType, householdId },
      });
      await ensureCounterpartyForInstitution(tx, institution);
      return institution;
    });

    revalidateAfterSettingsChange();

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      institution: { id: created.id, name: created.name, shortName: created.shortName, type: created.type },
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }
}
