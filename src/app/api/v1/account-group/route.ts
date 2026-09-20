import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { pairMemberForGroup } from "@/lib/server/account-group-member-pairing";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

/**
 * Owner groups (account owners) and their family-member pairing.
 *
 * POST /api/v1/account-group
 * Body: { name: string, shortName?: string }
 * Creates an owner group and pairs it with a family member: an existing
 * member whose full name or short name matches is linked via
 * `AccountGroup.institutionId`, otherwise a new member is created.
 * Success: { ok: true, group: { id, name }, member: { id, name } | null }
 * Errors: 400 GROUP_NAME_REQUIRED | 409 INSTITUTION_NAME_CONFLICT
 *         (pairing a member would duplicate another member's name/short name)
 *         | 500 CREATE_FAILED
 *
 * PUT /api/v1/account-group
 * Body: { id: string, name: string, shortName?: string }
 * Renames an owner group. The paired family member (via institutionId) is
 * renamed in lockstep; an unlinked legacy group adopts the same-named member
 * or gets a new one.
 * Success: { ok: true }
 * Errors: 400 MISSING_REQUIRED_FIELDS | 404 GROUP_NOT_FOUND | 403 FORBIDDEN
 *         | 409 INSTITUTION_NAME_CONFLICT | 500 UPDATE_FAILED
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";

  if (!name) {
    return NextResponse.json({ ok: false, code: "GROUP_NAME_REQUIRED", error: "Owner name is required." }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const lastGroup = await tx.accountGroup.findFirst({
        where: { householdId },
        orderBy: { sortOrder: "desc" },
      });
      const group = await tx.accountGroup.create({
        data: { name, sortOrder: (lastGroup?.sortOrder ?? 0) + 1, householdId },
        select: { id: true, name: true, institutionId: true },
      });
      const memberId = await pairMemberForGroup(tx, householdId, group, shortName);
      const member = memberId
        ? await tx.institution.findUnique({
            where: { id: memberId },
            select: { id: true, name: true },
          })
        : null;
      return { group, member };
    });
    // Client-side handles page refresh
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, group: result.group, member: result.member });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NAME_CONFLICT", error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: "Failed to create owner." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";

  if (!id || !name) {
    return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "Missing required fields." }, { status: 400 });
  }

  const { householdId, user } = await getHouseholdScope();

  const group = await prisma.accountGroup.findUnique({ where: { id } });
  if (!group) return NextResponse.json({ ok: false, code: "GROUP_NOT_FOUND", error: "Owner not found." }, { status: 404 });
  if (!isAdmin(user) && group.householdId !== householdId) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Forbidden." }, { status: 403 });

  try {
    await prisma.$transaction(async (tx) => {
      await tx.accountGroup.update({ where: { id }, data: { name } });
      if (group.institutionId) {
        const member = await tx.institution.findUnique({
          where: { id: group.institutionId },
          select: { id: true, name: true, shortName: true, type: true },
        });
        if (member && member.type === "family_member") {
          // Rename the paired member in lockstep with the owner group.
          if (member.name.trim() !== name || (member.shortName?.trim() ?? "") !== shortName) {
            await assertInstitutionDisplayNamesUnique(tx, {
              householdId,
              name,
              shortName,
              excludeId: member.id,
            });
            await tx.institution.update({
              where: { id: member.id },
              data: { name, shortName: shortName || null },
            });
          }
        } else {
          // Stale link: re-pair by name (adopt same-named member or create).
          await pairMemberForGroup(tx, householdId, { id, name, institutionId: group.institutionId }, shortName);
        }
      } else {
        // Legacy unlinked group: adopt same-named member or create a new one.
        await pairMemberForGroup(tx, householdId, { id, name }, shortName);
      }
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NAME_CONFLICT", error: error.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: "Failed to rename owner." }, { status: 500 });
  }
  // Client-side handles page refresh
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true });
}
