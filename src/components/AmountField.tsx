"use client";

import { Calculator } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
};

function safeEval(expr: string): number | null {
  if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;
  try {
    const r = eval(expr);
    return typeof r === "number" && isFinite(r) ? r : null;
  } catch {
    return null;
  }
}

export default function AmountField({ value, onChange, label, placeholder }: Props) {
  const [calcOpen, setCalcOpen] = useState(false);
  const [calcExpr, setCalcExpr] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const numVal = parseFloat(value) || 0;

  // Close popover on outside click
  useEffect(() => {
    if (!calcOpen) return;
    const h = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setCalcOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [calcOpen]);

  // Keyboard: /3, *2 etc. directly in input, Enter to evaluate
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const raw = (e.target as HTMLInputElement).value;
      // If the raw value looks like an expression (contains operators), evaluate it
      if (/[+\-*/]/.test(raw) && !raw.startsWith("-") || /^-[^0-9]/.test(raw)) {
        e.preventDefault();
        const result = safeEval(raw);
        if (result !== null) {
          onChange(Number(result.toFixed(6)).toString());
          inputRef.current?.blur();
        }
      } else {
        // Regular Enter — just blur
        inputRef.current?.blur();
      }
    }
  }

  // Calculator popup keyboard
  useEffect(() => {
    if (!calcOpen) return;
    const h = (e: KeyboardEvent) => {
      if (/^[\d+\-*/.]$/.test(e.key)) { e.preventDefault(); setCalcExpr(p => p + e.key); }
      else if (e.key === "Enter" || e.key === "=") { e.preventDefault(); doCalc(); }
      else if (e.key === "Escape") { e.preventDefault(); setCalcOpen(false); }
      else if (e.key === "Backspace") { e.preventDefault(); setCalcExpr(p => p.slice(0, -1)); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [calcOpen, calcExpr, numVal]);

  function doCalc() {
    let fullExpr = calcExpr;
    if (/^[+\-*/]/.test(fullExpr)) fullExpr = `${numVal}${fullExpr}`;
    if (!fullExpr) return;
    const result = safeEval(fullExpr);
    if (result !== null) onChange(Number(result.toFixed(6)).toString());
    setCalcOpen(false);
  }

  function press(key: string) {
    if (key === "=") { doCalc(); return; }
    if (key === "C") { setCalcExpr(""); return; }
    setCalcExpr(p => p + key);
  }

  const keys = [["7","8","9","/"],["4","5","6","*"],["1","2","3","-"],["C","0",".","+"]];

  return (
    <div className="relative space-y-1">
      {label && <div className="text-xs font-medium text-slate-600">{label}</div>}
      <div className="relative">
        <input
          ref={inputRef}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "0.00"}
          className="h-9 w-full rounded-md border border-slate-200 bg-white pl-3 pr-9 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => setCalcOpen(true)}
          className="absolute right-0.5 top-0.5 h-8 w-8 flex items-center justify-center rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50"
          title="计算器"
        >
          <Calculator className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Popup calculator */}
      {calcOpen && (
        <div ref={popRef} className="absolute bottom-full left-0 mb-1 z-50 rounded-lg border border-slate-200 bg-white shadow-lg select-none w-[180px]">
          <div className="px-2.5 pt-2 pb-1">
            <div className="text-[10px] text-slate-400 tabular-nums">{numVal.toFixed(2)}</div>
            <div className="h-5 text-sm font-mono text-slate-700 text-right tabular-nums">
              {calcExpr || <span className="text-slate-300 text-xs">运算…</span>}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-px px-1 pb-1">
            {keys.flat().map((k) => (
              <button key={k} type="button" onClick={() => press(k)}
                className={`h-7 rounded text-xs font-medium ${
                  /[+\-*/]/.test(k) ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                  : k === "C" ? "bg-red-50 text-red-500 hover:bg-red-100"
                  : "bg-slate-50 text-slate-700 hover:bg-slate-100"}`}
              >{k}</button>
            ))}
          </div>
          <div className="px-1 pb-1.5">
            <button type="button" onClick={() => press("=")} className="h-7 w-full rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700">=</button>
          </div>
        </div>
      )}
    </div>
  );
}
