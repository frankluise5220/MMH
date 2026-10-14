/**
 * 「对账」锁定的客户端调用封装。
 *
 * 对账 = 给选中的流水加锁：不可删除 / 修改（编辑窗只读），并把本行事后余额
 * 钉进 `reconciledBalance` 当余额锚点（等价「余额校准」）。
 * 解锁 = 点锁标记，清掉这两列。
 */

export type EntryReconcileAction = "lock" | "unlock";

export type EntryReconcileResponse =
  | { ok: true; action: EntryReconcileAction; count: number; accountIds: string[] }
  | { ok: false; error: string; code?: string; reconciledIds?: string[] };

export async function callReconcileEntries(body: {
  entryIds: string[];
  action?: EntryReconcileAction;
  contextAccountId?: string;
}): Promise<EntryReconcileResponse> {
  const res = await fetch("/api/v1/entries/reconcile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
