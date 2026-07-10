import { prisma } from "@/lib/db/prisma";

type EntryTagTx = {
  tag: Pick<typeof prisma.tag, "findMany">;
  entryTag: Pick<typeof prisma.entryTag, "deleteMany" | "createMany">;
};

export function normalizeTagIds(tagIds: readonly string[]) {
  return Array.from(new Set(
    tagIds
      .map((id) => String(id ?? "").trim())
      .filter(Boolean),
  ));
}

export async function resolveWritableTagIds(
  tx: Pick<EntryTagTx, "tag">,
  householdId: string | null | undefined,
  tagIds: readonly string[],
) {
  const ids = normalizeTagIds(tagIds);
  if (ids.length === 0) return [];
  const tags = await tx.tag.findMany({
    where: {
      id: { in: ids },
      OR: householdId
        ? [{ householdId }, { householdId: null }]
        : [{ householdId: null }],
    },
    select: { id: true },
  });
  const validIds = new Set(tags.map((tag) => tag.id));
  return ids.filter((id) => validIds.has(id));
}

export async function attachEntryTags(input: {
  tx: EntryTagTx;
  entryId: string;
  householdId?: string | null;
  tagIds: readonly string[];
}) {
  const tagIds = await resolveWritableTagIds(input.tx, input.householdId, input.tagIds);
  if (tagIds.length === 0) return;
  await input.tx.entryTag.createMany({
    data: tagIds.map((tagId) => ({ entryId: input.entryId, tagId })),
  });
}

export async function replaceEntryTags(input: {
  tx: EntryTagTx;
  entryId: string;
  householdId?: string | null;
  tagIds: readonly string[];
}) {
  await input.tx.entryTag.deleteMany({ where: { entryId: input.entryId } });
  await attachEntryTags(input);
}
