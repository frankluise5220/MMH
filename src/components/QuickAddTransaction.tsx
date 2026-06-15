"use client";

import { ChevronDown, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { clearStoredApiKeySession, getStoredApiKey } from "@/lib/client/apiKeySession";
import { SmartSelect } from "./SmartSelect";

type TxType = "expense" | "income" | "transfer" | "investment";

const LAST_TYPE_KEY = "wiseme_quick_add_type_v1";

function typeLabel(type: TxType) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "transfer") return "转账";
  return "投资";
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getLastType(): TxType {
  try {
    const v = localStorage.getItem(LAST_TYPE_KEY);
    if (v === "expense" || v === "income" || v === "transfer" || v === "investment") return v;
    return "expense";
  } catch {
    return "expense";
  }
}

function setLastType(type: TxType) {
  try {
    localStorage.setItem(LAST_TYPE_KEY, type);
  } catch {}
}

export function QuickAddTransaction({
  defaultAccountName,
  accounts,
}: {
  defaultAccountName?: string;
  accounts: Array<{ name: string; label: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [type, setType] = useState<TxType>(() => getLastType());
  const [date, setDate] = useState(() => todayYmd());
  const [amount, setAmount] = useState<string>("");
  const [account, setAccount] = useState<string>(() => (defaultAccountName ?? "").trim());
  const [fromAccount, setFromAccount] = useState<string>("");
  const [toAccount, setToAccount] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [remark, setRemark] = useState<string>("");

  const needsDouble = type === "transfer" || type === "investment";
  const selectedLabel = useMemo(() => typeLabel(type), [type]);

  const accountOptions = useMemo(() => {
    const base = accounts.slice();
    base.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    return base;
  }, [accounts]);

  const smartAccountOptions = useMemo(
    () => accountOptions.map(a => ({ id: a.name, label: a.label })),
    [accountOptions]
  );

  const txTypeOptions = useMemo(
    () => [
      { id: "expense", label: "支出" },
      { id: "income", label: "收入" },
      { id: "transfer", label: "转账" },
      { id: "investment", label: "投资" },
    ],
    []
  );

  function resetForOpen() {
    setType(getLastType());
    setDate(todayYmd());
    setAmount("");
    setAccount((defaultAccountName ?? "").trim());
    setFromAccount("");
    setToAccount("");
    setCategory("");
    setRemark("");
  }

  async function onSubmit() {
    if (submitting) return;

    const amountNum = amount.trim() ? Number(amount.trim().replace(/,/g, "")) : 0;
    const safeAmount = Number.isFinite(amountNum) ? Math.abs(amountNum) : 0;

    const accountName = account.trim();
    const fromName = fromAccount.trim();
    const toName = toAccount.trim();
    const categoryName = category.trim();
    const remarkText = remark.trim();
    const ymd = date.trim();

    if (!needsDouble) {
      if (!accountName && !(defaultAccountName ?? "").trim()) {
        window.alert("请选择账户（当前在“全部账户”，无法自动确定账户）");
        return;
      }
    } else {
      if (!fromName || !toName) {
        window.alert("请填写转出/转入账户");
        return;
      }
    }

    setSubmitting(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const key = getStoredApiKey();
      if (key) headers["X-Api-Key"] = key;

      const item = {
        rawText: "quick_add",
        type,
        date: ymd || undefined,
        amount: safeAmount,
        account: !needsDouble ? (accountName || "无") : undefined,
        fromAccount: needsDouble ? fromName : undefined,
        toAccount: needsDouble ? toName : undefined,
        category: !needsDouble && categoryName ? categoryName : undefined,
        remark: remarkText || undefined,
      };

      const res = await fetch("/api/v1/statement/import", {
        method: "POST",
        headers,
        body: JSON.stringify({
          items: [item],
          defaultAccountName: (defaultAccountName ?? "").trim() || undefined,
        }),
      });

      if (res.status === 401) {
        clearStoredApiKeySession();
        window.dispatchEvent(new CustomEvent("wiseme:api-key-required"));
        throw new Error("未授权：请先输入 API 密码");
      }

      const data = (await res.json().catch(() => null)) as
        | { ok: true; createdCount: number; skippedCount?: number; errors?: Array<{ error: string }> }
        | { ok: false; error: string }
        | null;
      if (!data || (data as any).ok !== true) {
        throw new Error((data as any)?.error ?? "记账失败");
      }

      if ((data as any).skippedCount && (data as any).skippedCount > 0) {
        const err = (data as any).errors?.[0]?.error ?? "需要补齐字段后再导入";
        throw new Error(`记账失败：${err}`);
      }

      setLastType(type);
      setOpen(false);
      await new Promise(resolve => setTimeout(resolve, 100));
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "记账失败";
      window.alert(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center gap-1 shadow-sm"
        onClick={() => {
          resetForOpen();
          setOpen(true);
        }}
        type="button"
      >
        <Plus className="w-4 h-4" />
        记账
        <ChevronDown className="w-4 h-4 opacity-90" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">快捷记账（{selectedLabel}）</div>
              <button
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
                onClick={() => setOpen(false)}
                type="button"
              >
                关闭
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <SmartSelect mode="single" value={type} onChange={(id) => setType(id as TxType)}
                  options={txTypeOptions} placeholder="类型" searchable={false} />
                <input
                  type="date"
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none tabular-nums"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="金额（例如 12.34）"
                  inputMode="decimal"
                />
                {!needsDouble ? (
                  <SmartSelect mode="single" value={account} onChange={setAccount}
                    options={smartAccountOptions} placeholder="选择账户（可留空用当前账户）" />
                ) : (
                  <div className="text-xs text-slate-500 flex items-center px-2">
                    {type === "transfer" ? "转账需要转出/转入账户" : "投资建议填写转出/转入账户"}
                  </div>
                )}
              </div>

              {needsDouble ? (
                <div className="grid grid-cols-2 gap-2">
                  <SmartSelect mode="single" value={fromAccount} onChange={setFromAccount}
                    options={smartAccountOptions} placeholder="转出账户" />
                  <SmartSelect mode="single" value={toAccount} onChange={setToAccount}
                    options={smartAccountOptions} placeholder="转入账户" />
                </div>
              ) : (
                <input
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="类别（可选，例如：支出.餐饮.外卖 或 餐饮）"
                />
              )}

              <input
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="备注（可选）"
              />

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="h-9 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  onClick={onSubmit}
                  type="button"
                  disabled={submitting}
                >
                  {submitting ? "提交中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

