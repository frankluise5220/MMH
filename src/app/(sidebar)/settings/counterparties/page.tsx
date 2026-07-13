import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "../institutions/client";
import { ensureInstitutionForCounterparty } from "@/lib/server/counterparty-sync";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const dynamic = "force-dynamic";

async function updateCounterpartyRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const counterpartyId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!counterpartyId || !name) return;

  const safeType = ["person", "organization"].includes(type) ? type : "person";
  const existing = await prisma.counterparty.findFirst({ where: { id: counterpartyId, householdId } });
  if (!existing) return;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.counterparty.update({
      where: { id: counterpartyId },
      data: { name, shortName: shortName || null, type: safeType },
    });
    await ensureInstitutionForCounterparty(tx, updated);
  }).catch(() => null);

  revalidateAfterSettingsChange();
  revalidatePath("/settings/counterparties");
}

export default async function SettingsCounterpartiesPage() {
  const { hidFilter } = await getHouseholdScope();
  const counterparties = await prisma.counterparty.findMany({
    where: hidFilter,
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
