import { prisma } from "@/lib/db/prisma";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";

/**
 * Gets or creates the system-level placeholder account (named "空白").
 * Used after deleting a real account: records that referenced it are repointed to the placeholder account.
 * The placeholder account cannot be edited/deleted and is shown greyed out in lists.
 */

let cachedPlaceholderId: string | null = null;

export async function getOrCreatePlaceholderAccountId(householdId: string): Promise<string> {
  // If cached and the account still exists, return it directly
  if (cachedPlaceholderId) {
    const exists = await prisma.account.findUnique({ where: { id: cachedPlaceholderId } });
    if (exists) return cachedPlaceholderId;
    cachedPlaceholderId = null;
  }

  // Look for an existing placeholder account (scoped to the current household/book)
  const existing = await prisma.account.findFirst({
    where: { isPlaceholder: true, householdId },
  });
  if (existing) {
    cachedPlaceholderId = existing.id;
    return existing.id;
  }

  // Find the default owner of the current household/book to ensure the groupId exists
  const groupId = await getOrCreateDefaultAccountGroupId(prisma, householdId);

  // Create the placeholder account
  const placeholder = await prisma.account.create({
    data: {
      name: "空白",
      kind: "other",
      currency: "CNY",
      isActive: true,
      isPlaceholder: true,
      householdId,
      groupId,
    },
  });

  cachedPlaceholderId = placeholder.id;
  return placeholder.id;
}
