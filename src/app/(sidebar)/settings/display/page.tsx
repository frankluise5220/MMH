"use client";

import { useState, useEffect } from "react";

export default function DisplaySettingsPage() {
  const [scheme, setScheme] = useState<string>("red_up_green_down");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/color-scheme")
      .then(r => r.json())
      .then(d => { if (d.ok) setScheme(d.colorScheme); })
      .catch(() => {});
  }, []);

  async function save(next: string) {
    setSaving(true);
    setScheme(next);
    try {
      const res = await fetch("/api/v1/settings/color-scheme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ colorScheme: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setScheme(scheme); // revert
      }
    } catch {
      setScheme(scheme); // revert
    } finally {
      setSaving(false);
    }
  }

  const options: { value: string; label: string; desc: string; preview: { up: string; down: string } }[] = [
    {
      value: "red_up_green_down",
      label: "红涨绿跌",
      desc: "中国习惯，涨为红色，跌为绿色",
      preview: { up: "text-red-600", down: "text-emerald-700" },
    },
    {
      value: "green_up_red_down",
      label: "绿涨红跌",
      desc: "国际习惯，涨为绿色，跌为红色",
      preview: { up: "text-emerald-700", down: "text-red-600" },
    },
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">显示设置</h2>

      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-600 mb-2">涨跌颜色</div>
        <div className="space-y-2">
          {options.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                scheme === opt.value
                  ? "border-blue-300 bg-blue-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="colorScheme"
                value={opt.value}
                checked={scheme === opt.value}
                onChange={() => save(opt.value)}
                disabled={saving}
                className="shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                <div className="text-xs text-slate-500">{opt.desc}</div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className={opt.preview.up}>+1.23%</span>
                <span className="text-slate-400">/</span>
                <span className={opt.preview.down}>-0.56%</span>
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}