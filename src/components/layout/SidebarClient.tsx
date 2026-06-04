"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LayoutDashboard, TrendingUp, Users, Settings, ArrowUpDown, CalendarClock } from "lucide-react";
import { LedgerSwitcher } from "../LedgerSwitcher";
import { useState, useEffect, useMemo } from "react";
import { formatMoney } from "@/lib/format";

function getColorScheme(): "red_up_green_down" | "green_up_red_down" {
  if (typeof document === "undefined") return "red_up_green_down";
  const match = document.cookie.match(/colorScheme=([^;]+)/);
  return (match?.[1] ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
}

function pnlCls(n: number): string {
  const isRedUp = getColorScheme() === "red_up_green_down";
  if (n > 0) return isRedUp ? "text-red-500" : "text-emerald-700";
  if (n < 0) return isRedUp ? "text-emerald-700" : "text-red-500";
  return "text-slate-600";
}

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

const KIND_LABELS: Record<string, string> = {
  cash: "现金", bank_debit: "借记卡", bank_credit: "信用卡", ewallet: "电子钱包",
  investment: "基金/投资", investment_fund: "开放式基金", investment_money: "货币基金",
  investment_wealth: "普通理财", loan: "贷款", other: "其他",
};

type GroupSection = { kind: string; label: string; accounts: AccountItem[]; totalBalance: number; totalCount: number };

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarClient({ items, household }: { items: AccountItem[]; household: { id: string; name: string } | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedAccount = (searchParams.get("account") ?? "").trim();
  const selectedAccountId = (searchParams.get("accountId") ?? "").trim();

  const [groupByInstitution, setGroupByInstitution] = useState(false);
  useEffect(() => { setGroupByInstitution(localStorage.getItem("sidebar_group_by") === "institution"); }, []);
  function toggleGroupBy() {
    const next = !groupByInstitution;
    setGroupByInstitution(next);
    localStorage.setItem("sidebar_group_by", next ? "institution" : "kind");
  }

  const navLink = (href: string) =>
    `flex items-center px-2.5 py-1.5 text-[13px] font-medium rounded-md border transition ${
      isActivePath(pathname, href)
        ? "bg-blue-50 text-blue-700 border-blue-100"
        : "text-slate-700 hover:bg-white hover:shadow-sm hover:border-slate-200 border-transparent"
    }`;

  const accountLink = (active: boolean) =>
    `flex items-center justify-between px-2 py-1 text-[13px] rounded-md border transition ${
      active
        ? "bg-blue-50 text-blue-700 border-blue-100 shadow-sm"
        : "text-slate-700 border-transparent hover:bg-white hover:shadow-sm hover:border-slate-200"
    }`;

  const KIND_ORDER = ["cash", "ewallet", "bank_debit", "bank_credit", "investment_fund", "investment_money", "investment_wealth", "investment", "loan", "other"];
  const grouped: Record<string, AccountItem[]> = {};
  for (const it of items) {
    let k = it.kind || "other";
    if (k === "investment" && it.investProductType) k = `investment_${it.investProductType}`;
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(it);
  }
  const sections: GroupSection[] = KIND_ORDER
    .filter((k) => grouped[k]?.length)
    .map((k) => ({
      kind: k, label: KIND_LABELS[k] ?? KIND_LABELS.other, accounts: grouped[k]!,
      totalBalance: grouped[k]!.reduce((s, a) => s + a.balance, 0),
      totalCount: grouped[k]!.reduce((s, a) => s + a.count, 0),
    }));

  const instGrouped: Record<string, AccountItem[]> = {};
  for (const it of items) {
    const instKey = it.institution || "未指定机构";
    if (!instGrouped[instKey]) instGrouped[instKey] = [];
    instGrouped[instKey].push(it);
  }
  const instSections: GroupSection[] = Object.entries(instGrouped)
    .sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
    .map(([inst, accounts]) => ({
      kind: inst, label: inst, accounts,
      totalBalance: accounts.reduce((s, a) => s + a.balance, 0),
      totalCount: accounts.reduce((s, a) => s + a.count, 0),
    }));

  const activeSections = groupByInstitution ? instSections : sections;

  return (
    <div className="w-72 bg-slate-50 border-r border-slate-200 h-screen flex flex-col">
      {/* Fixed top */}
      <div className="shrink-0">
        <div className="h-12 flex items-center px-3 border-b border-slate-200">
          <LedgerSwitcher current={household} />
          <span className="ml-2 font-semibold text-slate-800">{household?.name ?? "WiseMe"}</span>
        </div>

        <nav className="p-2 space-y-0.5 border-b border-slate-100">
          <Link href="/invest" className={navLink("/invest")}><TrendingUp className="w-3.5 h-3.5 mr-2 text-slate-500"/>投资</Link>
          <Link href="/regular-invest" className={navLink("/regular-invest")}><CalendarClock className="w-3.5 h-3.5 mr-2 text-slate-500"/>定投计划</Link>
          <Link href="/batch-import" className={navLink("/batch-import")}><LayoutDashboard className="w-3.5 h-3.5 mr-2 text-slate-500"/>批量导入</Link>
          <Link href="/accounts" className={navLink("/accounts")}><Users className="w-3.5 h-3.5 mr-2 text-slate-500"/>账户中心</Link>
        </nav>

        <div className="px-3 py-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500">账户</span>
          <button type="button" onClick={toggleGroupBy} title={groupByInstitution ? "按类型排列" : "按机构排列"} className={`h-5 w-5 flex items-center justify-center rounded border ${groupByInstitution ? "bg-blue-50 text-blue-600 border-blue-200" : "text-slate-400 border-slate-200 hover:bg-slate-100"}`}>
            <ArrowUpDown className="w-3 h-3"/>
          </button>
        </div>
      </div>

      {/* Scrollable account list */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
        {activeSections.map((sec) => (
          <div key={sec.kind}>
            <div className="flex items-center justify-between px-2 py-1 bg-slate-200/50 rounded">
              <span className="text-xs font-medium text-slate-500">{sec.label}</span>
              <span className={`text-xs tabular-nums font-medium ${pnlCls(sec.totalBalance)}`}>{formatMoney(sec.totalBalance)}</span>
            </div>
            {sec.accounts.map((it) => (
              <Link
                key={`${it.id ?? ""}:${it.name}`}
                href={(() => {
                  const q = new URLSearchParams();
                  if (it.id) q.set("accountId", it.id);
                  else q.set("account", it.name);
                  const defaultView = it.kind === "investment"
                    ? it.investProductType === "fund" ? "investfund"
                    : it.investProductType === "money" ? "investmoney"
                    : "investfund"
                    : it.kind === "bank_credit" || it.kind === "loan" ? "bill"
                    : "detail";
                  q.set("view", defaultView);
                  if (searchParams.get("hideZeroBills") === "1") q.set("hideZeroBills", "1");
                  if (searchParams.get("hideSettledBills") === "1") q.set("hideSettledBills", "1");
                  return `/?${q.toString()}`;
                })()}
                className={accountLink(pathname === "/" && (it.id ? selectedAccountId === it.id : !selectedAccountId && selectedAccount === it.name))}
              >
                <span className="truncate pr-2">{it.label}</span>
                <span className={`tabular-nums ${pnlCls(it.balance)}`}>{formatMoney(it.balance)}</span>
              </Link>
            ))}
          </div>
        ))}
        {!activeSections.length && <div className="px-2 py-2 text-xs text-slate-400">暂无数据</div>}
      </div>

      {/* Fixed bottom */}
      <div className="shrink-0 px-3 py-2 border-t border-slate-200">
        <Link href="/settings" className={navLink("/settings")}>
          <Settings className="w-3.5 h-3.5 mr-2 text-slate-500"/>
          系统设置
        </Link>
      </div>
    </div>
  );
}
