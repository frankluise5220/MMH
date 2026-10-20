"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callEntryReconcileState, type EntryReconcileState } from "@/lib/api/entry-reconcile";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";

const EMPTY_STATES: Record<string, EntryReconcileState> = {};

/**
 * 行内「对账锁」状态：给定当前列表里的 entryId 集合，返回 `isReconciled(id)`。
 *
 * 用于投资/资产类视图（基金、理财、债券、存款、房产、保险、负债）：这些视图的业务明细行
 * 就是它背后的现金流水（`cashEntryId`），所以现金明细页里锁定的记录在这里同样要显示锁，
 * 并且可以就地解锁。数据来自 `POST /api/v1/entries/reconcile-state`（只返回已锁定的 id）。
 *
 * 解锁/加锁会广播 `entry-reconcile`，本 hook 收到后按需重新拉取——所以「在基金侧解锁」
 * 之后，行内锁标记立刻消失，不必整页刷新。
 */
export function useEntryReconcileState(entryIds: Array<string | null | undefined>) {
  const idsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const id of entryIds) {
      const value = String(id ?? "").trim();
      if (value) ids.add(value);
    }
    return Array.from(ids).sort().join("\n");
  }, [entryIds]);

  const ids = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);
  const [states, setStates] = useState<Record<string, EntryReconcileState>>(EMPTY_STATES);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (ids.length === 0) {
      setStates(EMPTY_STATES);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const seq = ++requestSeqRef.current;
      const result = await callEntryReconcileState(ids).catch(() => null);
      if (cancelled || seq !== requestSeqRef.current) return;
      setStates(result && result.ok ? result.data.states : EMPTY_STATES);
    };
    void load();

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string; entryIds?: string[] }>).detail;
      if (detail?.reason !== "entry-reconcile") return;
      // 只关心本列表内的记录；事件里没带 id 时保守地全量重拉。
      const touched = Array.isArray(detail.entryIds) ? detail.entryIds : [];
      if (touched.length > 0 && !touched.some((id) => ids.includes(id))) return;
      void load();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    };
  }, [ids]);

  const isReconciled = useCallback(
    (entryId: string | null | undefined) => Boolean(states[String(entryId ?? "").trim()]),
    [states],
  );

  return { isReconciled };
}
