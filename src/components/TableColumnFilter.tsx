"use client";

import { useEffect, useRef, useState } from "react";

type TableColumnFilterProps = {
  label: string;
  options: string[];
  selectedValues: string[];
  open: boolean;
  filtered?: boolean;
  showLabel?: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onChange: (values: string[] | undefined) => void;
};

type DateRangeColumnFilterProps = {
  label: string;
  from: string;
  to: string;
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onChange: (next: { from: string; to: string }) => void;
};

export function TableColumnFilter({
  label,
  options,
  selectedValues,
  open,
  filtered = selectedValues.length > 0,
  showLabel = true,
  onToggleOpen,
  onClose,
  onChange,
}: TableColumnFilterProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      {showLabel ? <span>{label}</span> : null}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleOpen();
        }}
        className={`h-5 w-4 text-[10px] leading-none ${filtered ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}
        title={`${label}筛选`}
      >
        ▼
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-30 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{label}筛选</span>
            <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">
              关闭
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2">
            <button type="button" onClick={() => onChange([])} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
              全选
            </button>
            <button type="button" onClick={() => onChange(["__NO_MATCH__"])} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
              全不选
            </button>
            <button type="button" onClick={() => onChange(undefined)} className="ml-auto text-xs text-blue-600 hover:text-blue-700">
              清空
            </button>
          </div>
          <div className="max-h-56 space-y-1 overflow-auto pr-1">
            {options.map((value) => {
              const checked = selectedValues.length > 0 ? selectedValues.includes(value) : true;
              return (
                <div
                  key={value}
                  className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs ${
                    checked ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      const nextValues = selectedValues.length > 0 ? selectedValues : options;
                      const next = nextValues.includes(value)
                        ? nextValues.filter((item) => item !== value)
                        : Array.from(new Set([...nextValues, value]));
                      onChange(next.length === options.length ? [] : next);
                    }}
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[10px] ${
                      checked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-transparent"
                    }`}
                    aria-label={`${value}勾选`}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onChange([value]);
                      onClose();
                    }}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    <span className="truncate" title={value}>{value}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function DateRangeColumnFilter({
  label,
  from,
  to,
  open,
  onToggleOpen,
  onClose,
  onChange,
}: DateRangeColumnFilterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
  }, [from, to, open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  const active = !!from || !!to;

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleOpen();
        }}
        className={`h-5 w-4 text-[10px] leading-none ${active ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}
        title={`${label}筛选`}
      >
        ▼
      </button>
      {open ? (
        <div className="absolute left-0 top-6 z-30 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{label}筛选</span>
            <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">
              关闭
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500">从（{"≥"}）</div>
              <input
                type="date"
                value={draftFrom}
                onChange={(event) => setDraftFrom(event.target.value)}
                className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500">到（{"≤"}）</div>
              <input
                type="date"
                value={draftTo}
                onChange={(event) => setDraftTo(event.target.value)}
                className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
              />
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setDraftFrom("");
                setDraftTo("");
                onChange({ from: "", to: "" });
                onClose();
              }}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              清空
            </button>
            <button
              type="button"
              onClick={() => {
                onChange({ from: draftFrom, to: draftTo });
                onClose();
              }}
              className="h-8 rounded border border-blue-200 bg-blue-50 px-3 text-xs text-blue-700 hover:bg-blue-100"
            >
              确认
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LinkTableColumnFilter({
  label,
  badgeText,
  items,
  clearHref,
}: {
  label: string;
  badgeText?: string | null;
  items: { value: string; href: string; checked: boolean }[];
  clearHref?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = !!badgeText;
  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
        className={`h-5 px-1 rounded border text-[10px] leading-none inline-flex items-center gap-1 ${active ? "border-blue-300 bg-blue-50 text-blue-600" : "border-slate-200 bg-white text-slate-500"}`}
        title={`${label}筛选`}
      >
        {badgeText ? <span className="font-semibold">{badgeText}</span> : <span>▼</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-30 w-48 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>{label}筛选</span>
            {clearHref ? <a href={clearHref} onClick={() => setOpen(false)} className="text-blue-600 hover:text-blue-700">清除</a> : null}
          </div>
          <div className="space-y-1">
            {items.map((it) => (
              <a key={it.value} href={it.href} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded px-1 py-1 text-xs text-slate-700 hover:bg-slate-50">
                <span className={`h-3 w-3 rounded border ${it.checked ? "border-blue-500 bg-blue-500" : "border-slate-300 bg-white"}`} />
                <span className="truncate" title={it.value}>{it.value}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function LinkDateRangeFilter({
  label,
  from,
  to,
  badgeText,
  clearHref,
  hiddenInputs,
}: {
  label: string;
  from: string;
  to: string;
  badgeText?: string | null;
  clearHref?: string | null;
  hiddenInputs: { name: string; value: string }[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = !!badgeText;
  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
        className={`h-5 px-1 rounded border text-[10px] leading-none inline-flex items-center gap-1 ${active ? "border-blue-300 bg-blue-50 text-blue-600" : "border-slate-200 bg-white text-slate-500"}`}
        title={`${label}筛选`}
      >
        {badgeText ? <span className="font-semibold">{badgeText}</span> : <span>▼</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-30 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>{label}筛选</span>
            {clearHref ? <a href={clearHref} onClick={() => setOpen(false)} className="text-blue-600 hover:text-blue-700">清除</a> : null}
          </div>
          <form method="get" action="/">
            {hiddenInputs.map((h) => (
              <input key={`${h.name}:${h.value}`} type="hidden" name={h.name} value={h.value} />
            ))}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="text-[10px] text-slate-500">从（≥）</div>
                <input
                  type="date"
                  name="detailDateFrom"
                  defaultValue={from}
                  className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[10px] text-slate-500">到（≤）</div>
                <input
                  type="date"
                  name="detailDateTo"
                  defaultValue={to}
                  className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button type="submit" onClick={() => setOpen(false)} className="h-8 px-3 rounded border border-blue-200 bg-blue-50 text-blue-700 text-xs hover:bg-blue-100">确认</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export function LinkNumberRangeFilter({
  label,
  fromName,
  toName,
  from,
  to,
  badgeText,
  clearHref,
  hiddenInputs,
  fromPlaceholder,
  toPlaceholder,
}: {
  label: string;
  fromName: string;
  toName: string;
  from: string;
  to: string;
  badgeText?: string | null;
  clearHref?: string | null;
  hiddenInputs: { name: string; value: string }[];
  fromPlaceholder?: string;
  toPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = !!badgeText;
  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}
        className={`h-5 px-1 rounded border text-[10px] leading-none inline-flex items-center gap-1 ${active ? "border-blue-300 bg-blue-50 text-blue-600" : "border-slate-200 bg-white text-slate-500"}`}
        title={`${label}筛选`}
      >
        {badgeText ? <span className="font-semibold">{badgeText}</span> : <span>▼</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-30 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>{label}筛选</span>
            {clearHref ? <a href={clearHref} onClick={() => setOpen(false)} className="text-blue-600 hover:text-blue-700">清除</a> : null}
          </div>
          <form method="get" action="/">
            {hiddenInputs.map((h) => (
              <input key={`${h.name}:${h.value}`} type="hidden" name={h.name} value={h.value} />
            ))}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="text-[10px] text-slate-500">从（≥）</div>
                <input
                  inputMode="decimal"
                  name={fromName}
                  defaultValue={from}
                  placeholder={fromPlaceholder}
                  className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[10px] text-slate-500">到（≤）</div>
                <input
                  inputMode="decimal"
                  name={toName}
                  defaultValue={to}
                  placeholder={toPlaceholder}
                  className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
                />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-2">
              <button type="submit" onClick={() => setOpen(false)} className="h-8 px-3 rounded border border-blue-200 bg-blue-50 text-blue-700 text-xs hover:bg-blue-100">确认</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
