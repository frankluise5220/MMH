import { prisma } from "@/lib/db/prisma";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";

/**
 * 获取或创建系统级占位账户（「空白」）
 * 用于删除真实账户后，将引用该账户的记录改为引用占位账户
 * 占位账户不可编辑/删除，在列表中显示为灰色
 */

let cachedPlaceholderId: string | null = null;

export async function getOrCreatePlaceholderAccountId(householdId: string): Promise<string> {
  // 如果有缓存且账户仍然存在，直接返回
  if (cachedPlaceholderId) {
    const exists = await prisma.account.findUnique({ where: { id: cachedPlaceholderId } });
    if (exists) return cachedPlaceholderId;
    cachedPlaceholderId = null;
  }

  // 查找已存在的占位账户（限当前账簿）
  const existing = await prisma.account.findFirst({
    where: { isPlaceholder: true, householdId },
  });
  if (existing) {
    cachedPlaceholderId = existing.id;
    return existing.id;
  }

  // 找到当前账簿的默认所有人，确保 groupId 存在
  const groupId = await getOrCreateDefaultAccountGroupId(prisma, householdId);

  // 创建占位账户
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
