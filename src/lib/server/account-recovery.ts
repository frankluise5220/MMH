import { prisma } from "@/lib/db/prisma";
import {
  usersMissingAccountRecovery,
  type AccountRecoveryIdentity,
} from "@/lib/account-recovery";

export type MissingRecoveryUser = { id: string; name: string };

/**
 * 当前账簿里**没有任何找回通道**的账号（通知栏用）。
 *
 * 判定口径与用户管理页的警告条完全一致（`hasAccountRecovery`），这里只负责取数。
 * 老库缺 email / registrationPrincipalId 列时 Prisma 会直接抛错 —— 通知栏是装饰性
 * 组件，宁可这一条提示不出现，也不能让整个通知接口挂掉，所以失败一律降级成空列表。
 */
export async function loadMissingRecoveryUsers(householdId: string): Promise<MissingRecoveryUser[]> {
  let users: Array<AccountRecoveryIdentity & { id: string; name: string }>;
  try {
    users = await prisma.user.findMany({
      where: { householdId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        fnosUid: true,
        registrationPrincipalId: true,
      },
    });
  } catch {
    return [];
  }
  return usersMissingAccountRecovery(users).map(({ id, name }) => ({ id, name }));
}
