import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsCounterpartiesClient } from "./client";

export const dynamic = "force-dynamic";

async function updateCounterpartyRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const counterpartyId = String(formData.get("counterpartyId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!counterpartyId || !name) return;

  await prisma.counterparty
    .updateMany({
      where: { id: counterpartyId, householdId },
      data: { name, shortName: shortName || null, type: type || null },
    })
    .catch(() => null);

  revalidatePath("/settings/counterparties");
  revalidatePath("/settings/accounts");
  revalidatePath("/accounts");
}

export default async function SettingsCounterpartiesPage() {
  const { hidFilter } = await getHouseholdScope();
  const counterparties = await prisma.counterparty.findMany({
    where: hidFilter,
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return (
    <SettingsCounterpartiesClient
      counterparties={counterparties.map((item) => ({
        id: item.id,
        name: item.name,
        shortName: item.shortName,
        type: item.type,
      }))}
      updateAction={updateCounterpartyRow}
    />
  );
}
