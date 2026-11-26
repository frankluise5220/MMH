import { prisma } from "@/lib/db/prisma";
import { readableTagWhere } from "@/lib/server/tag-scope";
import type { Prisma } from "@prisma/client";

type EntryTagTx = {
  tag: Pick<typeof prisma.tag, "findMany">;
  entryTag: Pick<typeof prisma.entryTag, "deleteMany" | "createMany">;
};

export function parseTagNamesInput(value: unknown) {
  const parts = Array.isArray(value)
    ? value.map((item) => String(item))
    : String(value ?? "").split(/[\uFF0C,\u3001\uFF1B;]+/);
  return Array.from(new Set(
    parts
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20),
  ));
}

async function resolveOrCreateTagIdsByNames(
  tx: Prisma.TransactionClient,
  householdId: string | null | undefined,
  names: readonly string[],
) {
  const ids: string[] = [];
  for (const name of names) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) continue;
    const existing = await tx.tag.findFirst({
      where: { name: trimmed, ...readableTagWhere(householdId) },
      select: { id: true },
    });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await tx.tag.create({
      data: { name: trimmed, householdId: householdId ?? null },
    });
    ids.push(created.id);
  }
  return Array.from(new Set(ids));
}

export async function attachEntryTagsByNames(input: {
  tx: Prisma.TransactionClient;
  entryId: string;
  householdId?: string | null;
  names: readonly string[];
}) {
  if (!input.entryId) return;
  const tagIds = await resolveOrCreateTagIdsByNames(input.tx, input.householdId ?? null, input.names);
  if (tagIds.length === 0) return;
  const existing = await input.tx.entryTag.findMany({
    where: { entryId: input.entryId, tagId: { in: tagIds } },
    select: { tagId: true },
  });
  const existingTagIds = new Set(existing.map((row) => row.tagId));
  const freshTagIds = tagIds.filter((tagId) => !existingTagIds.has(tagId));
  if (freshTagIds.length === 0) return;
  await input.tx.entryTag.createMany({
    data: freshTagIds.map((tagId) => ({ entryId: input.entryId, tagId })),
  });
}

function normalizeTagIds(tagIds: readonly string[]) {
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
      ...readableTagWhere(householdId),
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

/**
 * 给「交易表 + 资金腿」拼出来的明细行补上标签。
 *
 * 基金 / 理财明细的 id 取的是资金腿（cashEntryId），标签存在 TxRecord 的 EntryTag 上，
 * 交易表本身没有标签列；不补这一步，明细表的「标签」列永远是 “-”，
 * 批量修改里加完标签也看不到结果。没有资金腿的业务行（id 就是交易表 id）
 * 天然挂不了标签，查不到时给空数组，与「无标签」同义。
 */
export async function attachEntryTagsToRows<T extends { id?: unknown }>(rows: T[]) {
  const ids = Array.from(new Set(rows.map((row) => String(row.id ?? "")).filter(Boolean)));
  const tagsByEntryId = new Map<string, Array<{ entryId: string; tagId: string; Tag: { id: string; name: string; color: string | null } }>>();
  if (ids.length > 0) {
    const links = await prisma.entryTag.findMany({
      where: { entryId: { in: ids } },
      select: { entryId: true, tagId: true, Tag: { select: { id: true, name: true, color: true } } },
    });
    for (const link of links) {
      const list = tagsByEntryId.get(link.entryId) ?? [];
      list.push(link);
      tagsByEntryId.set(link.entryId, list);
    }
  }
  for (const row of rows) {
    (row as Record<string, unknown>).entryTags = tagsByEntryId.get(String(row.id ?? "")) ?? [];
  }
}
