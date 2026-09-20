import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { logger } from "@/lib/logger";

type PairingWriter = typeof prisma | Prisma.TransactionClient;

/**
 * Owner-group names with functional (non-person) semantics. They are stored
 * as real group names in user data and must never be materialized as family
 * members by the pairing self-heal. Kept in sync with the constants in
 * `src/lib/server/advance-account.ts`.
 */
export const NON_PERSON_OWNER_GROUP_NAMES = ["往来款", "借入/借出", "负债", "未指定", "默认"] as const;

function isNonPersonGroupName(name: string | null | undefined): boolean {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return !trimmed || (NON_PERSON_OWNER_GROUP_NAMES as readonly string[]).includes(trimmed);
}

/**
 * Owner group <-> family member pairing (data layer).
 *
 * An account owner is an `AccountGroup`; a family member is an `Institution`
 * with `type: "family_member"`. They are the same person, linked by the
 * `AccountGroup.institutionId` FK. This module is the single owner of:
 * - keeping every person-owner group paired with exactly one member, and
 *   every member selectable as an owner through exactly one group, and
 * - renaming the pair in lockstep from either side.
 *
 * The self-heal (`ensureAccountGroupMemberPairing`) is idempotent and runs on
 * the system-task tick plus lazily from the account settings data endpoint,
 * so upgraded ledgers (where owners only exist as groups, usually "admin")
 * immediately expose every owner as a family member.
 */

/**
 * Ensure the given (created or renamed) owner group is paired with a family
 * member: link an existing same-named member, or create a new one.
 *
 * @throws InstitutionNameUniqueError when creating the member would conflict
 *   with another member's full name or short name.
 * @returns the paired member id.
 */
export async function pairMemberForGroup(
  writer: PairingWriter,
  householdId: string,
  group: { id: string; name: string; institutionId?: string | null },
  shortName = "",
): Promise<string | null> {
  const groupName = group.name.trim();
  if (!groupName) return group.institutionId ?? null;
  if (isNonPersonGroupName(groupName)) return group.institutionId ?? null;

  if (group.institutionId) {
    const linked = await writer.institution.findUnique({
      where: { id: group.institutionId },
      select: { id: true, householdId: true, type: true },
    });
    if (linked && linked.type === "family_member" && linked.householdId === householdId) {
      return linked.id;
    }
    // Stale link (member deleted or type changed): fall through and re-pair.
  }

  const members = await writer.institution.findMany({
    where: { householdId, type: "family_member" },
    select: { id: true, name: true, shortName: true },
    orderBy: [{ name: "asc" }],
  });
  const short = shortName.trim();
  const candidates = Array.from(new Set([groupName, short].filter(Boolean)));
  const match = members.find(
    (member) =>
      candidates.includes(member.name.trim()) ||
      candidates.some((candidate) => member.shortName?.trim() === candidate),
  );
  if (match) {
    await writer.accountGroup.update({
      where: { id: group.id },
      data: { institutionId: match.id },
    });
    return match.id;
  }

  await assertInstitutionDisplayNamesUnique(writer, {
    householdId,
    name: groupName,
    shortName: short,
  });
  const created = await writer.institution.create({
    data: {
      householdId,
      type: "family_member",
      name: groupName,
      shortName: short || null,
    },
    select: { id: true },
  });
  await writer.accountGroup.update({
    where: { id: group.id },
    data: { institutionId: created.id },
  });
  return created.id;
}

/**
 * Ensure the given family member is selectable as an account owner: link an
 * existing same-named unlinked group, or create a new one.
 *
 * @returns the paired group id.
 */
export async function pairGroupForMember(
  writer: PairingWriter,
  householdId: string,
  member: { id: string; name: string },
): Promise<string | null> {
  const memberName = member.name.trim();
  if (!memberName) return null;

  const groups = await writer.accountGroup.findMany({
    where: { householdId },
    select: { id: true, name: true, sortOrder: true, institutionId: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const match = groups.find((group) => !group.institutionId && group.name.trim() === memberName);
  if (match) {
    await writer.accountGroup.update({
      where: { id: match.id },
      data: { institutionId: member.id },
    });
    return match.id;
  }

  const lastSortOrder = groups.reduce((max, group) => Math.max(max, group.sortOrder), 0);
  const created = await writer.accountGroup.create({
    data: {
      name: memberName,
      sortOrder: lastSortOrder + 1,
      householdId,
      institutionId: member.id,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Bidirectional self-heal for one household. Idempotent: a run that finds a
 * fully paired state changes nothing.
 *
 * - Owner group -> family member: every non-functional unlinked group adopts
 *   the same-named member (full or short name) or gets a new member created.
 *   Display-name conflicts are skipped with a log (ambiguous identity needs
 *   a human), never overwritten.
 * - Family member -> owner group: every member without a linked group adopts
 *   the same-named unlinked group or gets a new group, so every member is
 *   selectable as an account owner. A duplicate member whose name already has
 *   a linked group is skipped (legacy/race guard).
 *
 * The caller decides transactionality; pass a transaction client to make the
 * whole household atomic.
 */
export async function ensureAccountGroupMemberPairing(
  writer: PairingWriter,
  householdId: string,
): Promise<{ linkedGroups: number; createdMembers: number; createdGroups: number }> {
  const [groups, members] = await Promise.all([
    writer.accountGroup.findMany({
      where: { householdId },
      select: { id: true, name: true, sortOrder: true, institutionId: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    writer.institution.findMany({
      where: { householdId, type: "family_member" },
      select: { id: true, name: true, shortName: true },
      orderBy: [{ name: "asc" }],
    }),
  ]);

  let linkedGroups = 0;
  let createdMembers = 0;
  let createdGroups = 0;

  // Owner group -> family member.
  for (const group of groups) {
    if (group.institutionId) {
      if (members.some((member) => member.id === group.institutionId)) continue;
      // Stale link: drop it and re-pair below.
      await writer.accountGroup.update({
        where: { id: group.id },
        data: { institutionId: null },
      });
    }
    if (isNonPersonGroupName(group.name)) continue;

    const match = members.find(
      (member) =>
        member.name.trim() === group.name.trim() || member.shortName?.trim() === group.name.trim(),
    );
    if (match) {
      await writer.accountGroup.update({
        where: { id: group.id },
        data: { institutionId: match.id },
      });
      group.institutionId = match.id;
      linkedGroups += 1;
      continue;
    }

    try {
      await assertInstitutionDisplayNamesUnique(writer, {
        householdId,
        name: group.name,
        shortName: "",
        excludeId: null,
      });
    } catch (error) {
      if (isInstitutionNameUniqueError(error)) {
        logger.warn("owner/member pairing skipped: display name conflict", "owner-member-pairing", {
          householdId,
          group: group.name,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
    const created = await writer.institution.create({
      data: {
        householdId,
        type: "family_member",
        name: group.name,
        shortName: null,
      },
      select: { id: true, name: true, shortName: true },
    });
    members.push(created);
    await writer.accountGroup.update({
      where: { id: group.id },
      data: { institutionId: created.id },
    });
    group.institutionId = created.id;
    linkedGroups += 1;
    createdMembers += 1;
  }

  // Family member -> owner group.
  let nextSortOrder = groups.reduce((max, group) => Math.max(max, group.sortOrder), 0);
  for (const member of members) {
    if (!member.name.trim()) continue;
    if (groups.some((group) => group.institutionId === member.id)) continue;

    const match = groups.find(
      (group) => !group.institutionId && group.name.trim() === member.name.trim(),
    );
    if (match) {
      await writer.accountGroup.update({
        where: { id: match.id },
        data: { institutionId: member.id },
      });
      match.institutionId = member.id;
      linkedGroups += 1;
      continue;
    }

    // Legacy duplicate guard: another member with the same name already owns
    // a group; do not create a second owner entry for that name.
    const sibling = members.find(
      (other) =>
        other.id !== member.id &&
        other.name.trim() === member.name.trim() &&
        groups.some((group) => group.institutionId === other.id),
    );
    if (sibling) continue;

    nextSortOrder += 1;
    const created = await writer.accountGroup.create({
      data: {
        name: member.name,
        sortOrder: nextSortOrder,
        householdId,
        institutionId: member.id,
      },
      select: { id: true, name: true, sortOrder: true, institutionId: true },
    });
    groups.push({ id: created.id, name: created.name, sortOrder: created.sortOrder, institutionId: created.institutionId });
    createdGroups += 1;
  }

  return { linkedGroups, createdMembers, createdGroups };
}

/**
 * Convenience wrapper: run the self-heal for one household inside its own
 * transaction, swallowing failures so callers on read paths never break.
 */
export async function selfHealOwnerMemberPairing(householdId: string) {
  try {
    const result = await prisma.$transaction((tx) => ensureAccountGroupMemberPairing(tx, householdId));
    if (result.linkedGroups > 0 || result.createdMembers > 0 || result.createdGroups > 0) {
      logger.info(
        `owner/member pairing self-heal applied for household ${householdId}: linked=${result.linkedGroups} createdMembers=${result.createdMembers} createdGroups=${result.createdGroups}`,
        "owner-member-pairing",
      );
    }
    return result;
  } catch (error) {
    logger.warn("owner/member pairing self-heal skipped", "owner-member-pairing", error);
    return null;
  }
}
