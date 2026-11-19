"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

/**
 * Reusable filter dropdown family (the same dropdown as the "filter by account
 * type" control on the settings/accounts page).
 *
 * Two flavours:
 * `MultiSelectFilterDropdown`: empty selection = show all; the trigger button
 * summarizes the current selection. Passing `groups` renders the report-style
 * picker: a group header column with whole-group checkboxes plus a scrollable
 * 3-column grid of options.
 *
 * The checkbox/label split follows `TableColumnFilter` (the header funnel):
 * the checkbox toggles one value (multi-select), clicking the label text selects
 * just that value and closes the panel (single-select). Both are opt-in per call
 * site so the older callers keep their "click the row toggles" behaviour.
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
  /**
   * Panel width in px. Grouped pickers follow the report/statistics picker.
   * `"auto"` shrink-wraps the panel to the option text (small enum-like filters).
   */
  panelWidth?: number | "auto";
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
  /**
   * Trigger height class. Defaults to `h-8`; pass `h-7` when the control sits in a
   * table toolbar next to the other `h-7` icon buttons, so the row lines up.
   */
  triggerHeightClass?: string;
  /** Trigger shrinks to its own text instead of reserving `min-w-40`. */
  triggerAutoWidth?: boolean;
  /** Clicking the option text selects only that value (and closes the panel). */
  labelClickSelectsSingle?: boolean;
  /**
   * Panel header action becomes a select-all / deselect-all toggle instead of a
   * plain "clear filter" button.
   */
  headerToggleAll?: boolean;
  /** Show `allLabel` on the trigger when every option is selected. */
  showAllLabelWhenFull?: boolean;
  /** Trigger text when nothing is selected (defaults to `allLabel`). */
  zeroSelectionLabel?: string;
  /** Panel header title (defaults to `allLabel`). */
  headerTitle?: string;
};

const MAX_PANEL_HEIGHT = 520;
const GROUPED_PANEL_WIDTH = 620;
const FLAT_PANEL_WIDTH = 256;
/** A content-sized panel has no measurable width before the first paint. */
const AUTO_PANEL_ESTIMATED_HEIGHT = 360;

type PanelPosition = {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
};

/**
 * Anchors a portal-rendered panel under (or above) its trigger button and keeps
 * it in sync with scrolling and resizing.
 */
function useAnchoredPanel(open: boolean, panelWidth: number | "auto") {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PanelPosition>({ left: 0, top: 0 });
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const button = anchorRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (panelWidth === "auto") {
      // Content-sized panels cannot be clamped before paint: pin the right edge to
      // the trigger and let the panel grow leftwards, so a toolbar filter sitting at
      // the right end of the row never pushes its options off screen.
      const estimated = Math.min(MAX_PANEL_HEIGHT, AUTO_PANEL_ESTIMATED_HEIGHT);
      const openUpward = rect.bottom + 4 + estimated > viewportHeight - 8 && rect.top - 4 - estimated > 8;
      const right = Math.max(8, viewportWidth - rect.right);
      setPosition(openUpward
        ? { right, bottom: Math.max(8, viewportHeight - rect.top + 4) }
        : { right, top: rect.bottom + 4 });
      return;
    }
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - panelWidth - 8));
    const menuHeight = Math.min(viewportHeight * 0.7, MAX_PANEL_HEIGHT);
    const openUpward = rect.bottom + 4 + menuHeight > viewportHeight - 8 && rect.top - 4 - menuHeight > 8;
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
  position: PanelPosition;
  panelRef: RefObject<HTMLDivElement | null>;
  width: number | "auto";
  children: ReactNode;
}) {
  return createPortal(
    <div
      ref={panelRef}
      style={{
        ...position,
        width: width === "auto" ? "max-content" : width,
        maxWidth: width === "auto" ? "calc(100vw - 16px)" : undefined,
      }}
      data-multi-select-panel=""
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
  triggerHeightClass = "h-8",
  triggerAutoWidth = false,
  labelClickSelectsSingle = false,
  headerToggleAll = false,
  showAllLabelWhenFull = false,
  zeroSelectionLabel,
  headerTitle,
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
  const allSelected = options.length > 0 && options.every((value) => selectedValues.includes(value));
  const label = selectedValues.length === 0
    ? (zeroSelectionLabel ?? allLabel)
    : showAllLabelWhenFull && allSelected
      ? allLabel
      : selectedValues.length === 1
        ? labelFor(selectedValues[0])
        : summaryLabel(labelFor(selectedValues[0]), selectedValues.length);

  // A content-sized panel must not truncate its own options, or the width stops
  // matching the text (the whole point of `panelWidth="auto"`).
  const optionTextClass = resolvedWidth === "auto" ? "whitespace-nowrap" : "truncate";
  const handleLabelClick = (value: string) => {
    if (labelClickSelectsSingle) {
      onChange([value]);
      setOpen(false);
      return;
    }
    toggleValue(value);
  };

  const renderOption = (value: string) => (
    <div
      key={value}
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-slate-50"
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 shrink-0 accent-blue-600"
        checked={selectedValues.includes(value)}
        onChange={() => toggleValue(value)}
        aria-label={labelFor(value)}
      />
      {renderOptionLeading ? renderOptionLeading(value) : null}
      <button
        type="button"
        className={`min-w-0 flex-1 text-left text-xs text-slate-700 ${optionTextClass}`}
        title={labelFor(value)}
        onClick={() => handleLabelClick(value)}
      >
        {labelFor(value)}
      </button>
    </div>
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
        className={`inline-flex ${triggerHeightClass} items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400 ${
          triggerAutoWidth ? "shrink-0 whitespace-nowrap" : "min-w-40 max-w-56 justify-between"
        }`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={triggerAutoWidth ? "whitespace-nowrap" : "truncate"}>{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && mounted ? (
        <PanelShell position={position} panelRef={panelRef} width={resolvedWidth}>
          <PanelHeader
            title={headerTitle ?? allLabel}
            action={(
              <button
                type="button"
                className={`text-[11px] ${headerToggleAll && allSelected ? "text-slate-500 hover:text-slate-700" : "text-blue-600 hover:text-blue-800"}`}
                onClick={() => {
                  if (!headerToggleAll) {
                    onChange([]);
                    return;
                  }
                  onChange(allSelected ? [] : [...options]);
                }}
              >
                {headerToggleAll ? allLabel : clearText}
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
                <div
                  key={value}
                  className="flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                    checked={selectedValues.includes(value)}
                    onChange={() => toggleValue(value)}
                    aria-label={labelFor(value)}
                  />
                  {renderOptionLeading ? renderOptionLeading(value) : null}
                  <button
                    type="button"
                    className={`min-w-0 flex-1 text-left text-xs text-slate-700 ${optionTextClass}`}
                    title={labelFor(value)}
                    onClick={() => handleLabelClick(value)}
                  >
                    {labelFor(value)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </PanelShell>
      ) : null}
    </div>
  );
}

