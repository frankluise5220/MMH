import type { AccountKind } from "@prisma/client";

/* ---- Kind label mapping ---- */

export function kindLabel(k: string): string {
  const m: Record<string, string> = {
    bank_credit: "信用卡",
    bank_debit: "借记卡",
    ewallet: "电子钱包",
    cash: "现金",
    investment: "投资",
    loan: "贷款",
    other: "其他",
    bank_savings: "储蓄卡",
  };
  return m[k] || k;
}

/* ---- Kind color (Tailwind badge classes) ---- */

export function kindColor(k: string): string {
  if (k === "bank_credit") return "bg-amber-50 text-amber-700 border-amber-200";
  if (k === "bank_debit") return "bg-slate-50 text-slate-700 border-slate-200";
  if (k === "ewallet") return "bg-blue-50 text-blue-700 border-blue-200";
  if (k === "cash") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (k === "investment") return "bg-purple-50 text-purple-700 border-purple-200";
  if (k === "loan") return "bg-red-50 text-red-700 border-red-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

/* ---- Kind color (CSS hex) for SmartSelect option tinting ---- */

export function kindHex(k: string): string {
  if (k === "bank_credit") return "#F59E0B";
  if (k === "bank_debit") return "#94A3B8";
  if (k === "ewallet") return "#3B82F6";
  if (k === "cash") return "#10B981";
  if (k === "investment") return "#8B5CF6";
  if (k === "loan") return "#EF4444";
  return "#64748B";
}

/* ---- Kind to lucide icon name (string, resolved by SmartSelect) ---- */

export function kindIconName(k: string): string {
  if (k === "bank_credit") return "credit-card";
  if (k === "bank_debit") return "landmark";
  if (k === "ewallet") return "wallet";
  if (k === "cash") return "banknote";
  if (k === "investment") return "piggy-bank";
  if (k === "loan") return "building-2";
  return "building-2";
}

/* ---- Institution type label mapping ---- */

export function institutionTypeLabel(t: string | null): string {
  const m: Record<string, string> = {
    bank: "银行",
    brokerage: "证券",
    payment: "第三方支付",
    ewallet: "钱包",
    other: "其他",
  };
  return m[t ?? "other"] ?? t ?? "其他";
}

/* ---- Institution type to lucide icon name (string, resolved by SmartSelect) ---- */

export function institutionTypeIconName(t: string | null): string {
  if (t === "bank") return "landmark";
  if (t === "brokerage") return "building-2";
  if (t === "payment") return "credit-card";
  if (t === "ewallet") return "wallet";
  return "building-2";
}

/* ---- Canonical kind display order ---- */

export const kindOrder: AccountKind[] = [
  "cash",
  "bank_debit",
  "bank_credit",
  "ewallet",
  "investment",
  "loan",
  "other",
];
