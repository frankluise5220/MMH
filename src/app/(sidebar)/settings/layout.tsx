"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/settings/accounts", label: "账户" },
  { href: "/settings/email", label: "邮箱导入" },
  { href: "/settings/institutions", label: "机构" },
  { href: "/settings/categories", label: "收支类别" },
  { href: "/settings/display", label: "显示" },
  { href: "/settings/database", label: "数据库" },
  { href: "/settings/ai", label: "AI Provider" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-slate-50">
      <header className="shrink-0 bg-gradient-to-b from-slate-100 to-slate-50">
        <div className="h-12 flex items-center px-4 border-b border-slate-200">
          <div className="font-semibold text-slate-800">系统设置</div>
        </div>
        <div className="h-10 px-4 flex items-center gap-2 bg-slate-50 border-b border-slate-200">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`h-7 px-3 rounded-md text-sm flex items-center ${
                pathname === item.href
                  ? "bg-blue-100 text-blue-700 border border-blue-200"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </header>
      <div className="flex-1 overflow-auto overflow-x-hidden p-4">
        {children}
      </div>
    </div>
  );
}