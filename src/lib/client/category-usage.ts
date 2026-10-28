"use client";

import { useEffect, useState } from "react";
import type { SmartSelectQuickPickGroup } from "@/components/SmartSelect";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";

export type CategoryUsageStats = {
  /** 最近入账用过的分类 id（按入账日期倒序）。 */
  recent: string[];
  /** 入账次数最多的分类 id（按次数倒序）。 */
  frequent: string[];
};

const EMPTY_USAGE: CategoryUsageStats = { recent: [], frequent: [] };

let cachedUsage: CategoryUsageStats | null = null;
let inflight: Promise<CategoryUsageStats> | null = null;

function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

/**
 * 读取分类快捷选择数据（模块级缓存 + 并发去重）。
 * 记账成功后页面会派发 FINANCE_DATA_CHANGED_EVENT，hook 会自动强制刷新。
 */
export function fetchCategoryUsage(force = false): Promise<CategoryUsageStats> {
  if (!force && cachedUsage) return Promise.resolve(cachedUsage);
  if (!force && inflight) return inflight;
  const request = (async () => {
    try {
      const response = await fetch("/api/v1/category/usage", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { usage?: { recent?: unknown; frequent?: unknown } };
      const next: CategoryUsageStats = {
        recent: normalizeIds(payload.usage?.recent),
        frequent: normalizeIds(payload.usage?.frequent),
      };
      cachedUsage = next;
      return next;
    } catch {
      return cachedUsage ?? EMPTY_USAGE;
    } finally {
      inflight = null;
    }
  })();
  inflight = request;
  return request;
}

/** `enabled` 为 false（表单未打开）时不发请求。 */
export function useCategoryUsage(enabled: boolean): CategoryUsageStats {
  const [usage, setUsage] = useState<CategoryUsageStats>(() => cachedUsage ?? EMPTY_USAGE);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = (force: boolean) => {
      void fetchCategoryUsage(force).then((next) => {
        if (alive) setUsage(next);
      });
    };
    load(false);
    const handleChange = () => load(true);
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleChange);
    return () => {
      alive = false;
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleChange);
    };
  }, [enabled]);

  return usage;
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
