/**
 * 「对账」锁定（`TxRecord.reconciledAt`）的公共守卫。
 *
 * 已对账的记录不可删除、不可修改（编辑窗只读），只有解除对账（点锁标记）后才能再改。
 * 各写入入口（删除 / 批量替换 / 单条编辑 / 业务编辑）都必须先过这里，避免
 * 「前端拦住了、服务端没拦」这类只在前端成立的口径。
 */
import { prisma } from "@/lib/db/prisma";

/** 已对账锁定的流水 id。 */

/** 单条记录是否已对账锁定。 */
export async function isEntryReconciled(entryId: string): Promise<boolean> {
  const row = await prisma.txRecord.findUnique({
    where: { id: entryId },
    select: { reconciledAt: true },
  });
  return row?.reconciledAt != null;
}
