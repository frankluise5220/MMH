"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useI18n } from "@/lib/i18n";

const BASIC_DATA_TABS = [
  { href: "/settings/family-members", labelKey: "settings.familyMembers" },
  { href: "/settings/counterparties", labelKey: "settings.counterparties" },
  { href: "/settings/institutions", labelKey: "settings.institutions" },
  { href: "/settings/tags", labelKey: "settings.tags" },
] as const;

function BasicDataTabs() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav
      className="flex w-full items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm md:w-auto md:flex-wrap md:rounded-lg"
      aria-label={t("settings.basicDataSubmenu")}
    >
      {BASIC_DATA_TABS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            className={[
              // 手机上四个页签平分整行、44px 高；桌面回到原来的 h-8 小页签。
              "inline-flex h-11 flex-1 items-center justify-center whitespace-nowrap rounded-lg px-2 text-[13px] font-medium transition-colors md:h-8 md:flex-none md:justify-start md:rounded-md md:px-3 md:text-xs",
              active ? "bg-blue-50 text-blue-700 shadow-sm" : "text-slate-500 active:bg-slate-50 md:hover:bg-slate-50 md:hover:text-slate-800",
            ].join(" ")}
          >
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 基本资料四个子页的公共表头：只有页签。
 *
 * 原来的「导出模板 / 导入 EXCEL」已整体下线（2026-10-27）：这几张表在手机上要能直接看、
 * 直接改，走 Excel 模板那条路既覆盖不了手机端，导入结果还得回头核对，实际用不上。
 * 需要时再单独设计批量导入，不要把它挂回这个表头。
 */
export function BasicDataSubmenuHeader({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
      <BasicDataTabs />
      {children ? (
        <div className="flex flex-wrap items-center justify-end gap-2 md:ml-auto">{children}</div>
      ) : null}
    </div>
  );
}
