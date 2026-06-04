"use client";

import { useEffect, useRef, useState } from "react";

interface MiniCalculatorProps {
  value: string;
  onChange: (newValue: string) => void;
  label?: string;
}

/**
 * Popup calculator — operates on the current value.
 * Press = to compute, write result back, and close.
 * Flow: click calculator icon → see current value → press * 3 = → value becomes 900, calculator closes.
 */
export default function MiniCalculator({ value, onChange, label }: MiniCalculatorProps) {
  const [open, setOpen] = useState(false);
  const [expr, setExpr] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const numVal = parseFloat(value) || 0;

  useEffect(() => {
    if (open) setExpr("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Keyboard support: type directly in the popup
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (/^[\d+\-*/.]$/.test(e.key)) {
        e.preventDefault();
        setExpr(prev => prev + e.key);
      } else if (e.key === "Enter" || e.key === "=") {
        e.preventDefault();
        doEval();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setExpr(prev => prev.slice(0, -1));
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, expr, numVal, onChange]);

  function doEval() {
    let fullExpr = expr;
    if (/^[+\-*/]/.test(fullExpr)) {
      fullExpr = `${numVal}${fullExpr}`;
    }
    if (!fullExpr) { setOpen(false); return; }
    try {
      if (!/^[\d+\-*/().\s]+$/.test(fullExpr)) throw new Error("invalid");
      // eslint-disable-next-line no-eval
      const computed = eval(fullExpr);
      if (typeof computed === "number" && !isNaN(computed) && isFinite(computed)) {
        onChange(computed.toFixed(3));
      }
    } catch { /* ignore */ }
    setOpen(false);
  }

  function press(key: string) {
    if (key === "=") { doEval(); return; }
    if (key === "C") { setExpr(""); return; }
    setExpr(prev => prev + key);
  }

  const keys = [
    ["7", "8", "9", "/"],
    ["4", "5", "6", "*"],
    ["1", "2", "3", "-"],
    ["C", "0", ".", "+"],
  ];

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-blue-600 hover:bg-blue-50"
        title={`计算器${label ? `：${label}` : ""}`}
      >
        <span className="text-xs font-mono leading-none">+-<br/>×÷</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1 z-50 rounded-lg border border-slate-200 bg-white shadow-lg select-none"
        >
          {/* Display: show original value + expression being built */}
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-xs text-slate-400">
              {numVal.toFixed(3)}
            </div>
            <div className="h-5 text-sm font-mono text-slate-700 text-right">
              {expr || <span className="text-slate-300">输入运算…</span>}
            </div>
          </div>

          {/* Number pad */}
          <div className="grid grid-cols-4 gap-px px-1 pb-1">
            {keys.flat().map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => press(key)}
                className={`h-7 rounded text-xs font-medium ${
                  /[+\-*/]/.test(key)
                    ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                    : key === "C"
                    ? "bg-red-50 text-red-500 hover:bg-red-100"
                    : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                }`}
              >
                {key}
              </button>
            ))}
          </div>

          {/* = bar: press to evaluate, write back, and close */}
          <div className="px-1 pb-1.5">
            <button type="button" onClick={() => press("=")}
              className="h-7 w-full rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700">
              =
            </button>
          </div>
        </div>
      )}
    </div>
  );
}