"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * 「已对账」记录的编辑窗只读开关（全局单例）。
 *
 * 同一时刻只可能开着一个记账弹窗，所以用一个模块级布尔量就够：
 *  1. 打开弹窗的动作（`dispatchEntryEdit`）在派发事件前声明这次是不是只读；
 *  2. 弹窗自己（`EntryModalShell` / `TransactionFormModal` / `InvestmentFormModal`）
 *     订阅它来决定「显示锁横幅 + 禁用表单」；
 *  3. 弹窗关闭时复位，避免下次「新增」被上一次的只读状态污染。
 *
 * 注意：这只是**界面**层的表达。真正的「不可修改」由服务端守卫保证
 * （删除 / 批量替换 / 单条编辑 / 撤销都会拒绝已对账记录）。
 */
let reconciledReadOnly = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setEntryModalReconciledReadOnly(value: boolean) {
  if (reconciledReadOnly === value) return;
  reconciledReadOnly = value;
  emit();
}

function getEntryModalReconciledReadOnly() {
  return reconciledReadOnly;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 记账弹窗读它：true = 该记录已对账，只能查看不能改。 */
export function useEntryModalReconciledReadOnly() {
  return useSyncExternalStore(subscribe, getEntryModalReconciledReadOnly, () => false);
}

/** 弹窗关闭（open: true → false）时复位只读开关；只在真正关闭的那一次触发。 */
export function useResetEntryModalReconciledReadOnlyOnClose(open: boolean) {
  const previousOpen = useRef(open);
  useEffect(() => {
    if (previousOpen.current && !open) setEntryModalReconciledReadOnly(false);
    previousOpen.current = open;
  }, [open]);
}
