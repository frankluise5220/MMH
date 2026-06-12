"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard,
  Users,
  Settings,
  CalendarClock,
  Leaf,
  ChevronDown,
  Circle,
  ArrowUpDown
} from "lucide-react";
import { LedgerSwitcher } from "../LedgerSwitcher";
import { NewLedgerSetupCheck } from "../NewLedgerSetupCheck";
import { formatMoney } from "@/lib/format";

type AccountItem = {
  id?: string | null;
  name: string;
  label: string;
  balance: number;
  count: number;
  kind: string;
  institution?: string;
  investProductType?: string;
};

const ASSET_KINDS = ["cash", "bank_debit", "ewallet"];
const INVEST_KINDS = ["investment", "investment_fund", "investment_money", "investment_wealth"];
const LIABILITY_KINDS = ["bank_credit", "loan", "other"];

export function SidebarClient({ items, household, isRedUp }: { items: AccountItem[]; household: { id: string; name: string } | null; isRedUp: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccountId = (searchParams.get("accountId") ?? "").trim();
  const selectedAccount = (searchParams.get("account") ?? "").trim();

  const [groupByInstitution, setGroupByInstitution] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const footerAvatarRef = useRef<HTMLDivElement>(null);

  async function handleLogout() {
    if (!window.confirm("确认退出当前账号吗？")) return;
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
      window.location.href = "/login";
    } catch {
      window.alert("退出失败");
    }
  }

  useEffect(() => { setGroupByInstitution(localStorage.getItem("sidebar_group_by") === "institution"); }, []);

  function toggleGroupBy() {
    const next = !groupByInstitution;
    setGroupByInstitution(next);
    localStorage.setItem("sidebar_group_by", next ? "institution" : "kind");
  }

  function toggleSection(key: string) {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const navItemCls = (href: string) => 
    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300 ${
      (href === "/" ? pathname === "/" : pathname.startsWith(href))
        ? "sidebar-item-active"
        : "text-foreground/60 hover:bg-white/50 hover:text-foreground"
    }`;

  const accountLinkCls = (active: boolean) =>
    `flex items-center justify-between px-4 py-2.5 text-sm font-medium hover:bg-white/50 rounded-xl group transition-all duration-200 ${
      active ? "bg-white/60 text-foreground font-semibold shadow-sm" : "text-foreground/80"
    }`;

  const balCls = (n: number) => n > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : n < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-foreground/40";

  // Restore and Refine Grouping logic
  const sections = useMemo(() => {
    if (groupByInstitution) {
      const instGrouped: Record<string, AccountItem[]> = {};
      for (const it of items) {
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
        const filtered = items.filter(it => g.kinds.includes(it.kind) || (g.label === "投资" && it.kind.startsWith("investment_")));
        return {
          kind: g.label, label: g.label, accounts: filtered,
          total: filtered.reduce((s, a) => s + a.balance, 0)
        };
      }).filter(s => s.accounts.length > 0);
    }
  }, [items, groupByInstitution]);

  return (
    <aside className="w-72 bg-background border-r border-foreground/5 flex flex-col shrink-0 h-screen overflow-hidden">
      {/* Fixed Header */}
      <div className="px-8 pt-8 pb-4 shrink-0">
        <div
          ref={footerAvatarRef}
          onClick={() => setSwitcherOpen(!switcherOpen)}
          className="flex items-center gap-3 rounded-2xl cursor-pointer hover:bg-white/30 transition-colors group"
        >
          <div className="w-10 h-10 bg-foreground rounded-xl flex items-center justify-center shadow-lg shadow-foreground/10 text-accent-green shrink-0">
            <Leaf size={20} />
          </div>
          <div className="flex-1 min-w-0 text-foreground">
            <p className="font-heading text-2xl font-bold tracking-tight text-foreground leading-none">Calm.</p>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-[10px] opacity-40 uppercase font-bold tracking-widest truncate">{household?.name || "Guest"}</p>
              <button 
                onClick={(e) => { e.stopPropagation(); handleLogout(); }}
                className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
                title="退出当前用户"
              >
                退出
              </button>
            </div>
          </div>
          <ChevronDown size={16} className={`text-foreground/20 group-hover:text-foreground/50 transition-all duration-200 ${switcherOpen ? "rotate-180" : ""}`} />
          <Link href="/settings" onClick={(e) => e.stopPropagation()} className="text-foreground/20 hover:text-foreground p-1 transition-colors">
            <Settings size={20} />
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
      <div className="px-8 pb-4 flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="shrink-0">
          <nav className="space-y-1">
            <Link href="/" className={navItemCls("/")}>
              <LayoutDashboard size={18} />
              <span className="font-ui font-semibold text-sm">概览</span>
            </Link>
          </nav>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <nav className="space-y-1">
            <div className="mt-6 flex items-center justify-between px-4 mb-4">
              <span className="text-[10px] font-bold text-foreground/30 uppercase tracking-[0.2em]">账户</span>
              <button onClick={toggleGroupBy} className="text-foreground/20 hover:text-foreground p-1 transition-colors" title="Toggle Grouping">
                <ArrowUpDown size={14} />
              </button>
            </div>

            <div className="space-y-4">
              {sections.map((sec) => {
                const collapsed = collapsedSections.has(sec.kind);
                return (
                  <div key={sec.kind}>
                    <div
                      className="sticky top-0 z-10 flex items-center px-4 py-2.5 w-full rounded-xl transition-all duration-300 hover:bg-white/60 group"
                      style={{ background: "rgba(255,255,255,0.7)" }}
                    >
                      <Link
                        href={sec.label === "资产" ? "/assets" : sec.label === "投资" ? "/investments" : "/liabilities"}
                        className="flex items-center text-base font-bold text-foreground"
                      >
                        <span className="mr-2">
                          {sec.label === "资产" && "💰"}
                          {sec.label === "投资" && "📈"}
                          {sec.label === "负债" && "💳"}
                        </span>
                        <span>{sec.label}</span>
                      </Link>
                      <span className="flex-1" />
                      <button
                        onClick={() => toggleSection(sec.kind)}
                        className={`text-xs tabular-nums font-semibold mr-1 ${balCls(sec.total)}`}
                      >
                        {formatMoney(sec.total)}
                      </button>
                      <button
                        onClick={() => toggleSection(sec.kind)}
                        className="text-foreground/30 group-hover:text-foreground/50 transition-all duration-200"
                      >
                        <ChevronDown
                          size={14}
                          className={collapsed ? "-rotate-90" : ""}
                        />
                      </button>
                    </div>
                    {!collapsed && (
                      <div className="space-y-1">
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
                              <span className="truncate pr-2">{it.label}</span>
                              <span className={`text-[10px] tabular-nums font-medium ${balCls(it.balance)}`}>{formatMoney(it.balance)}</span>
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

        <div className="mt-4 border-t border-foreground/5 pt-4 space-y-1 shrink-0">
          <Link href="/regular-invest" className={navItemCls("/regular-invest")}>
            <CalendarClock size={18} />
            <span className="font-ui font-semibold text-sm">定投</span>
          </Link>
          <Link href="/accounts" className={navItemCls("/accounts")}>
            <Users size={18} />
            <span className="font-ui font-semibold text-sm">账户管理</span>
          </Link>
        </div>
      </div>

      <NewLedgerSetupCheck />
    </aside>
  );
}
