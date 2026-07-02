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
  Repeat,
  EyeOff,
  Landmark,
  BarChart3,
  CreditCard,
  Shield,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import { LedgerSwitcher } from "../LedgerSwitcher";
import { NewLedgerSetupCheck } from "../NewLedgerSetupCheck";
import { InitModal } from "../InitModal";
import { DailyTaskCheck } from "../DailyTaskCheck";
import { formatMoney } from "@/lib/format";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { buildAccountDisplayOption } from "@/lib/account-display";
import {
  APP_PREFS_EVENT,
  getAppPreferences,
  getSidebarCollapsedPreference,
  getSidebarGroupPreference,
  getSidebarHideZeroPreference,
  getSidebarOwnerFilterPreference,
  setSidebarCollapsedPreference,
  setSidebarGroupPreference,
  setSidebarHideZeroPreference,
  setSidebarOwnerFilterPreference,
} from "@/lib/client/appPreferences";

type AccountItem = {
  id?: string | null;
  name: string;
  label: string;
  shortLabel?: string;
  balance: number;
  kind: string;
  groupName?: string;
  institution?: string;
  investProductType?: string;
};

function normalizeSidebarItemKind(item: Pick<AccountItem, "kind" | "investProductType">) {
  if (item.kind === "investment" && item.investProductType === "deposit") return "deposit";
  return item.kind;
}

function normalizeSidebarAccountItem(item: AccountItem): AccountItem {
  return {
    ...item,
    kind: normalizeSidebarItemKind(item),
  };
}

const ASSET_KINDS = ["cash", "bank_debit", "ewallet", "deposit"];
const CREDIT_KINDS = ["bank_credit"];
const INVEST_KINDS = ["investment", "investment_fund", "investment_money", "investment_wealth"];
const INSURANCE_KINDS = ["insurance"];
const LIABILITY_KINDS = ["loan_summary", "loan", "other"];
const ASSET_SUBGROUPS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: "cash_like", label: "现金", kinds: ["cash"] },
  { key: "bank_debit_like", label: "借记卡", kinds: ["bank_debit"] },
  { key: "ewallet_like", label: "电子钱包", kinds: ["ewallet"] },
  { key: "deposit_like", label: "定期", kinds: ["deposit"] },
];
const SECTION_ICON: Record<string, React.ElementType> = {
  资产: Landmark,
  信用卡: CreditCard,
  投资: BarChart3,
  保险: Shield,
  往来款: Landmark,
};
const KIND_SORT_ORDER = new Map<string, number>([
  ["cash", 10],
  ["bank_debit", 20],
  ["ewallet", 30],
  ["deposit", 40],
  ["investment", 50],
  ["investment_money", 51],
  ["investment_fund", 52],
  ["investment_wealth", 53],
  ["insurance", 55],
  ["bank_credit", 60],
  ["loan_summary", 70],
  ["loan", 71],
  ["other", 99],
]);
const KIND_INLINE_LABEL = new Map<string, string>([
  ["cash", "现金"],
  ["bank_debit", "借记卡"],
  ["ewallet", "电子钱包"],
  ["deposit", "存款"],
  ["investment", "开放式基金"],
  ["investment_money", "货币基金"],
  ["investment_fund", "开放式基金"],
  ["investment_wealth", "理财"],
  ["insurance", "保险"],
  ["bank_credit", "信用卡"],
  ["loan_summary", "借入/借出"],
  ["loan", "借入/借出"],
  ["other", "其他"],
]);

function normalizeSidebarItems(items: AccountItem[]) {
  const normalized = items.map(normalizeSidebarAccountItem);
  const loanItems = normalized.filter((item) => item.kind === "loan");
  const otherItems = normalized.filter((item) => item.kind !== "loan");

  if (loanItems.length === 0) return otherItems;

  const loanBalance = loanItems.reduce((sum, item) => sum + item.balance, 0);
  return [
    ...otherItems,
    {
      id: "__debt__",
      name: "借入/借出",
      label: "借入/借出",
      balance: loanBalance,
      kind: "loan_summary",
      groupName: "未设置所有人",
      institution: "往来款",
    },
  ];
}

function toSidebarAccountItem(a: any, creditCardLabelTemplate: string): AccountItem {
  const display = buildAccountDisplayOption({
    id: a.id,
    name: a.name,
    kind: a.kind,
    numberMasked: a.numberMasked,
    groupId: a.groupId ?? "",
    investProductType: a.investProductType ?? null,
    Institution: a.Institution ?? null,
    AccountGroup: a.AccountGroup ?? null,
  }, creditCardLabelTemplate);
  return {
    id: a.id,
    name: a.name,
    label: display.label,
    shortLabel: display.selectorCoreLabel,
    balance: Number(a.balance ?? 0),
    kind: a.kind,
    groupName: display.groupName || "未设置所有人",
    institution: a.Institution?.name?.trim() || display.institutionName || undefined,
    investProductType: a.investProductType || undefined,
  };
}

export function SidebarClient({
  items: initialItems,
  household,
  isRedUp,
  user,
  initialPreferences,
}: {
  items: AccountItem[];
  household: { id: string; name: string } | null;
  isRedUp: boolean;
  user: { id: string; name: string; role: string } | null;
  initialPreferences?: {
    sidebarOwnerFilter: string;
    sidebarHideZero: boolean;
    sidebarCollapsed: boolean;
    sidebarGroupBy: "kind" | "institution";
  };
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccountId = (searchParams.get("accountId") ?? "").trim();
  const selectedAccount = (searchParams.get("account") ?? "").trim();
  const selectedView = (searchParams.get("view") ?? "").trim();

  const [selectedOwnerFilter, setSelectedOwnerFilter] = useState(() => initialPreferences?.sidebarOwnerFilter ?? getSidebarOwnerFilterPreference());
  const [hideZero, setHideZero] = useState(() => initialPreferences?.sidebarHideZero ?? getSidebarHideZeroPreference());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialPreferences?.sidebarCollapsed ?? getSidebarCollapsedPreference());
  const [sidebarGroupBy, setSidebarGroupBy] = useState<"kind" | "institution">(() => initialPreferences?.sidebarGroupBy ?? getSidebarGroupPreference());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [collapsedAssetSubgroupKeys, setCollapsedAssetSubgroupKeys] = useState<Set<string>>(new Set());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [items, setItems] = useState(() => normalizeSidebarItems(initialItems));
  const [initOpen, setInitOpen] = useState(false);
  const footerAvatarRef = useRef<HTMLDivElement>(null);
  const initializedSectionsRef = useRef(false);
  const initializedAssetSubgroupsRef = useRef(false);
  const householdDisplayName = getHouseholdDisplayName(household);
  const householdId = household?.id ?? "";
  const ownerOptions = useMemo(
    () => Array.from(new Set(items.map((item) => item.groupName || "未设置所有人")))
      .filter((name) => name !== "未指定")
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [items],
  );

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
    startTransition(() => {
      setItems(normalizeSidebarItems(initialItems));
    });
    setSelectedOwnerFilter("");
    setCollapsedSections(new Set());
    setCollapsedAssetSubgroupKeys(new Set());
    initializedSectionsRef.current = false;
    initializedAssetSubgroupsRef.current = false;
  }, [householdId, initialItems]);

  useEffect(() => {
    const debouncedRefresh = () => {
      if (sidebarRefreshTimer.current) clearTimeout(sidebarRefreshTimer.current);
      sidebarRefreshTimer.current = setTimeout(async () => {
        if (sidebarRefreshBusy.current) return;
        sidebarRefreshBusy.current = true;
        try {
          const res = await fetch("/api/v1/accounts/internal", { cache: "no-store" });
          const contentType = res.headers.get("content-type") || "";
          if (!res.ok || !contentType.includes("application/json")) return;
          const data = await res.json().catch(() => null);
          if (data?.ok && Array.isArray(data?.accounts)) {
            const creditCardLabelTemplate = getAppPreferences().creditCardLabelTemplate;
            startTransition(() => {
              setItems(prev => {
                const fresh: AccountItem[] = normalizeSidebarItems(data.accounts.map((a: any) => toSidebarAccountItem(a, creditCardLabelTemplate)));
                // Merge: only update items whose data actually changed
                // Unchanged items keep their object reference → React skips re-render
                let changed = false;
                const next = prev.map(p => {
                  const f = fresh.find(f => f.id === p.id);
                  if (f && (p.balance !== f.balance || p.name !== f.name || p.groupName !== f.groupName || p.institution !== f.institution || p.label !== f.label || p.kind !== f.kind)) {
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
                if (next.length !== fresh.length) {
                  return fresh;
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
    debouncedRefresh();
    window.addEventListener("mmh:fund:refresh", debouncedRefresh);
    return () => {
      window.removeEventListener("mmh:fund:refresh", debouncedRefresh);
      if (sidebarRefreshTimer.current) clearTimeout(sidebarRefreshTimer.current);
    };
  }, [householdId]);

  useEffect(() => {
    const applyPrefs = () => {
      const prefs = getAppPreferences();
      setSelectedOwnerFilter(prefs.sidebarOwnerFilter);
      setHideZero(prefs.sidebarHideZero);
      setSidebarCollapsed(prefs.sidebarCollapsed);
      setSidebarGroupBy(getSidebarGroupPreference());
    };
    applyPrefs();
    window.addEventListener(APP_PREFS_EVENT, applyPrefs as EventListener);
    return () => window.removeEventListener(APP_PREFS_EVENT, applyPrefs as EventListener);
  }, []);

  function cycleOwnerFilter() {
    const cycle = ["", ...ownerOptions];
    const current = getSidebarOwnerFilterPreference();
    const currentIndex = cycle.indexOf(current);
    const next = cycle[(currentIndex + 1 + cycle.length) % cycle.length] ?? "";
    setSelectedOwnerFilter(next);
    setSidebarOwnerFilterPreference(next);
  }

  function toggleHideZero() {
    const next = !hideZero;
    setHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  function toggleSidebarCollapsed() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    setSidebarCollapsedPreference(next);
    if (next) setSwitcherOpen(false);
  }

  function cycleSidebarGroupBy() {
    const next = sidebarGroupBy === "kind" ? "institution" : "kind";
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function toggleSection(key: string) {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function openOnlySection(key: string) {
    setCollapsedSections(prev => {
      if (!prev.has(key)) {
        const next = new Set(prev);
        next.add(key);
        return next;
      }
      return new Set(sections.map((section) => section.kind).filter((sectionKey) => sectionKey !== key));
    });
  }

  const navItemCls = (href: string) => 
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 ${
      (href === "/" ? pathname === "/" : pathname.startsWith(href))
        ? "sidebar-item-active"
        : "text-slate-600 hover:bg-white hover:text-slate-900"
    }`;

  const accountLinkCls = (active: boolean) =>
    `flex items-center justify-between rounded-lg px-3 py-1.5 text-xs transition-all duration-200 ${
      active
        ? "border border-blue-100 bg-blue-50/80 text-slate-900 shadow-sm"
        : "border border-transparent text-slate-600 hover:border-slate-100 hover:bg-white hover:text-slate-900"
    }`;

  const balCls = (n: number) => n > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : n < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-foreground/40";
  const liabilityCls = (n: number) => n > 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : n < 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : "text-foreground/40";
  const displayBalance = (item: AccountItem) => item.kind === "bank_credit" ? -item.balance : item.balance;
  const displaySectionTotal = (kind: string, value: number) => kind === "信用卡" ? -value : value;
  const itemBalanceCls = (item: AccountItem) => balCls(displayBalance(item));
  const sectionBalanceCls = (kind: string, value: number) => balCls(displaySectionTotal(kind, value));
  const collapsedNavCls = (active: boolean) =>
    `flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 ${
      active
        ? "bg-blue-50 text-blue-600 shadow-sm"
        : "text-slate-500 hover:bg-white hover:text-slate-900"
    }`;

  // Restore and Refine Grouping logic
  const visibleItems = items.filter((item) => {
    if (hideZero && item.balance === 0) return false;
    if (selectedOwnerFilter && (item.groupName || "未设置所有人") !== selectedOwnerFilter) return false;
    return true;
  });

  const sections = useMemo(() => {
    if (sidebarGroupBy === "institution") {
      const map = new Map<string, { kind: string; label: string; accounts: AccountItem[]; total: number; subgroups: never[] }>();
      for (const item of visibleItems) {
        const label = item.institution?.trim() || "未设机构";
        const key = `institution:${label}`;
        const existing = map.get(key);
        if (existing) {
          existing.accounts.push(item);
          existing.total += displayBalance(item);
        } else {
          map.set(key, {
            kind: key,
            label,
            accounts: [item],
            total: displayBalance(item),
            subgroups: [],
          });
        }
      }
      return Array.from(map.values())
        .map((section) => ({
          ...section,
          accounts: [...section.accounts].sort((a, b) => {
            const kindDiff = (KIND_SORT_ORDER.get(a.kind) ?? 999) - (KIND_SORT_ORDER.get(b.kind) ?? 999);
            if (kindDiff !== 0) return kindDiff;
            return a.label.localeCompare(b.label, "zh-Hans-CN");
          }),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    }

    const groups = [
      { label: "资产", kinds: ASSET_KINDS },
      { label: "信用卡", kinds: CREDIT_KINDS },
      { label: "投资", kinds: INVEST_KINDS },
      { label: "保险", kinds: INSURANCE_KINDS },
      { label: "往来款", kinds: LIABILITY_KINDS }
    ];
    return groups.map(g => {
      const filtered = visibleItems.filter(it => g.kinds.includes(it.kind) || (g.label === "投资" && it.kind.startsWith("investment_")));
      const subgroups =
        g.label === "资产"
          ? (() => {
              const subgroupItems = ASSET_SUBGROUPS.map((subgroup) => {
                const accounts = filtered.filter((item) => subgroup.kinds.includes(item.kind));
                return {
                  key: subgroup.key,
                  label: subgroup.label,
                  accounts,
                  total: accounts.reduce((sum, account) => sum + account.balance, 0),
                };
              }).filter((subgroup) => subgroup.accounts.length > 0);
              const coveredKinds = new Set(ASSET_SUBGROUPS.flatMap((subgroup) => subgroup.kinds));
              const fallbackAccounts = filtered.filter((item) => !coveredKinds.has(item.kind));
              if (fallbackAccounts.length > 0) {
                subgroupItems.push({
                  key: "other_asset",
                  label: "其他资产",
                  accounts: fallbackAccounts,
                  total: fallbackAccounts.reduce((sum, account) => sum + account.balance, 0),
                });
              }
              return subgroupItems;
            })()
          : [];
      return {
        kind: g.label, label: g.label, accounts: filtered,
        total: filtered.reduce((s, a) => s + a.balance, 0),
        subgroups,
      };
    }).filter(s => s.accounts.length > 0);
  }, [visibleItems, sidebarGroupBy]);

  function isAccountItemActive(item: AccountItem) {
    if (pathname !== "/") return false;
    if (item.kind === "loan_summary") return selectedView === "debt";
    return item.id ? selectedAccountId === item.id : !selectedAccountId && selectedAccount === item.name;
  }

  const activeSectionKind = useMemo(() => {
    return sections.find((section) => section.accounts.some(isAccountItemActive))?.kind ?? sections[0]?.kind ?? "";
  }, [sections, pathname, selectedView, selectedAccountId, selectedAccount]);

  const activeAssetSubgroupKey = useMemo(() => {
    if (sidebarGroupBy !== "kind") return "";
    const assetSection = sections.find((section) => section.kind === "资产");
    if (!assetSection?.subgroups?.length) return "";
    return assetSection.subgroups.find((subgroup) => subgroup.accounts.some(isAccountItemActive))?.key ?? assetSection.subgroups[0]?.key ?? "";
  }, [sections, pathname, selectedView, selectedAccountId, selectedAccount, sidebarGroupBy]);

  useEffect(() => {
    if (initializedSectionsRef.current || sections.length === 0) return;
    initializedSectionsRef.current = true;
    const openKey = activeSectionKind || sections[0]?.kind;
    if (!openKey) return;
    setCollapsedSections(new Set(sections.map((section) => section.kind).filter((key) => key !== openKey)));
  }, [sections, activeSectionKind]);

  useEffect(() => {
    if (sidebarGroupBy !== "kind") {
      if (collapsedAssetSubgroupKeys.size > 0) setCollapsedAssetSubgroupKeys(new Set());
      initializedAssetSubgroupsRef.current = false;
      return;
    }
    const assetSection = sections.find((section) => section.kind === "资产");
    if (!assetSection?.subgroups?.length) {
      if (collapsedAssetSubgroupKeys.size > 0) setCollapsedAssetSubgroupKeys(new Set());
      initializedAssetSubgroupsRef.current = false;
      return;
    }
    if (!initializedAssetSubgroupsRef.current) {
      initializedAssetSubgroupsRef.current = true;
      const openKey = activeAssetSubgroupKey || assetSection.subgroups[0]?.key || "";
      setCollapsedAssetSubgroupKeys(new Set(assetSection.subgroups.map((subgroup) => subgroup.key).filter((key) => key !== openKey)));
      return;
    }
    const subgroupKeys = new Set(assetSection.subgroups.map((subgroup) => subgroup.key));
    let changed = false;
    const nextCollapsed = new Set<string>();
    for (const key of collapsedAssetSubgroupKeys) {
      if (subgroupKeys.has(key)) nextCollapsed.add(key);
      else changed = true;
    }
    if (changed) setCollapsedAssetSubgroupKeys(nextCollapsed);
  }, [sections, activeAssetSubgroupKey, collapsedAssetSubgroupKeys, sidebarGroupBy]);

  function toggleAssetSubgroup(key: string) {
    setCollapsedAssetSubgroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function focusAssetSubgroup(key: string, allKeys: string[]) {
    setCollapsedAssetSubgroupKeys((prev) => {
      if (!prev.has(key)) {
        const next = new Set(prev);
        next.add(key);
        return next;
      }
      return new Set(allKeys.filter((groupKey) => groupKey !== key));
    });
  }

  if (sidebarCollapsed) {
    return (
      <aside className="flex h-screen w-16 shrink-0 flex-col items-center overflow-hidden border-r border-slate-200/80 bg-white/84 px-2 py-3 backdrop-blur-xl transition-[width] duration-200">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <div ref={footerAvatarRef}>
            <button
              onClick={() => setSwitcherOpen(!switcherOpen)}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 transition-colors hover:bg-blue-100"
              title={`${user?.name || "未登录"} · ${householdDisplayName}`}
            >
              <Leaf size={18} />
            </button>
          </div>
          <button
            onClick={toggleSidebarCollapsed}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
            title="展开左侧栏"
          >
            <PanelLeftOpen size={18} />
          </button>
          <LedgerSwitcher
            current={household}
            anchorRef={footerAvatarRef}
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
          />
        </div>

        <nav className="mt-5 flex min-h-0 flex-1 flex-col items-center gap-1">
          <Link href="/overview" className={collapsedNavCls(pathname.startsWith("/overview"))} title="概览">
            <LayoutDashboard size={18} />
          </Link>
          <Link href="/accounts" className={collapsedNavCls(pathname.startsWith("/accounts") || pathname === "/")} title="账户">
            <Landmark size={18} />
          </Link>
          <Link
            href="/accounts?tab=credit"
            className={collapsedNavCls(pathname.startsWith("/accounts") && searchParams.get("tab") === "credit")}
            title="信用卡"
          >
            <CreditCard size={18} />
          </Link>
          <Link href="/investments" className={collapsedNavCls(pathname.startsWith("/investments") || pathname.startsWith("/invest") || pathname.startsWith("/funds"))} title="投资">
            <BarChart3 size={18} />
          </Link>
          <Link href="/liabilities" className={collapsedNavCls(pathname.startsWith("/liabilities"))} title="往来款">
            <Landmark size={18} />
          </Link>
        </nav>

        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-slate-200 pt-3">
          <Link href="/regular-invest" className={collapsedNavCls(pathname.startsWith("/regular-invest"))} title="计划任务">
            <CalendarClock size={18} />
          </Link>
          <button
            onClick={() => setInitOpen(true)}
            className={collapsedNavCls(false)}
            title="初始数据"
          >
            <Plus size={18} />
          </button>
          <Link href="/settings" className={collapsedNavCls(pathname.startsWith("/settings"))} title="账户管理">
            <Users size={18} />
          </Link>
        </div>

        <NewLedgerSetupCheck />
        <InitModal open={initOpen} onOpenChange={setInitOpen} />
        <DailyTaskCheck />
      </aside>
    );
  }

  return (
    <aside className="flex h-screen w-72 shrink-0 flex-col overflow-hidden border-r border-slate-200/80 bg-white/84 backdrop-blur-xl transition-[width] duration-200">
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
          <button
            onClick={(e) => { e.stopPropagation(); toggleSidebarCollapsed(); }}
            className="rounded-md p-1 text-slate-300 transition-colors hover:bg-slate-50 hover:text-slate-600"
            title="收起左侧栏"
          >
            <PanelLeftClose size={18} />
          </button>
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
          </nav>
        </div>

        <div className="mt-5 mb-3 flex shrink-0 items-center justify-between px-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={cycleOwnerFilter}
              className="truncate text-[11px] font-medium tracking-[0.08em] text-slate-400 transition-colors hover:text-slate-600"
              title={`切换所有人筛选：${selectedOwnerFilter || "全部"}`}
            >
              {`账户·${selectedOwnerFilter || "全部"}`}
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button type="button"
              onClick={cycleSidebarGroupBy}
              className={`rounded-md p-1 transition-colors ${sidebarGroupBy === "institution" ? "bg-slate-100 text-slate-600" : "text-slate-300 hover:bg-slate-50 hover:text-slate-500"}`}
              title={`切换分组：${sidebarGroupBy === "kind" ? "账户类别" : "机构"}`}
            >
              <Repeat size={14} />
            </button>
            <button onClick={toggleHideZero} className={`rounded-md p-1.5 text-xs transition-colors ${hideZero ? "bg-slate-100 text-slate-600" : "text-slate-300 hover:bg-slate-50 hover:text-slate-500"}`} title="隐藏余额为0的账户">
              <EyeOff size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-scroll custom-scrollbar [scrollbar-gutter:stable]">
          <nav className="space-y-1">
            <div className="space-y-2">
              {sections.map((sec) => {
                const collapsed = collapsedSections.has(sec.kind);
                const SectionIcon = SECTION_ICON[sec.label] ?? Landmark;
                return (
                  <div key={sec.kind}>
                    <div
                      className="sticky top-0 z-10 flex w-full items-center rounded-lg bg-white/92 px-3 py-2 backdrop-blur transition-all duration-200 hover:bg-white group"
                    >
                      <button
                        type="button"
                        onClick={() => openOnlySection(sec.kind)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold text-slate-800"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <SectionIcon size={14} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{sec.label}</span>
                        <span className={`text-xs font-semibold tabular-nums ${sectionBalanceCls(sec.kind, sec.total)}`}>
                          {formatMoney(displaySectionTotal(sec.kind, sec.total))}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSection(sec.kind)}
                        className="ml-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 transition-all duration-200 hover:bg-white hover:text-slate-500"
                        title={collapsed ? "展开此分组" : "收起此分组"}
                      >
                        <ChevronDown
                          size={18}
                          className={collapsed ? "-rotate-90" : ""}
                        />
                      </button>
                    </div>
                    {!collapsed && (
                      <div className="mt-1 space-y-1">
                        {(sec.subgroups?.length ? sec.subgroups : [{ key: `${sec.kind}_default`, label: "", accounts: sec.accounts, total: sec.total }]).map((group) => (
                          <div key={group.key} className="space-y-1">
                            {group.label ? (
                              <button
                                type="button"
                                onClick={() => focusAssetSubgroup(group.key, sec.subgroups?.map((subgroup) => subgroup.key) ?? [group.key])}
                                className="flex w-full items-center gap-1.5 rounded-md px-3 py-0.5 text-left hover:bg-slate-50/80"
                              >
                                <div className="text-[10px] font-medium text-slate-400">{group.label}</div>
                                <div className="h-px flex-1 bg-slate-100" />
                                <div className={`text-[10px] font-medium tabular-nums ${sectionBalanceCls(sec.kind, group.total)}`}>
                                  {formatMoney(displaySectionTotal(sec.kind, group.total))}
                                </div>
                                <ChevronDown
                                  size={14}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleAssetSubgroup(group.key);
                                  }}
                                  className={`shrink-0 text-slate-300 transition-transform ${sec.kind === "资产" && collapsedAssetSubgroupKeys.has(group.key) ? "-rotate-90" : ""}`}
                                />
                              </button>
                            ) : null}
                            {(sec.kind !== "资产" || !group.label || !collapsedAssetSubgroupKeys.has(group.key)) && group.accounts.map((it, index) => {
                              const active = pathname === "/" && (
                                it.kind === "loan_summary"
                                  ? selectedView === "debt"
                                  : (it.id ? selectedAccountId === it.id : !selectedAccountId && selectedAccount === it.name)
                              );
                              const href = (() => {
                                if (it.kind === "loan_summary") return "/?view=debt";
                                const q = new URLSearchParams();
                                if (it.id) q.set("accountId", it.id);
                                else q.set("account", it.name);
                                const view = it.kind === "investment"
                                  ? (it.investProductType === "money" ? "investmoney" : "investfund")
                                  : it.kind === "deposit"
                                    ? "deposit"
                                    : it.kind === "insurance"
                                      ? "insurance"
                                      : (it.kind === "bank_credit" || it.kind === "loan" ? "bill" : "detail");
                                q.set("view", view);
                                return `/?${q.toString()}`;
                              })();
                              return (
                                <Link
                                  key={`${group.key}:${it.id}:${it.name}`}
                                  href={href}
                                  prefetch={false}
                                  scroll={false}
                                  className={`${accountLinkCls(active)} ${group.label ? "ml-3 pl-2.5 border-l border-slate-100 rounded-l-none" : ""} ${index > 0 ? "border-t border-slate-100/90" : ""}`}
                                >
                                  <span className="min-w-0 flex-1 pr-2">
                                    <span className="text-fade-right block min-w-0">
                                    {sidebarGroupBy === "institution"
                                      ? it.kind === "insurance"
                                        ? (it.shortLabel || it.label)
                                        : `${KIND_INLINE_LABEL.get(it.kind) ?? "账户"}·${it.shortLabel || it.label}`
                                      : it.label}
                                    </span>
                                  </span>
                                  <span className={`shrink-0 pl-2 text-[11px] font-medium tabular-nums ${itemBalanceCls(it)}`}>{formatMoney(displayBalance(it))}</span>
                                </Link>
                              );
                            })}
                          </div>
                        ))}
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
            <span className="font-medium">计划任务</span>
          </Link>
          <button
            onClick={() => setInitOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-600 transition-all duration-200 hover:bg-white hover:text-slate-900"
          >
            <Plus size={18} />
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
