import type { Prisma } from "@prisma/client";

export function readableTagWhere(householdId: string | null | undefined): Prisma.TagWhereInput {
  return householdId
    ? { OR: [{ householdId }, { householdId: null }] }
    : { householdId: null };
}
