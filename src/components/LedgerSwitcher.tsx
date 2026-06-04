"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check } from "lucide-react";

type Household = { id: string; name: string };

export function LedgerSwitcher({ current }: { current: Household | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch("/api/v1/households")
      .then(r => r.json())
      .then(d => { if (d.ok) setHouseholds(d.households); })
      .catch(() => {});
  }, [open]);

  function switchTo(id: string) {
    document.cookie = `householdId=${id};path=/;max-age=31536000`;
    setOpen(false);
    router.refresh();
  }

  async function create() {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/v1/households", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await res.json();
      if (d.ok) {
        switchTo(d.household.id);
      }
    } catch { /* ignore */ }
    finally { setAdding(false); }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center text-white text-xs font-semibold hover:bg-blue-700"
        title={current?.name ?? "默认账簿"}
      >
        {current?.name?.charAt(0) ?? "账"}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
            <div className="px-3 py-2 text-xs font-semibold text-slate-500 border-b border-slate-100">切换账簿</div>
            <div className="max-h-48 overflow-y-auto">
              {households.map((h) => (
                <button
                  key={h.id}
                  onClick={() => switchTo(h.id)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-slate-50 ${current?.id === h.id ? "bg-blue-50 text-blue-700" : "text-slate-700"}`}
                >
                  <span>{h.name}</span>
                  {current?.id === h.id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                </button>
              ))}
            </div>
            <div className="border-t border-slate-100 px-2 py-1.5">
              <div className="flex items-center gap-1">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") create(); }}
                  placeholder="新建账簿…"
                  className="flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none"
                />
                <button
                  type="button"
                  onClick={create}
                  disabled={adding || !newName.trim()}
                  className="h-7 w-7 rounded border border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
