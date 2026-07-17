import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "../institutions/client";
import { ensureInstitutionForCounterparty } from "@/lib/server/counterparty-sync";
import { isInstitutionNameUniqueError } from "@/lib/server/institution-name-unique";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const dynamic = "force-dynamic";

async function updateCounterpartyRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const counterpartyId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!counterpartyId || !name) return { ok: false, error: "缺少必填字段" };

  const safeType = ["person", "organization"].includes(type) ? type : "person";
  const existing = await prisma.counterparty.findFirst({ where: { id: counterpartyId, householdId } });
  if (!existing) return { ok: false, error: "往来对象不存在" };

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.counterparty.update({
        where: { id: counterpartyId },
        data: { name, shortName: shortName || null, type: safeType },
      });
      await ensureInstitutionForCounterparty(tx, updated);
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "保存失败" };
  }

  revalidateAfterSettingsChange();
  revalidatePath("/settings/counterparties");
  return { ok: true };
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
