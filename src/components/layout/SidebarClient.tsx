"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, startTransition } from "react";
import {
  LayoutDashboard,
  Users,
  Settings,
  CalendarClock,
  Leaf,
  ChevronDown,
  ArrowUpDown,
  EyeOff,
  Landmark,
  BarChart3,
} from "lucide-react";
import { LedgerSwitcher } from "../LedgerSwitcher";
import { NewLedgerSetupCheck } from "../NewLedgerSetupCheck";
import { InitModal } from "../InitModal";
import { DailyTaskCheck } from "../DailyTaskCheck";
import { formatMoney } from "@/lib/format";
import { getHouseholdDisplayName } from "@/lib/household-display";
import {
  APP_PREFS_EVENT,
  getAppPreferences,
  setSidebarGroupPreference,
  setSidebarHideZeroPreference,
} from "@/lib/client/appPreferences";

type AccountItem = {
  id?: string | null;
  name: string;
  label: string;
  balance: number;
  kind: string;
  institution?: string;
  investProductType?: string;
};

const ASSET_KINDS = ["cash", "bank_debit", "ewallet"];
const INVEST_KINDS = ["investment", "investment_fund", "investment_money", "investment_wealth"];
const LIABILITY_KINDS = ["bank_credit", "loan", "other"];
const SECTION_ICON: Record<string, React.ElementType> = {
  资产: Landmark,
  投资: BarChart3,
  负债: Landmark,
};

export function SidebarClient({ items: initialItems, household, isRedUp, user }: { items: AccountItem[]; household: { id: string; name: string } | null; isRedUp: boolean; user: { id: string; name: string; role: string } | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccountId = (searchParams.get("accountId") ?? "").trim();
  const selectedAccount = (searchParams.get("account") ?? "").trim();

  const [groupByInstitution, setGroupByInstitution] = useState(false);
  const [hideZero, setHideZero] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [items, setItems] = useState(initialItems);
  const [initOpen, setInitOpen] = useState(false);
  const footerAvatarRef = useRef<HTMLDivElement>(null);
  const householdDisplayName = getHouseholdDisplayName(household);

  async function handleLogout() {
    if (!window.confirm("确认退出当前账号吗？")) return;
    try {
      const res = await fetch("/api/v1/auth/logout", {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok !== true) {
        throw new Error(data?.error || `退出接口返回 ${res.status}`);
      }
      window.location.assign("/login");
    } catch (error) {
      window.alert(error instanceof Error ? `无法退出：${error.message}` : "无法退出");
    }
  }

  // Refresh items when fund data changes (debounced)
  // Only updates items whose data actually changed to minimize React re-renders
  const sidebarRefreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sidebarRefreshBusy = useRef(false);
  useEffect(() => {
    const debouncedRefresh = () => {
      if (sidebarRefreshTimer.current) clearTimeout(sidebarRefreshTimer.current);
      sidebarRefreshTimer.current = setTimeout(async () => {
        if (sidebarRefreshBusy.current) return;
        sidebarRefreshBusy.current = true;
        try {
          const res = await fetch("/api/v1/accounts/internal");
          const data = await res.json();
          if (data.ok && data.accounts) {
            startTransition(() => {
              setItems(prev => {
                const fresh: AccountItem[] = data.accounts.map((a: any) => ({
                  id: a.id,
                  name: a.name,
                  label: (a.Institution?.name?.trim() || "") + (a.Institution?.name?.trim() ? "·" : "") + a.name,
                  balance: Number(a.balance ?? 0),
                  kind: a.kind,
                  institution: a.Institution?.name?.trim() || undefined,
                  investProductType: a.investProductType || undefined,
                }));
                // Merge: only update items whose data actually changed
                // Unchanged items keep their object reference → React skips re-render
                let changed = false;
                const next = prev.map(p => {
                  const f = fresh.find(f => f.id === p.id);
                  if (f && (p.balance !== f.balance || p.name !== f.name || p.institution !== f.institution)) {
                    changed = true;
                    return f;
                  }
                  return p;
                });
                // Handle newly created accounts
                for (const f of fresh) {
                  if (!prev.some(p => p.id === f.id)) {
                    next.push(f);
                    changed = true;
                  }
                }
                return changed ? next : prev;
              });
            });
          }
        } catch {
        } finally {
          sidebarRefreshBusy.current = false;
        }
      }, 100);
    };
    window.addEventListener("mmh:fund:refresh", debouncedRefresh);
    return () => {
      window.removeEventListener("mmh:fund:refresh", debouncedRefresh);
      if (sidebarRefreshTimer.current) clearTimeout(sidebarRefreshTimer.current);
    };
  }, []);

  useEffect(() => {
    const applyPrefs = () => {
      const prefs = getAppPreferences();
      setGroupByInstitution(prefs.sidebarGroupBy === "institution");
      setHideZero(prefs.sidebarHideZero);
    };
    applyPrefs();
    window.addEventListener(APP_PREFS_EVENT, applyPrefs as EventListener);
    return () => window.removeEventListener(APP_PREFS_EVENT, applyPrefs as EventListener);
  }, []);

  function toggleGroupBy() {
    const next = !groupByInstitution;
    setGroupByInstitution(next);
    setSidebarGroupPreference(next ? "institution" : "kind");
  }

  function toggleHideZero() {
    const next = !hideZero;
    setHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  function toggleSection(key: string) {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const navItemCls = (href: string) => 
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 ${
      (href === "/" ? pathname === "/" : pathname.startsWith(href))
        ? "sidebar-item-active"
        : "text-slate-600 hover:bg-white hover:text-slate-900"
    }`;

  const accountLinkCls = (active: boolean) =>
    `flex items-center justify-between rounded-lg px-3 py-2 text-xs transition-all duration-200 ${
      active
        ? "border border-blue-100 bg-blue-50/80 text-slate-900 shadow-sm"
        : "border border-transparent text-slate-600 hover:border-slate-100 hover:bg-white hover:text-slate-900"
    }`;

  const balCls = (n: number) => n > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : n < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-foreground/40";

  // Restore and Refine Grouping logic
  const visibleItems = hideZero ? items.filter(it => it.balance !== 0) : items;

  const sections = useMemo(() => {
    if (groupByInstitution) {
      const instGrouped: Record<string, AccountItem[]> = {};
      for (const it of visibleItems) {
        const instKey = it.institution || "未指定机构";
        if (!instGrouped[instKey]) instGrouped[instKey] = [];
        instGrouped[instKey].push(it);
      }
      return Object.entries(instGrouped)
        .sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
        .map(([inst, accounts]) => ({
          kind: inst, label: inst, accounts,
          total: accounts.reduce((s, a) => s + a.balance, 0)
        }));
    } else {
      const groups = [
        { label: "资产", kinds: ASSET_KINDS },
        { label: "投资", kinds: INVEST_KINDS },
        { label: "负债", kinds: LIABILITY_KINDS }
      ];
      return groups.map(g => {
        const filtered = visibleItems.filter(it => g.kinds.includes(it.kind) || (g.label === "投资" && it.kind.startsWith("investment_")));
        return {
          kind: g.label, label: g.label, accounts: filtered,
          total: filtered.reduce((s, a) => s + a.balance, 0)
        };
      }).filter(s => s.accounts.length > 0);
    }
  }, [visibleItems, groupByInstitution]);

  return (
    <aside className="h-screen w-72 shrink-0 overflow-hidden border-r border-slate-200/80 bg-white/84 backdrop-blur-xl">
      {/* Fixed Header */}
      <div className="shrink-0 px-5 pt-5 pb-3">
        <div
          ref={footerAvatarRef}
          onClick={() => setSwitcherOpen(!switcherOpen)}
          className="group flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200/80 bg-white/90 px-3 py-3 shadow-sm transition-colors hover:bg-white"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <Leaf size={18} />
          </div>
          <div className="min-w-0 flex-1 text-slate-900">
            <p className="truncate text-sm font-semibold leading-none">{user?.name || "未登录"}</p>
            <div className="mt-1 flex items-center gap-2">
              <p className="truncate text-[11px] text-slate-400">{householdDisplayName}</p>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                {user?.role === "admin" ? "管理员" : "用户"}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); handleLogout(); }}
                className="whitespace-nowrap rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] text-red-600 opacity-0 transition-opacity group-hover:opacity-100"
                title="退出当前用户"
              >
                退出
              </button>
            </div>
          </div>
          <ChevronDown size={16} className={`text-slate-300 transition-all duration-200 group-hover:text-slate-500 ${switcherOpen ? "rotate-180" : ""}`} />
          <Link href="/settings" onClick={(e) => e.stopPropagation()} className="rounded-md p-1 text-slate-300 transition-colors hover:bg-slate-50 hover:text-slate-600">
            <Settings size={18} />
          </Link>
        </div>
        <LedgerSwitcher
          current={household}
          anchorRef={footerAvatarRef}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
        />
      </div>

      {/* Main Body (Accounts scroll, bottom nav pinned) */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <div className="shrink-0">
          <nav className="space-y-1">
            <Link href="/overview" className={navItemCls("/overview")}>
              <LayoutDashboard size={18} />
              <span className="font-medium">概览</span>
            </Link>
            <Link href="/accounts" className={navItemCls("/accounts")}>
              <Landmark size={18} />
              <span className="font-medium">资金账户</span>
            </Link>
            <Link href="/invest" className={navItemCls("/invest")}>
              <BarChart3 size={18} />
              <span className="font-medium">投资</span>
            </Link>
          </nav>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <nav className="space-y-1">
            <div className="mb-3 mt-5 flex items-center justify-between px-2">
              <span className="text-[11px] font-medium tracking-[0.14em] text-slate-400 uppercase">账户</span>
              <div className="flex items-center gap-1">
                <button onClick={toggleHideZero} className={`rounded-md p-1 transition-colors ${hideZero ? "bg-slate-100 text-slate-600" : "text-slate-300 hover:bg-slate-50 hover:text-slate-500"}`} title="隐藏余额为0的账户">
                  <EyeOff size={14} />
                </button>
                <button onClick={toggleGroupBy} className="rounded-md p-1 text-slate-300 transition-colors hover:bg-slate-50 hover:text-slate-500" title="切换分组方式">
                  <ArrowUpDown size={14} />
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {sections.map((sec) => {
                const collapsed = collapsedSections.has(sec.kind);
                const SectionIcon = SECTION_ICON[sec.label] ?? Landmark;
                return (
                  <div key={sec.kind}>
                    <div
                      className="sticky top-0 z-10 flex w-full items-center rounded-lg bg-white/92 px-3 py-2 backdrop-blur transition-all duration-200 hover:bg-white group"
                    >
                      <Link
                        href={sec.label === "投资" ? "/investments" : "/accounts"}
                        className="flex items-center gap-2 text-sm font-semibold text-slate-800"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <SectionIcon size={14} />
                        </span>
                        <span>{sec.label}</span>
                      </Link>
                      <span className="flex-1" />
                      <button
                        onClick={() => toggleSection(sec.kind)}
                        className={`mr-1 text-[11px] font-semibold tabular-nums ${balCls(sec.total)}`}
                      >
                        {formatMoney(sec.total)}
                      </button>
                      <button
                        onClick={() => toggleSection(sec.kind)}
                        className="text-slate-300 transition-all duration-200 group-hover:text-slate-500"
                      >
                        <ChevronDown
                          size={14}
                          className={collapsed ? "-rotate-90" : ""}
                        />
                      </button>
                    </div>
                    {!collapsed && (
                      <div className="mt-1 space-y-1">
                        {sec.accounts.map((it) => {
                          const active = pathname === "/" && (it.id ? selectedAccountId === it.id : !selectedAccountId && selectedAccount === it.name);
                          const href = (() => {
                            const q = new URLSearchParams();
                            if (it.id) q.set("accountId", it.id);
                            else q.set("account", it.name);
                            const view = it.kind === "investment"
                              ? (it.investProductType === "money" ? "investmoney" : "investfund")
                              : (it.kind === "bank_credit" || it.kind === "loan" ? "bill" : "detail");
                            q.set("view", view);
                            return `/?${q.toString()}`;
                          })();
                          return (
                            <Link key={`${it.id}:${it.name}`} href={href} className={accountLinkCls(active)}>
                              <span className="min-w-0 flex-1 truncate pr-2">{it.label}</span>
                              <span className={`text-[11px] font-medium tabular-nums ${balCls(it.balance)}`}>{formatMoney(it.balance)}</span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </nav>
        </div>

        <div className="mt-4 shrink-0 space-y-1 border-t border-slate-200 pt-4">
          <Link href="/regular-invest" className={navItemCls("/regular-invest")}>
            <CalendarClock size={18} />
            <span className="font-medium">定投</span>
          </Link>
          <button
            onClick={() => setInitOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-600 transition-all duration-200 hover:bg-white hover:text-slate-900"
          >
            <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20M2 12h20" />
            </svg>
            <span className="font-medium">初始数据</span>
          </button>
          <Link href="/settings" className={navItemCls("/settings")}>
            <Users size={18} />
            <span className="font-medium">账户管理</span>
          </Link>
        </div>
      </div>

      <NewLedgerSetupCheck />
      <InitModal open={initOpen} onOpenChange={setInitOpen} />
      <DailyTaskCheck />
    </aside>
  );
}
