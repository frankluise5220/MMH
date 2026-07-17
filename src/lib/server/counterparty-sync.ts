import type { Prisma } from "@prisma/client";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";

type CounterpartyStore = Pick<Prisma.TransactionClient, "counterparty" | "institution">;

type InstitutionLike = {
  id: string;
  name: string;
  shortName?: string | null;
  type?: string | null;
  householdId?: string | null;
};

type CounterpartyLike = {
  id: string;
  name: string;
  shortName?: string | null;
  type?: string | null;
  householdId: string;
  sourceInstitutionId?: string | null;
};

const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

function normalizeCounterpartyType(type?: string | null) {
  return type === "organization" ? "organization" : "person";
}

function counterpartyNameWhere(name: string, shortName?: string | null) {
  const short = shortName?.trim();
  return [
    { name },
    { shortName: name },
    ...(short ? [{ name: short }, { shortName: short }] : []),
  ];
}

export async function ensureCounterpartyForInstitution(
  store: CounterpartyStore,
  institution: InstitutionLike,
) {
  const householdId = institution.householdId;
  const name = institution.name.trim();
  if (!householdId || !name || !COUNTERPARTY_TYPES.has(institution.type ?? "")) return null;

  const type = normalizeCounterpartyType(institution.type);
  const shortName = institution.shortName?.trim() || null;
  const existing = await store.counterparty.findFirst({
    where: {
      householdId,
      OR: [
        { sourceInstitutionId: institution.id },
        ...counterpartyNameWhere(name, shortName),
      ],
    },
  });

  if (existing) {
    const data: Prisma.CounterpartyUpdateInput = {};
    if (!existing.sourceInstitutionId) data.SourceInstitution = { connect: { id: institution.id } };
    if (existing.sourceInstitutionId === institution.id || !existing.sourceInstitutionId) {
      data.name = name;
      data.shortName = shortName;
      data.type = type;
    }
    return Object.keys(data).length > 0
      ? store.counterparty.update({ where: { id: existing.id }, data })
      : existing;
  }

  return store.counterparty.create({
    data: {
      name,
      shortName,
      type,
      householdId,
      sourceInstitutionId: institution.id,
    },
  });
}

export async function ensureInstitutionForCounterparty(
  store: CounterpartyStore,
  counterparty: CounterpartyLike,
) {
  const householdId = counterparty.householdId;
  const name = counterparty.name.trim();
  if (!householdId || !name || !COUNTERPARTY_TYPES.has(counterparty.type ?? "")) return null;

  const type = normalizeCounterpartyType(counterparty.type);
  const shortName = counterparty.shortName?.trim() || null;
  if (counterparty.sourceInstitutionId) {
    const source = await store.institution.findFirst({
      where: { id: counterparty.sourceInstitutionId, householdId },
    });
    if (source) {
      await assertInstitutionDisplayNamesUnique(store, {
        householdId,
        name,
        shortName,
        excludeId: source.id,
      });
      return store.institution.update({
        where: { id: source.id },
        data: { name, shortName, type },
      });
    }
  }

  const existing = await store.institution.findFirst({
    where: {
      householdId,
      type: { in: ["person", "organization"] },
      OR: counterpartyNameWhere(name, shortName),
    },
  });

  await assertInstitutionDisplayNamesUnique(store, {
    householdId,
    name,
    shortName,
    excludeId: existing?.id ?? null,
  });

  const institution = existing
    ? await store.institution.update({
        where: { id: existing.id },
        data: { name, shortName, type },
      })
    : await store.institution.create({
        data: { householdId, name, shortName, type },
      });

  if (counterparty.sourceInstitutionId !== institution.id) {
    await store.counterparty.update({
      where: { id: counterparty.id },
      data: { sourceInstitutionId: institution.id },
    });
  }

  return institution;
}
