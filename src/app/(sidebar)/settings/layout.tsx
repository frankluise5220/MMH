"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen, Building2, Database, Handshake, HeartHandshake, KeyRound, Mail, Palette, Settings,
  Tag, Users, Cpu, ChevronRight, Key, Globe, Hash,
  Loader2, RefreshCw, Shield,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";

const navItems = [
  { href: "/settings/ledgers", labelKey: "settings.ledgers", icon: BookOpen },
  { href: "/settings/accounts", labelKey: "settings.accounts", icon: Users },
  { href: "/settings/institutions", labelKey: "settings.institutions", icon: Building2 },
  { href: "/settings/counterparties", labelKey: "settings.counterparties", icon: Handshake },
  { href: "/settings/family-members", labelKey: "settings.familyMembers", icon: HeartHandshake },
  { href: "/settings/insurance-products", labelKey: "settings.insuranceProducts", icon: Shield },
  { href: "/settings/categories", labelKey: "settings.categories", icon: Tag },
  { href: "/settings/tags", labelKey: "settings.tags", icon: Hash },
  { href: "/settings/email", labelKey: "settings.emailAccounts", icon: Mail },
  { href: "/settings/password-recovery", labelKey: "settings.passwordRecovery", icon: KeyRound },
  { href: "/settings/display", labelKey: "settings.display", icon: Palette },
  { href: "/settings/ai", labelKey: "settings.aiModels", icon: Cpu },
  { href: "/settings/users", labelKey: "settings.users", icon: Users },
  { href: "/settings/api", labelKey: "settings.externalApi", icon: Key },
  { href: "/settings/fund-api", labelKey: "settings.fundApi", icon: Globe },
  { href: "/settings/database", labelKey: "settings.database", icon: Database },
  { href: "/settings/system-update", labelKey: "settings.systemUpdate", icon: RefreshCw },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* 左侧导航 */}
      <nav className="w-44 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="h-12 flex items-center px-4 border-b border-slate-100 shrink-0">
          <Settings className="w-4 h-4 text-slate-500 mr-2" />
          <span className="font-semibold text-sm text-slate-800">{t("nav.settings")}</span>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {navItems.map((item) => {
            const pending = pendingHref === item.href && pathname !== item.href;
            const active = pathname === item.href || pending;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                onClick={() => {
                  if (pathname !== item.href) setPendingHref(item.href);
                }}
                className={`h-9 px-3 rounded-md text-sm flex items-center gap-2.5 transition-colors ${
                  active
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? "text-blue-500" : "text-slate-400"}`} />
                <span className="truncate">{t(item.labelKey)}</span>
                {pending ? (
                  <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-blue-400" />
                ) : active ? (
                  <ChevronRight className="w-3.5 h-3.5 ml-auto text-blue-400" />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* 右侧内容 */}
      <div className="flex-1 min-w-0 overflow-auto bg-slate-50">
        <div className="p-4">
          {children}
        </div>
      </div>
    </div>
  );
}
