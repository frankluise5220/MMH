"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import {
  Home,
  Landmark,
  Plus,
  RefreshCw,
  Settings,
  TrendingUp,
  ReceiptText,
} from "lucide-react";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

function navItems(t: TFunc) {
  return [
    { href: "/overview", label: t("mobileNav.overview"), icon: Home },
    { href: "/accounts", label: t("nav.accounts"), icon: Landmark },
    { href: "/transactions", label: t("mobileTransactions.fallback"), icon: ReceiptText },
    { href: "/investments", label: t("nav.investments"), icon: TrendingUp },
  ] as const;
}

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
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navItemsList = navItems(t);
  const rootView = pathname === "/" ? searchParams.get("view") ?? "" : "";
  const isRootInvestmentView =
    rootView === "investfund" ||
    rootView === "investmoney" ||
    rootView === "investwealth" ||
    rootView === "investstock" ||
    rootView === "investproperty" ||
    rootView === "regularinvest";

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
    if (href === "/investments") return isRootInvestmentView || pathname.startsWith("/invest") || pathname.startsWith("/funds") || pathname.startsWith("/regular-invest");
    if (href === "/accounts") return pathname.startsWith("/accounts") || pathname.startsWith("/insurance") || pathname.startsWith("/liabilities");
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 flex h-[calc(2.5rem+env(safe-area-inset-top))] items-end border-b border-slate-200 bg-slate-50/96 px-3 pb-1 backdrop-blur md:hidden">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2.5">
          <span className="sr-only">{t("mobileNav.ariaLabel")}</span>
        </div>
        <div className="flex shrink-0 items-center">
          <Link href="/settings" className="flex h-9 w-9 items-center justify-center text-slate-500" aria-label={t("mobileNav.profile")}>
            <Settings size={19} />
          </Link>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="flex h-9 w-9 items-center justify-center text-slate-500"
            aria-label={t("settings.ledgers.refresh")}
          >
            <RefreshCw size={19} />
          </button>
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-50 h-[calc(5.75rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="absolute inset-x-0 bottom-0 grid h-[calc(4.5rem+env(safe-area-inset-bottom))] grid-cols-[1fr_1fr_0.72fr_1fr_1fr] border-t border-slate-200 bg-white/97 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <MobileNavLink item={navItemsList[0]} active={isActive(navItemsList[0].href)} />
          <MobileNavLink item={navItemsList[1]} active={isActive(navItemsList[1].href) || (pathname === "/" && !isRootInvestmentView)} />
          <span aria-hidden="true" />
          <MobileNavLink item={navItemsList[2]} active={isActive(navItemsList[2].href)} />
          <MobileNavLink item={navItemsList[3]} active={isActive(navItemsList[3].href)} />
        </div>
        {pathname === "/transactions" || pathname.startsWith("/accounts/") ? (
          <button
            type="button"
            onClick={openQuickEntry}
            className="absolute left-1/2 top-0 flex h-[72px] w-[72px] -translate-x-1/2 items-center justify-center rounded-full bg-white shadow-[0_4px_18px_rgba(15,23,42,0.18)]"
            aria-label={t("txForm.addEntry")}
          >
            <span className="flex h-[58px] w-[58px] items-center justify-center rounded-full bg-indigo-600 text-white shadow-[0_8px_20px_rgba(79,70,229,0.32)]">
              <Plus size={28} />
            </span>
          </button>
        ) : (
          <Link
            href="/?quickEntry=1"
            className="absolute left-1/2 top-0 flex h-[72px] w-[72px] -translate-x-1/2 items-center justify-center rounded-full bg-white shadow-[0_4px_18px_rgba(15,23,42,0.18)]"
            aria-label={t("txForm.addEntry")}
          >
            <span className="flex h-[58px] w-[58px] items-center justify-center rounded-full bg-indigo-600 text-white shadow-[0_8px_20px_rgba(79,70,229,0.32)]">
              <Plus size={28} />
            </span>
          </Link>
        )}
      </nav>
    </>
  );
}

function MobileNavLink({ item, active }: { item: ReturnType<typeof navItems>[number]; active: boolean }) {
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
