import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { pairGroupForMember } from "@/lib/server/account-group-member-pairing";
import { SettingsInstitutionsClient } from "../institutions/client";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { loadInstitutionAccountCounts, withAccountCounts } from "@/lib/server/entity-account-counts";

export const dynamic = "force-dynamic";

async function updateFamilyMemberRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  if (!institutionId || !name) return { ok: false, error: "Missing required fields" };

  try {
    await prisma.$transaction(async (tx) => {
      await assertInstitutionDisplayNamesUnique(tx, {
        householdId,
        name,
        shortName,
        excludeId: institutionId,
      });
      const updated = await tx.institution.updateMany({
        where: { id: institutionId, householdId, type: "family_member" },
        data: { name, shortName: shortName || null, type: "family_member" },
      });
      if (updated.count === 0) throw new Error("Family member not found");
      // Rename the paired owner group in lockstep (FK-based), so the member
      // keeps its identity on the account-owner side.
      await tx.accountGroup.updateMany({
        where: { institutionId, householdId },
        data: { name },
      });
      // A member without any paired group gets one so it stays selectable as
      // an account owner (adopts a same-named unlinked group if present).
      const linkedGroups = await tx.accountGroup.count({ where: { institutionId, householdId } });
      if (linkedGroups === 0) {
        await pairGroupForMember(tx, householdId, { id: institutionId, name });
      }
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "Save failed" };
  }

  revalidateAfterSettingsChange();
  revalidatePath("/insurance");
  return { ok: true };
}

export default async function SettingsFamilyMembersPage() {
  const { hidFilter } = await getHouseholdScope();
  const [familyMembers, accountCounts] = await Promise.all([
    prisma.institution.findMany({
      where: { ...hidFilter, type: "family_member" },
      orderBy: [{ name: "asc" }],
    }),
    loadInstitutionAccountCounts(hidFilter),
  ]);

  return (
    <SettingsInstitutionsClient
      institutions={withAccountCounts(familyMembers, accountCounts).map(i => ({ id: i.id, name: i.name, shortName: i.shortName, type: i.type, accountCount: i.accountCount }))}
      updateAction={updateFamilyMemberRow}
      mode="family"
    />
  );
}
