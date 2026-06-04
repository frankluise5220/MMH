"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";

/**
 * 带计算器的输入框。可在任意表单中复用。
 * - 右侧按钮显示四则运算符号，点击弹出计算器
 * - 弹出层通过 Portal 渲染到 body，不影响表单布局
 * - 支持快速分数按钮 (1/4, 1/3, 1/2)
 * - 支持在输入框内手写运算式，按回车求值
 */
export function CalcInput({
  value,
  onChange,
  placeholder,
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dialogPos, setDialogPos] = useState<{ top: number; left: number } | null>(null);
  const [expr, setExpr] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const numVal = parseFloat(value) || 0;

  // ---- eval helper ----
  const doEval = useCallback((expression: string) => {
    let full = expression;
    if (/^[+\-*/]/.test(full)) full = `${numVal}${full}`;
    if (!full) return;
    try {
      if (!/^[\d+\-*/().\s]+$/.test(full)) throw new Error("invalid");
      const safe = full.replace(/\s+/g, "");
      const computed = eval(safe);
      if (typeof computed === "number" && !isNaN(computed) && isFinite(computed)) {
        onChange(computed.toFixed(3));
      }
    } catch { /* ignore */ }
  }, [numVal, onChange]);

  // ---- reset expr on open, position dialog relative to trigger ----
  useEffect(() => {
    if (!open) return;
    setExpr("");
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Position below trigger, but clamp to viewport
      const top = Math.min(rect.bottom + 4, window.innerHeight - 420);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 280));
      setDialogPos({ top, left });
    }
  }, [open]);

  // ---- body scroll lock ----
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // ---- click outside to close ----
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ---- keyboard in popup ----
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (/^[\d+\-*/.]$/.test(e.key)) { e.preventDefault(); setExpr(p => p + e.key); }
      else if (e.key === "Enter" || e.key === "=") { e.preventDefault(); doEval(expr); setOpen(false); }
      else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
      else if (e.key === "Backspace") { e.preventDefault(); setExpr(p => p.slice(0, -1)); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, expr, doEval]);

  function press(key: string) {
    if (key === "=") { doEval(expr); setOpen(false); return; }
    if (key === "C") { setExpr(""); return; }
    if (key === "1/4") { onChange((numVal * 0.25).toFixed(3)); return; }
    if (key === "1/3") { onChange((numVal * 0.333333).toFixed(3)); return; }
    if (key === "1/2") { onChange((numVal * 0.5).toFixed(3)); return; }
    setExpr(p => p + key);
  }

  // ---- inline eval: user types operator in input → Enter → evaluate, no form submit ----
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const v = value.trim();
    if (!/^[\d.]+[+\-*/\d.()\s]+$/.test(v)) return;
    e.preventDefault();
    e.stopPropagation();
    doEval(v);
  }

  const keyRows = [
    ["7", "8", "9", "/"],
    ["4", "5", "6", "*"],
    ["1", "2", "3", "-"],
    ["C", "0", ".", "+"],
  ];

  const fractionBtns = [
    { label: "1/4", val: "1/4" },
    { label: "1/3", val: "1/3" },
    { label: "1/2", val: "1/2" },
  ];

  return (
    <div className={`relative ${className ?? ""}`}>
      {/* Input — inline evaluation on Enter, no form submit */}
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 pr-10 text-sm font-mono outline-none"
      />

      {/* Trigger button */}
      <div className="absolute right-0 top-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          className="h-9 w-9 flex items-center justify-center rounded-md border border-l-0 border-slate-200 bg-white text-blue-600 hover:bg-blue-50"
          title={`计算器${label ? `：${label}` : ""}`}
        >
          <span className="grid grid-cols-2 gap-px w-3.5 h-[15px]">
            <span className="text-[10px] leading-none flex items-center justify-center">+</span>
            <span className="text-[10px] leading-none flex items-center justify-center">−</span>
            <span className="text-[10px] leading-none flex items-center justify-center">×</span>
            <span className="text-[10px] leading-none flex items-center justify-center">÷</span>
          </span>
        </button>
      </div>

      {/* Popup calculator — Portal to body */}
      {open && dialogPos && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-start justify-start" style={{ pointerEvents: "none" }}>
          {/* Invisible backdrop */}
          <div className="absolute inset-0" style={{ pointerEvents: "auto" }} onClick={() => setOpen(false)} />
          <div
            ref={dialogRef}
            style={{
              position: "fixed",
              top: dialogPos.top,
              left: dialogPos.left,
              pointerEvents: "auto",
            }}
            className="w-[272px] rounded-xl border border-slate-200 bg-white shadow-2xl select-none overflow-hidden"
          >
            {/* Display */}
            <div className="px-3 pt-2.5 pb-2 border-b border-slate-100 bg-slate-50">
              <div className="text-[11px] text-slate-400 tabular-nums">当前值: {numVal.toFixed(3)}</div>
              <div className="h-5 mt-0.5 text-sm font-mono text-slate-800 text-right tabular-nums">
                {expr || <span className="text-slate-300 text-xs">输入运算式…</span>}
              </div>
            </div>

            {/* Quick fraction buttons */}
            <div className="px-3 py-2 flex gap-2">
              {fractionBtns.map(f => (
                <button
                  key={f.val}
                  type="button"
                  onClick={() => press(f.val)}
                  className="flex-1 h-7 rounded-md border border-amber-200 bg-amber-50 text-amber-700 text-xs font-medium hover:bg-amber-100 active:bg-amber-200"
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Number pad */}
            <div className="grid grid-cols-4 gap-1 px-3 pb-3">
              {keyRows.flat().map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  className={`h-9 rounded-md text-sm font-medium active:scale-95 transition-transform ${
                    /[+\-*/]/.test(key)
                      ? "bg-blue-50 text-blue-600 hover:bg-blue-100 text-base"
                      : key === "C"
                      ? "bg-red-50 text-red-500 hover:bg-red-100"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {key}
                </button>
              ))}
              {/* = button fills the last row as a tall merge — but we keep it simple: add = at bottom */}
            </div>
            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={() => press("=")}
                className="h-9 w-full rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800"
              >
                = 求值
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
