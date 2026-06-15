import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "./client";

export const dynamic = "force-dynamic";

async function updateInstitutionRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!institutionId || !name) return;

  await prisma.institution
    .updateMany({
      where: { id: institutionId, householdId },
      data: { name, type: type || null },
    })
    .catch(() => null);

  revalidatePath("/settings/institutions");
  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

export default async function SettingsInstitutionsPage() {
  const { hidFilter } = await getHouseholdScope();
  const institutions = await prisma.institution.findMany({ where: hidFilter, orderBy: [{ type: "asc" }, { name: "asc" }] });

  return (
    <SettingsInstitutionsClient
      institutions={institutions.map(i => ({ id: i.id, name: i.name, type: i.type }))}
      updateAction={updateInstitutionRow}
    />
  );
}
