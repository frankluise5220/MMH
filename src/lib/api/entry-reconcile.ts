/**
 * 「对账」锁定的客户端调用封装。
 *
 * 对账 = 给选中的流水加锁：不可删除 / 修改（编辑窗只读），并把本行事后余额
 * 钉进 `reconciledBalance` 当余额锚点（等价「余额校准」）。
 * 解锁 = 点锁标记，清掉这两列。
 */

type EntryReconcileAction = "lock" | "unlock";

type EntryReconcileResponse =
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

export type EntryReconcileState = { reconciledAt: string; reconciledBalance: number | null };

type EntryReconcileStateResponse =
  | { ok: true; data: { states: Record<string, EntryReconcileState> } }
  | { ok: false; error: string; code?: string };

/**
 * 批量读取一批流水的对账锁定状态（只返回已锁定的 id）。
 *
 * 投资/资产类视图的业务明细行就是背后的现金流水，行内锁标记用它取状态；
 * 解锁仍走 `callReconcileEntries({ action: "unlock" })`。
 */
export async function callEntryReconcileState(entryIds: string[]): Promise<EntryReconcileStateResponse> {
  const res = await fetch("/api/v1/entries/reconcile-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryIds }),
  });
  return res.json();
}
