"use client";

import { useEffect, useMemo, useState } from "react";
import type { SmartSelectQuickPickGroup } from "@/components/SmartSelect";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";

export type CategoryUsageStats = {
  /** 最近入账用过的分类 id（按入账日期倒序）。 */
  recent: string[];
  /** 入账次数最多的分类 id（按次数倒序）。 */
  frequent: string[];
};

const EMPTY_USAGE: CategoryUsageStats = { recent: [], frequent: [] };
const HOUSEHOLD_COOKIE = "householdId";
/** 本地「最近选中过」的分类（保存成功后写入），与服务端入账日期口径叠加使用。 */
const RECENT_CATEGORIES_KEY = "mmh_recent_categories";
const RECENT_CATEGORIES_EVENT = "mmh:recent-category-changed";
const RECENT_CATEGORY_LIMIT = 20;
/**
 * 本地记录只在两周内参与「最近使用」排序：它只是补上「编辑旧记录时入账日期不前移」
 * 这个缺口，不是长期习惯数据。超过窗口就让服务端口径重新接管，避免很久以前的一次
 * 选择一直占着第一排的 5 个位置。
 */
const RECENT_CATEGORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const cachedUsage = new Map<string, CategoryUsageStats>();
const inflight = new Map<string, Promise<CategoryUsageStats>>();

function readHouseholdCacheKey() {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${HOUSEHOLD_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function mergeIds(primary: string[], secondary: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const id of [...primary, ...secondary]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

type LocalRecentCategory = { id: string; at: number };

function readLocalRecentCategories(): LocalRecentCategory[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_CATEGORIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const list: LocalRecentCategory[] = [];
    for (const item of parsed) {
      const id = String((item as { id?: unknown })?.id ?? "").trim();
      const at = Number((item as { at?: unknown })?.at);
      if (!id || !Number.isFinite(at) || now - at > RECENT_CATEGORY_TTL_MS) continue;
      if (list.some((entry) => entry.id === id)) continue;
      list.push({ id, at });
    }
    return list;
  } catch {
    return [];
  }
}

function readLocalRecentCategoryIds(): string[] {
  return readLocalRecentCategories().map((entry) => entry.id);
}

/**
 * 记一次「用户保存单据时用到的分类」。
 *
 * 口径与服务端 recent 不同、两者互补：服务端 recent 按 `TxRecord.date`（入账日期）
 * 聚合，这样批量导入历史账单不会被导入时间带偏；代价是**编辑一条旧记录的分类时
 * 入账日期没有前移**，那个分类永远进不了「最近使用」。所以保存成功后在这里再记一份
 * 本地最近选中（与 `recentAccounts` 同一思路），下次打开下拉直接置顶。
 *
 * 调用点只放在各表单保存成功分支（新增 / 编辑共用），不要挂到 SmartSelect 的 onChange 上。
 */
export function recordRecentCategory(categoryId?: string | null) {
  if (typeof window === "undefined") return;
  const id = String(categoryId ?? "").trim();
  if (!id) return;
  try {
    const now = Date.now();
    const next: LocalRecentCategory[] = [
      { id, at: now },
      ...readLocalRecentCategories().filter((entry) => entry.id !== id),
    ].slice(0, RECENT_CATEGORY_LIMIT);
    window.localStorage.setItem(RECENT_CATEGORIES_KEY, JSON.stringify(next));
    window.dispatchEvent(
      new CustomEvent(RECENT_CATEGORIES_EVENT, { detail: { categoryId: id, ids: next.map((entry) => entry.id) } }),
    );
  } catch {
    // ignore local preference write failures
  }
}

/**
 * 丢弃本会话的服务端分类用量快照。保存成功后调用，下次打开下拉会重新拉取，
 * 否则模块级 `cachedUsage` 会让「最近使用 / 常用分类」停留在页面首次加载时的样子。
 */
export function invalidateCategoryUsage() {
  cachedUsage.clear();
}

/**
 * 读取分类快捷选择数据（按账簿缓存 + 并发去重）。
 * 记账成功后页面会派发 FINANCE_DATA_CHANGED_EVENT，hook 会自动强制刷新。
 */
export function fetchCategoryUsage(force = false): Promise<CategoryUsageStats> {
  const householdId = readHouseholdCacheKey();
  const cached = cachedUsage.get(householdId);
  const existing = inflight.get(householdId);
  if (existing) return existing;
  if (!force && cached) return Promise.resolve(cached);
  const request = (async () => {
    try {
      const response = await fetch("/api/v1/category/usage", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { usage?: { recent?: unknown; frequent?: unknown } };
      const next: CategoryUsageStats = {
        recent: normalizeIds(payload.usage?.recent),
        frequent: normalizeIds(payload.usage?.frequent),
      };
      cachedUsage.set(householdId, next);
      return next;
    } catch (error) {
      console.warn("Failed to load category usage", {
        householdId,
        error: error instanceof Error ? error.message : String(error),
      });
      return cachedUsage.get(householdId) ?? EMPTY_USAGE;
    } finally {
      inflight.delete(householdId);
    }
  })();
  inflight.set(householdId, request);
  return request;
}

/**
 * 表单组件挂载后立即预取；`enabled` 只控制后续记账变更时是否重新拉取。
 */
export function useCategoryUsage(enabled: boolean): CategoryUsageStats {
  const [usage, setUsage] = useState<CategoryUsageStats>(() => cachedUsage.get(readHouseholdCacheKey()) ?? EMPTY_USAGE);
  const [localRecent, setLocalRecent] = useState<string[]>(() => readLocalRecentCategoryIds());

  useEffect(() => {
    const syncLocalRecent = () => setLocalRecent(readLocalRecentCategoryIds());
    syncLocalRecent();
    window.addEventListener(RECENT_CATEGORIES_EVENT, syncLocalRecent);
    window.addEventListener("storage", syncLocalRecent);
    return () => {
      window.removeEventListener(RECENT_CATEGORIES_EVENT, syncLocalRecent);
      window.removeEventListener("storage", syncLocalRecent);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = (force: boolean) => {
      void fetchCategoryUsage(force).then((next) => {
        if (alive && readHouseholdCacheKey() === householdId) setUsage(next);
      });
    };
    const householdId = readHouseholdCacheKey();
    load(false);
    if (!enabled) {
      return () => {
        alive = false;
      };
    }
    const handleChange = () => load(true);
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleChange);
    return () => {
      alive = false;
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleChange);
    };
  }, [enabled]);

  // 本地最近选中优先，其余沿用服务端口径（两者 id 去重后拼接）。
  return useMemo(
    () => (localRecent.length === 0 ? usage : { recent: mergeIds(localRecent, usage.recent), frequent: usage.frequent }),
    [localRecent, usage],
  );
}

/**
 * 生成下拉里的快捷分类行：
 * - 第一排 recent：最近入账用过的分类，取前 5 个「当前可见」的；
 * - 第二排 frequent：使用次数最多的分类，排除第一排已出现的，保证不重复。
 */
export function buildCategoryQuickPickGroups({
  usage,
  availableIds,
  labels,
  recentLimit = 5,
  frequentLimit = 8,
}: {
  usage: CategoryUsageStats;
  availableIds: Iterable<string>;
  labels: { recent: string; frequent: string };
  recentLimit?: number;
  frequentLimit?: number;
}): SmartSelectQuickPickGroup[] {
  const available = new Set(availableIds);
  const pick = (ids: string[], limit: number, exclude: Set<string>) => {
    const picked: string[] = [];
    for (const id of ids) {
      if (picked.length >= limit) break;
      if (!available.has(id) || exclude.has(id) || picked.includes(id)) continue;
      picked.push(id);
    }
    return picked;
  };

  const recent = pick(usage.recent, recentLimit, new Set());
  const frequent = pick(usage.frequent, frequentLimit, new Set(recent));

  const groups: SmartSelectQuickPickGroup[] = [];
  if (recent.length > 0) groups.push({ key: "recent", label: labels.recent, optionIds: recent });
  if (frequent.length > 0) groups.push({ key: "frequent", label: labels.frequent, optionIds: frequent });
  return groups;
}
