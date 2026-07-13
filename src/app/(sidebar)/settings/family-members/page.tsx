import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "../institutions/client";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const dynamic = "force-dynamic";

async function updateFamilyMemberRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  if (!institutionId || !name) return;

  await prisma.institution
    .updateMany({
      where: { id: institutionId, householdId, type: "family_member" },
      data: { name, shortName: shortName || null, type: "family_member" },
    })
    .catch(() => null);

  revalidateAfterSettingsChange();
  revalidatePath("/insurance");
}

export default async function SettingsFamilyMembersPage() {
  const { hidFilter } = await getHouseholdScope();
  const familyMembers = await prisma.institution.findMany({
    where: { ...hidFilter, type: "family_member" },
    orderBy: [{ name: "asc" }],
  });

  return (
    <SettingsInstitutionsClient
      institutions={familyMembers.map(i => ({ id: i.id, name: i.name, shortName: i.shortName, type: i.type }))}
      updateAction={updateFamilyMemberRow}
      mode="family"
    />
  );
}
