"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen, Building2, Database, Handshake, KeyRound, Mail, Palette, Settings,
  Tag, Users, Cpu, ChevronRight, Key, Globe, Hash,
  Loader2, RefreshCw, Shield,
} from "lucide-react";

const navItems = [
  { href: "/settings/ledgers", label: "账簿", icon: BookOpen },
  { href: "/settings/accounts", label: "账户", icon: Users },
  { href: "/settings/institutions", label: "机构", icon: Building2 },
  { href: "/settings/counterparties", label: "往来对象", icon: Handshake },
  { href: "/settings/insurance-products", label: "保险产品", icon: Shield },
  { href: "/settings/categories", label: "收支类别", icon: Tag },
  { href: "/settings/tags", label: "标签", icon: Hash },
  { href: "/settings/email", label: "邮箱账户", icon: Mail },
  { href: "/settings/password-recovery", label: "密码找回", icon: KeyRound },
  { href: "/settings/display", label: "显示", icon: Palette },
  { href: "/settings/ai", label: "AI 模型", icon: Cpu },
  { href: "/settings/users", label: "用户管理", icon: Users },
  { href: "/settings/api", label: "外接 API", icon: Key },
  { href: "/settings/fund-api", label: "基金 API", icon: Globe },
  { href: "/settings/database", label: "数据库", icon: Database },
  { href: "/settings/system-update", label: "系统更新", icon: RefreshCw },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* 左侧导航 */}
      <nav className="w-44 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="h-12 flex items-center px-4 border-b border-slate-100 shrink-0">
          <Settings className="w-4 h-4 text-slate-500 mr-2" />
          <span className="font-semibold text-sm text-slate-800">系统设置</span>
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
                <span className="truncate">{item.label}</span>
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
