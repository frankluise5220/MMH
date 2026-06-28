import { prisma } from "@/lib/db/prisma";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function resolveInsuranceOwnerGroupId(
  db: Db,
  householdId: string,
  ownerGroupId?: string | null,
) {
  const requested = ownerGroupId?.trim();
  if (requested) {
    const group = await db.accountGroup.findFirst({
      where: { id: requested, householdId },
      select: { id: true },
    });
    if (!group) throw new Error("投保人不存在");
    return group.id;
  }
  return getOrCreateDefaultAccountGroupId(db, householdId);
}

export async function findInsuranceAccountByOwner(
  db: Db,
  ownerGroupId: string,
  householdId: string,
) {
  return db.account.findFirst({
    where: {
      kind: "insurance",
      groupId: ownerGroupId,
      householdId,
      isActive: true,
      name: "保险账户",
    },
    include: { AccountGroup: { select: { id: true, name: true } } },
  });
}

export async function getOrCreateInsuranceAccount(
  db: Db,
  ownerGroupId: string,
  householdId: string,
) {
  const existing = await findInsuranceAccountByOwner(db, ownerGroupId, householdId);
  if (existing) return existing;

  const group = await db.accountGroup.findFirst({
    where: { id: ownerGroupId, householdId },
    select: { id: true, name: true },
  });
  if (!group) throw new Error("投保人不存在");

  return db.account.create({
    data: {
      name: "保险账户",
      kind: "insurance",
      groupId: group.id,
      householdId,
      isActive: true,
      currency: "CNY",
      institutionId: null,
    },
    include: { AccountGroup: { select: { id: true, name: true } } },
  });
}

