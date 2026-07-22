"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
  Home,
  Landmark,
  Plus,
  RefreshCw,
  Settings,
  TrendingUp,
} from "lucide-react";

import { MmhLogo } from "@/components/MmhLogo";

const NAV_ITEMS = [
  { href: "/overview", label: "总览", icon: Home },
  { href: "/accounts", label: "账户", icon: Landmark },
  { href: "/investments", label: "投资", icon: TrendingUp },
  { href: "/settings", label: "我的", icon: Settings },
] as const;

function openQuickEntry() {
  window.dispatchEvent(
    new CustomEvent("mmh:create-transaction:open", {
      detail: {
        requestId: `mobile-${Date.now()}`,
        source: "launcher",
        item: { type: "expense" },
      },
    }),
  );
}

export function MobileNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const title = useMemo(() => {
    if (pathname.startsWith("/overview")) return "总览";
    if (pathname.startsWith("/accounts") || pathname === "/") return pathname === "/" ? "账户明细" : "资金账户";
    if (pathname.startsWith("/invest")) return "投资";
    if (pathname.startsWith("/reports") || pathname.startsWith("/statistics")) return "统计";
    if (pathname.startsWith("/liabilities")) return "往来款";
    if (pathname.startsWith("/regular-invest")) return "计划任务";
    if (pathname.startsWith("/settings")) return "我的";
    return "MoneyMoneyHome";
  }, [pathname]);

  useEffect(() => {
    if (pathname !== "/" || searchParams.get("quickEntry") !== "1") return;
    const timer = window.setTimeout(() => {
      openQuickEntry();
      const url = new URL(window.location.href);
      url.searchParams.delete("quickEntry");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [pathname, searchParams]);

  const isActive = (href: string) => {
    if (href === "/investments") return pathname.startsWith("/invest") || pathname.startsWith("/funds");
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end border-b border-slate-200 bg-slate-50/96 px-4 pb-2 backdrop-blur md:hidden">
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2.5">
          <MmhLogo size={28} />
          <div className="min-w-0">
            <div className="truncate text-[11px] font-medium text-slate-400">MoneyMoneyHome</div>
            <div className="truncate text-sm font-semibold text-slate-900">{title}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="flex h-10 w-10 shrink-0 items-center justify-center text-slate-500"
          aria-label="刷新"
        >
          <RefreshCw size={19} />
        </button>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-50 h-[calc(5.75rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="absolute inset-x-0 bottom-0 grid h-[calc(4.5rem+env(safe-area-inset-bottom))] grid-cols-[1fr_1fr_0.72fr_1fr_1fr] border-t border-slate-200 bg-white/97 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <MobileNavLink item={NAV_ITEMS[0]} active={isActive(NAV_ITEMS[0].href)} />
          <MobileNavLink item={NAV_ITEMS[1]} active={isActive(NAV_ITEMS[1].href) || pathname === "/"} />
          <span aria-hidden="true" />
          <MobileNavLink item={NAV_ITEMS[2]} active={isActive(NAV_ITEMS[2].href)} />
          <MobileNavLink item={NAV_ITEMS[3]} active={isActive(NAV_ITEMS[3].href)} />
        </div>
        <Link
          href="/?quickEntry=1"
          className="absolute left-1/2 top-0 flex h-[72px] w-[72px] -translate-x-1/2 items-center justify-center rounded-full bg-white shadow-[0_4px_18px_rgba(15,23,42,0.18)]"
          aria-label="记一笔"
        >
          <span className="flex h-[58px] w-[58px] items-center justify-center rounded-full bg-indigo-600 text-white shadow-[0_8px_20px_rgba(79,70,229,0.32)]">
            <Plus size={28} />
          </span>
        </Link>
      </nav>
    </>
  );
}

function MobileNavLink({ item, active }: { item: (typeof NAV_ITEMS)[number]; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`flex min-w-0 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-indigo-700" : "text-slate-500"}`}
    >
      <Icon size={21} />
      <span>{item.label}</span>
    </Link>
  );
}
