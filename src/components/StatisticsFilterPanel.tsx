"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

type AccountItem = {
  id: string;
  name: string;
  kind: string;
  Institution?: { name: string } | null;
};

type TagItem = {
  id: string;
  name: string;
  color: string | null;
};

const accountLabel = (a: AccountItem) => {
  const inst = a.Institution?.name?.trim();
  return inst ? `${inst}·${a.name}` : a.name;
};

export function StatisticsFilterPanel({
  allAccounts,
  allTags,
  year,
}: {
  allAccounts: AccountItem[];
  allTags: TagItem[];
  year: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedAccountIds = searchParams.get("accounts")
    ? searchParams.get("accounts")!.split(",").filter(Boolean)
    : [];
  const selectedTagIds = searchParams.get("tags")
    ? searchParams.get("tags")!.split(",").filter(Boolean)
    : [];

  function buildHref(accountIds: string[], tagIds: string[]) {
    const params = new URLSearchParams();
    params.set("year", String(year));
    if (accountIds.length > 0) params.set("accounts", accountIds.join(","));
    if (tagIds.length > 0) params.set("tags", tagIds.join(","));
    return `/statistics?${params.toString()}`;
  }

  function toggleAccount(id: string) {
    const next = selectedAccountIds.includes(id)
      ? selectedAccountIds.filter(x => x !== id)
      : [...selectedAccountIds, id];
    router.push(buildHref(next, selectedTagIds));
  }

  function toggleTag(id: string) {
    const next = selectedTagIds.includes(id)
      ? selectedTagIds.filter(x => x !== id)
      : [...selectedTagIds, id];
    router.push(buildHref(selectedAccountIds, next));
  }

  const hrefYear = (y: number) => buildHref(selectedAccountIds, selectedTagIds).replace(`year=${year}`, `year=${y}`);

  return (
    <div className="flex items-center gap-3">
      {/* 年份切换 */}
      <div className="flex items-center gap-1">
        <Link href={hrefYear(year - 1)} className="h-7 w-7 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-50 flex items-center justify-center">◀</Link>
        <span className="text-sm font-semibold text-slate-700 w-16 text-center">{year}年</span>
        <Link href={hrefYear(year + 1)} className="h-7 w-7 rounded border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-50 flex items-center justify-center">▶</Link>
      </div>

      {/* 账户筛选 */}
      <div className="relative group">
        <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded cursor-pointer hover:bg-slate-200">
          {selectedAccountIds.length > 0 ? `已选 ${selectedAccountIds.length} 个账户` : "全部账户"}
        </span>
        <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block bg-white border border-slate-200 rounded-lg shadow-lg p-2 min-w-[240px] max-h-64 overflow-y-auto">
          {allAccounts.map(a => (
            <label key={a.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-slate-50 rounded cursor-pointer">
              <input
                type="checkbox"
                checked={selectedAccountIds.includes(a.id)}
                onChange={() => toggleAccount(a.id)}
                className="rounded"
              />
              {accountLabel(a)}
            </label>
          ))}
        </div>
      </div>

      {/* 标签筛选 */}
      {allTags.length > 0 && (
        <div className="relative group">
          <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded cursor-pointer hover:bg-slate-200">
            {selectedTagIds.length > 0 ? `已选 ${selectedTagIds.length} 个标签` : "全部标签"}
          </span>
          <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block bg-white border border-slate-200 rounded-lg shadow-lg p-2 min-w-[200px] max-h-64 overflow-y-auto">
            {allTags.map(t => {
              const c = t.color || "#3B82F6";
              const checked = selectedTagIds.includes(t.id);
              return (
                <label key={t.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-slate-50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTag(t.id)}
                    className="rounded"
                  />
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c }} />
                    {t.name}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
