import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "../institutions/client";

export const dynamic = "force-dynamic";

async function updateCounterpartyRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!institutionId || !name) return;

  const safeType = ["person", "organization"].includes(type) ? type : "person";
  await prisma.institution
    .updateMany({
      where: { id: institutionId, householdId },
      data: { name, shortName: shortName || null, type: safeType },
    })
    .catch(() => null);

  revalidatePath("/settings/counterparties");
  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

export default async function SettingsCounterpartiesPage() {
  const { hidFilter } = await getHouseholdScope();
  const counterparties = await prisma.institution.findMany({
    where: { ...hidFilter, type: { in: ["person", "organization"] } },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return (
    <SettingsInstitutionsClient
      institutions={counterparties.map(i => ({ id: i.id, name: i.name, shortName: i.shortName, type: i.type }))}
      updateAction={updateCounterpartyRow}
      mode="counterparty"
    />
  );
}
