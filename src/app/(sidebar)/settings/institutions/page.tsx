import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "./client";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const dynamic = "force-dynamic";

async function updateInstitutionRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!institutionId || !name) return;

  await prisma.institution
    .updateMany({
      where: { id: institutionId, householdId },
      data: { name, shortName: shortName || null, type: type || null },
    })
    .catch(() => null);

  revalidateAfterSettingsChange();
}

export default async function SettingsInstitutionsPage() {
  const { hidFilter } = await getHouseholdScope();
  const institutions = await prisma.institution.findMany({
    where: { ...hidFilter, type: { in: ["bank", "insurance", "brokerage", "payment", "ewallet"] } },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return (
    <SettingsInstitutionsClient
      institutions={institutions.map(i => ({ id: i.id, name: i.name, shortName: i.shortName, type: i.type }))}
      updateAction={updateInstitutionRow}
      mode="institution"
    />
  );
}
