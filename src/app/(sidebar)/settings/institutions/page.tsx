import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
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
  if (!institutionId || !name) return { ok: false, error: "缺少必填字段" };

  try {
    await prisma.$transaction(async (tx) => {
      await assertInstitutionDisplayNamesUnique(tx, {
        householdId,
        name,
        shortName,
        excludeId: institutionId,
      });
      const updated = await tx.institution.updateMany({
        where: { id: institutionId, householdId },
        data: { name, shortName: shortName || null, type: type || null },
      });
      if (updated.count === 0) throw new Error("机构不存在");
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "保存失败" };
  }

  revalidateAfterSettingsChange();
  return { ok: true };
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
