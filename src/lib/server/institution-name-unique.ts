import type { Prisma } from "@prisma/client";

type InstitutionNameStore = {
  institution: {
    findMany(args: {
      where: Prisma.InstitutionWhereInput;
      select: { id: true; name: true; shortName: true };
    }): Promise<Array<{ id: string; name: string; shortName: string | null }>>;
  };
};

export class InstitutionNameUniqueError extends Error {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = "InstitutionNameUniqueError";
  }
}

export function isInstitutionNameUniqueError(error: unknown): error is InstitutionNameUniqueError {
  return error instanceof InstitutionNameUniqueError;
}

export function normalizeInstitutionDisplayName(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function institutionNameCandidates(name: unknown, shortName?: unknown) {
  const fullName = normalizeInstitutionDisplayName(name);
  const short = normalizeInstitutionDisplayName(shortName);
  return [fullName, short].filter(Boolean);
}

export async function findInstitutionDisplayNameConflict(
  store: InstitutionNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const candidates = institutionNameCandidates(input.name, input.shortName);
  if (candidates.length === 0) return null;

  const rows = await store.institution.findMany({
    where: {
      householdId: input.householdId,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      OR: [
        { name: { in: candidates } },
        { shortName: { in: candidates } },
      ],
    },
    select: { id: true, name: true, shortName: true },
  });

  return candidates
    .map((candidate) => {
      const row = rows.find((item) =>
        normalizeInstitutionDisplayName(item.name) === candidate ||
        normalizeInstitutionDisplayName(item.shortName) === candidate,
      );
      return row ? { value: candidate, institution: row } : null;
    })
    .find(Boolean) ?? null;
}

export async function assertInstitutionDisplayNamesUnique(
  store: InstitutionNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const fullName = normalizeInstitutionDisplayName(input.name);
  const shortName = normalizeInstitutionDisplayName(input.shortName);
  if (!fullName) {
    throw new InstitutionNameUniqueError("机构名称不能为空");
  }
  if (shortName && fullName === shortName) {
    throw new InstitutionNameUniqueError(`机构全称和简称不能相同：“${fullName}”`);
  }

  const conflict = await findInstitutionDisplayNameConflict(store, input);
  if (conflict) {
    const owner = conflict.institution.shortName
      ? `${conflict.institution.name}（${conflict.institution.shortName}）`
      : conflict.institution.name;
    throw new InstitutionNameUniqueError(`机构名称/简称“${conflict.value}”已被“${owner}”使用`);
  }
}
