"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/**
 * Reusable filter dropdown family (the same dropdown as the "filter by account
 * type" control on the settings/accounts page).
 *
 * Two flavours:
 * - `MultiSelectFilterDropdown`: empty selection = show all; the trigger button
 *   summarizes the current selection. Passing `groups` renders the report-style
 *   picker: a group header column with whole-group checkboxes plus a scrollable
 *   3-column grid of options.
 * - `SingleSelectFilterDropdown`: one value out of an enum-like set.
 *
 * Panels are rendered through a portal so a `overflow-hidden` table toolbar
 * cannot clip them, and they keep the report picker's `max-height + scroll`
 * behaviour.
 */

export type MultiSelectFilterGroup = {
  key: string;
  label: string;
  values: string[];
};

type PanelCommonProps = {
  labelFor: (value: string) => string;
  renderOptionLeading?: (value: string) => ReactNode;
  /** Panel width in px. Grouped pickers follow the report/statistics picker. */
  panelWidth?: number;
  emptyLabel?: string;
};

type MultiSelectFilterDropdownProps = PanelCommonProps & {
  options: string[];
  selectedValues: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  selectedSummaryLabel?: (first: string, count: number) => string;
  clearLabel?: string;
  /** Omit for a flat option list; provide to render grouped report-style columns. */
  groups?: MultiSelectFilterGroup[];
};

type SingleSelectFilterDropdownProps = PanelCommonProps & {
  options: string[];
  value: string;
  onChange: (next: string) => void;
  /** Panel header. Defaults to the current selection label. */
  title?: string;
};

const MAX_PANEL_HEIGHT = 520;
const GROUPED_PANEL_WIDTH = 620;
const FLAT_PANEL_WIDTH = 256;
const SINGLE_PANEL_WIDTH = 224;

/**
 * Anchors a portal-rendered panel under (or above) its trigger button and keeps
 * it in sync with scrolling and resizing.
 */
function useAnchoredPanel(open: boolean, panelWidth: number) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const button = anchorRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - panelWidth - 8));
    const menuHeight = Math.min(window.innerHeight * 0.7, MAX_PANEL_HEIGHT);
    const openUpward = rect.bottom + 4 + menuHeight > window.innerHeight - 8 && rect.top - 4 - menuHeight > 8;
    const top = openUpward ? rect.top - menuHeight - 4 : rect.bottom + 4;
    setPosition({ left, top });
  }, [panelWidth]);

  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  return { anchorRef, panelRef, position, mounted };
}

function useCloseOnOutsidePointer(
  open: boolean,
  onClose: () => void,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open, onClose, anchorRef, panelRef]);
}

function PanelShell({
  position,
  panelRef,
  width,
  children,
}: {
  position: { left: number; top: number };
  panelRef: RefObject<HTMLDivElement | null>;
  width: number;
  children: ReactNode;
}) {
  return createPortal(
    <div
      ref={panelRef}
      style={{ left: position.left, top: position.top, width }}
      className="fixed z-[100] max-h-[min(70vh,520px)] overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}

function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2 px-2">
      <span className="text-[11px] font-medium text-slate-500">{title}</span>
      {action}
    </div>
  );
}

export function MultiSelectFilterDropdown({
  options,
  selectedValues,
  onChange,
  labelFor,
  allLabel,
  selectedSummaryLabel,
  clearLabel,
  emptyLabel,
  renderOptionLeading,
  groups,
  panelWidth,
}: MultiSelectFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const resolvedWidth = panelWidth ?? (groups ? GROUPED_PANEL_WIDTH : FLAT_PANEL_WIDTH);
  const { anchorRef, panelRef, position, mounted } = useAnchoredPanel(open, resolvedWidth);
  useCloseOnOutsidePointer(open, () => setOpen(false), anchorRef, panelRef);

  const toggleValue = (value: string) => {
    onChange(selectedValues.includes(value)
      ? selectedValues.filter((item) => item !== value)
      : [...selectedValues, value]);
  };

  const toggleGroup = (values: string[]) => {
    onChange(values.every((value) => selectedValues.includes(value))
      ? selectedValues.filter((item) => !values.includes(item))
      : [...new Set([...selectedValues, ...values])]);
  };

  const summaryLabel = selectedSummaryLabel ?? ((first: string, count: number) => `${first} +${count}`);
  const clearText = clearLabel ?? allLabel;
  const emptyText = emptyLabel ?? allLabel;
  const label = selectedValues.length === 0
    ? allLabel
    : selectedValues.length === 1
      ? labelFor(selectedValues[0])
      : summaryLabel(labelFor(selectedValues[0]), selectedValues.length);

  const renderOption = (value: string) => (
    <button
      key={value}
      type="button"
      role="option"
      aria-selected={selectedValues.includes(value)}
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-slate-50"
      onClick={() => toggleValue(value)}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 shrink-0 accent-blue-600"
        checked={selectedValues.includes(value)}
        readOnly
        tabIndex={-1}
      />
      {renderOptionLeading ? renderOptionLeading(value) : null}
      <span className="min-w-0 flex-1 truncate" title={labelFor(value)}>{labelFor(value)}</span>
    </button>
  );

  const grouped = groups?.filter((group) => group.values.some((value) => options.includes(value))) ?? [];

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-8 min-w-40 max-w-56 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && mounted ? (
        <PanelShell position={position} panelRef={panelRef} width={resolvedWidth}>
          <PanelHeader
            title={allLabel}
            action={(
              <button type="button" className="text-[11px] text-blue-600 hover:text-blue-800" onClick={() => onChange([])}>
                {clearText}
              </button>
            )}
          />
          {options.length === 0 ? (
            <div className="px-2 py-2 text-xs text-slate-400">{emptyText}</div>
          ) : grouped.length > 0 ? (
            grouped.map((group) => {
              const values = group.values.filter((value) => options.includes(value));
              return (
                <div key={group.key} className="grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-2 last:border-b-0">
                  <label className="flex min-h-7 items-center gap-1.5 px-2 text-xs font-medium text-slate-600">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                      checked={values.every((value) => selectedValues.includes(value))}
                      onChange={() => toggleGroup(values)}
                    />
                    {group.label}
                  </label>
                  <div className="grid grid-cols-3 items-start gap-x-2 gap-y-1">
                    {values.map(renderOption)}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="space-y-1">
              {options.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={selectedValues.includes(value)}
                  className="flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-50"
                  onClick={() => toggleValue(value)}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                    checked={selectedValues.includes(value)}
                    readOnly
                    tabIndex={-1}
                  />
                  {renderOptionLeading ? renderOptionLeading(value) : null}
                  <span className="min-w-0 flex-1 truncate">{labelFor(value)}</span>
                </button>
              ))}
            </div>
          )}
        </PanelShell>
      ) : null}
    </div>
  );
}

