"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Plus, ChevronDown, ChevronRight, X, Check,
} from "lucide-react";

/* ---- Types ---- */

export type SmartSelectOption = {
  id: string;
  label: string;
  /** Secondary label (e.g. kind label) shown inline in smaller text, same line as primary label. */
  subLabel?: string;
  /** Color dot/badge — used for tags in multi mode. */
  color?: string | null;
  /** When true, this option acts as a group header and cannot be selected.
   *  Used for top-level categories like "支出", "收入". */
  isHeader?: boolean;
  /** When true, this option is selectable but also acts as a collapsible group
   *  for its children (options with parentId pointing to this id).
   *  Used for mid-level categories like "餐饮" that have sub-items like "外卖". */
  isGroup?: boolean;
  /** For grouped options: id of the parent group this item belongs to.
   *  For level-1 items: points to a root header (isHeader).
   *  For level-2 items: points to a mid-level group (isGroup).
   *  Enables search to preserve hierarchy and collapse to track group membership. */
  parentId?: string;
};

type SingleModeProps = {
  mode: "single";
  value: string;
  onChange: (id: string) => void;
  options: SmartSelectOption[];
  placeholder?: string;
  searchable?: boolean;
  onCreateClick?: () => void;
  createLabel?: string;
};

type MultiModeProps = {
  mode: "multi";
  value: string[];
  onChange: (ids: string[]) => void;
  options: SmartSelectOption[];
  placeholder?: string;
  onInlineCreate?: (name: string, color: string) => Promise<SmartSelectOption>;
  /** @deprecated Use onInlineCreate for decoupled API calls. Legacy direct /api/v1/tags call still works if onInlineCreate is omitted. */
  onCreated?: (tag: SmartSelectOption) => void;
};

export type SmartSelectProps = SingleModeProps | MultiModeProps;

/* ---- Helpers ---- */

/** Strip fullwidth-space indentation from a label (for trigger display). */
function stripIndent(label: string): string {
  return label.replace(/^[　]+/, "");
}

function shouldShowSearch(options: SmartSelectOption[], searchable?: boolean) {
  if (searchable === true) return true;
  if (searchable === false) return false;
  // Always show search when options contain group headers or collapsible groups
  if (options.some(o => o.isHeader || o.isGroup)) return true;
  return options.length > 10;
}

/** Build a map of groupId → count of direct children (for headers AND collapsible groups). */
function buildGroupChildCounts(options: SmartSelectOption[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of options) {
    if (o.parentId && !o.isHeader) {
      counts.set(o.parentId, (counts.get(o.parentId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Search filter that preserves group headers and collapsible groups.
 *  When a child matches, its parent group (and ancestor groups) are kept too. */
function filterWithGroups(options: SmartSelectOption[], search: string): SmartSelectOption[] {
  if (!search.trim()) return options;
  const q = search.toLowerCase();
  const matchedIds = new Set<string>();
  // Find all matching non-header options. Include subLabel so institution/person
  // types such as "债权债务" can be searched directly.
  for (const o of options) {
    const haystack = `${o.label} ${o.subLabel ?? ""}`.toLowerCase();
    if (!o.isHeader && haystack.includes(q)) {
      matchedIds.add(o.id);
    }
  }
  // Walk back up parentId chain to include ancestor groups
  const groupIdsToKeep = new Set<string>();
  const optionById = new Map(options.map(o => [o.id, o]));
  for (const id of matchedIds) {
    const o = optionById.get(id);
    if (o?.parentId) {
      let cur: string | undefined = o.parentId;
      while (cur) {
        groupIdsToKeep.add(cur);
        const parent = optionById.get(cur);
        cur = parent?.parentId;
      }
    }
  }
  // Return options in original order: groups that are needed + matched children
  return options.filter(o => {
    if (o.isHeader || o.isGroup) return groupIdsToKeep.has(o.id);
    return matchedIds.has(o.id);
  });
}

/** Determine which groups should be collapsed by default.
 *  Root headers (isHeader) are expanded by default so user sees level-2 items.
 *  Mid-level groups (isGroup) are collapsed by default so user doesn't see level-3 items. */
function initialCollapsedGroups(options: SmartSelectOption[], value: string): Set<string> {
  const collapsed = new Set<string>();
  // Collapse all isGroup items by default (level-2 groups hide their level-3 children)
  for (const o of options) {
    if (o.isGroup) collapsed.add(o.id);
  }
  // If a selected value belongs to a collapsed group, expand that group so the selected item is visible
  if (value) {
    const optionById = new Map(options.map(o => [o.id, o]));
    let cur = optionById.get(value);
    while (cur?.parentId) {
      if (collapsed.has(cur.parentId)) {
        collapsed.delete(cur.parentId);
      }
      cur = optionById.get(cur.parentId);
    }
  }
  return collapsed;
}

/** Build visible list: apply search + collapse filters.
 *  Collapsed groups hide their children (recursively for nested groups).
 *  Search forces all groups open. */
function buildVisible(
  options: SmartSelectOption[],
  filtered: SmartSelectOption[],
  collapsedGroups: Set<string>,
  isSearching: boolean,
): SmartSelectOption[] {
  if (isSearching) return filtered; // search forces all groups open
  // Non-searching: hide children of collapsed groups (headers AND isGroup)
  return filtered.filter(o => {
    // If this item has a parentId pointing to a collapsed group, hide it
    // Also check if any ancestor group in the parentId chain is collapsed
    if (o.parentId && !o.isHeader) {
      // Direct parent collapsed → hide
      if (collapsedGroups.has(o.parentId)) return false;
    }
    // isHeader items are always visible (they're root-level)
    // isGroup items are always visible (they're level-2, shown between level-1 headers)
    return true;
  });
}

const PRESET_COLORS = [
  "#7BA05B", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899",
  "#06B6D4", "#F43F5E", "#84CC16", "#6366F1", "#14B8A6",
  "#E11D48", "#0EA5E9",
];

/* ---- Component ---- */

export function SmartSelect(props: SmartSelectProps) {
  const { mode, value, onChange, options, placeholder } = props;
  const searchable = shouldShowSearch(options, mode === "single" ? props.searchable : false);
  const onCreateClick = mode === "single" ? props.onCreateClick : undefined;
  const createLabel = mode === "single" ? props.createLabel : undefined;
  const onInlineCreate = mode === "multi" ? props.onInlineCreate : undefined;
  const onCreated = mode === "multi" ? props.onCreated : undefined;

  const hasGroups = options.some(o => o.isHeader || o.isGroup);
  const groupChildCounts = useMemo(() => buildGroupChildCounts(options), [options]);
  const selectableOptions = useMemo(() => options.filter(o => !o.isHeader), [options]);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---- Multi mode: inline create state ---- */
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#7BA05B");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ---- Filtered & visible options ---- */
  const isSearching = search.trim().length > 0;
  const filtered = isSearching
    ? filterWithGroups(options, search)
    : options;
  const visible = useMemo(() =>
    buildVisible(options, filtered, collapsedGroups, isSearching),
  [filtered, collapsedGroups, isSearching, options]);

  /* ---- Trigger display ---- */
  const selectedOption = mode === "single"
    ? options.find(o => o.id === (value as string))
    : undefined;
  // Strip indent from label for trigger button display
  const selectedLabel = selectedOption ? stripIndent(selectedOption.label) : undefined;

  /* ---- Toggle group collapse ---- */
  function toggleGroup(groupId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  /* ---- Calculate dropdown position from trigger ---- */
  const calcPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const minDropdownWidth = onCreateClick ? 300 : 0;
    const width = Math.min(Math.max(rect.width, minDropdownWidth), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const estimatedHeight = (searchable ? 36 : 0)
      + (onCreateClick || mode === "multi" ? 36 : 0)
      + Math.min(visible.length, 7) * 36
      + 16;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const shouldFlip = spaceBelow < estimatedHeight && spaceAbove > estimatedHeight;
    setDropdownPos({
      top: shouldFlip ? rect.top - 4 : rect.bottom + 4,
      left,
      width,
    });
  }, [searchable, onCreateClick, mode, visible.length]);

  /* ---- Open/close ---- */
  const closeDropdown = useCallback(() => {
    setOpen(false);
    setSearch("");
    setShowNew(false);
    setFocusedIndex(-1);
  }, []);

  const openDropdown = useCallback((preferredIndex?: "first" | "last") => {
    // Initialize collapsed groups: root headers expanded, mid-level groups collapsed
    if (hasGroups) {
      setCollapsedGroups(initialCollapsedGroups(options, (value as string)));
    } else {
      setCollapsedGroups(new Set());
    }
    calcPosition();
    setOpen(true);
    setSearch("");
    setShowNew(false);

    // Find selected item index in visible list
    if (mode === "single") {
      if (preferredIndex === "last" && visible.length > 0) {
        setFocusedIndex(visible.length - 1);
        return;
      }
      if (preferredIndex === "first") {
        setFocusedIndex(0);
        return;
      }
      const idx = visible.findIndex(o => o.id === (value as string));
      setFocusedIndex(idx >= 0 ? idx : 0);
    } else {
      setFocusedIndex(preferredIndex === "last" && visible.length > 0 ? visible.length - 1 : 0);
    }
  }, [visible, value, mode, calcPosition, hasGroups, options]);

  const handleOpenToggle = useCallback(() => {
    if (open) {
      closeDropdown();
      return;
    }
    openDropdown();
  }, [open, closeDropdown, openDropdown]);

  /* ---- Recalc position on scroll / resize while open ---- */
  useEffect(() => {
    if (!open) return;
    function onScroll() { calcPosition(); }
    function onResize() { calcPosition(); }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, calcPosition]);

  /* ---- Scroll to focused/selected item ---- */
  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    const listEl = listRef.current;
    if (!listEl) return;
    const optionEl = listEl.children[focusedIndex] as HTMLElement;
    if (optionEl) {
      optionEl.scrollIntoView({ block: "nearest" });
    }
  }, [open, focusedIndex]);

  /* ---- Close on click outside ---- */
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (triggerRef.current?.contains(e.target as HTMLElement)) return;
      if (dropdownRef.current?.contains(e.target as HTMLElement)) return;
      setOpen(false);
      setSearch("");
      setShowNew(false);
      setFocusedIndex(-1);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  /* ---- Close on ESC ---- */
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
        setShowNew(false);
        setFocusedIndex(-1);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  /* ---- Auto-focus inline create input ---- */
  useEffect(() => {
    if (showNew && inputRef.current) inputRef.current.focus();
  }, [showNew]);

  /* ---- Auto-focus search input on open ---- */
  useEffect(() => {
    if (open && searchable) {
      const searchInput = dropdownRef.current?.querySelector<HTMLInputElement>("input[data-search]");
      searchInput?.focus();
    }
  }, [open, searchable]);

  /* ---- Handlers ---- */

  function selectSingle(id: string) {
    (onChange as (id: string) => void)(id);
    setOpen(false);
    setSearch("");
    setFocusedIndex(-1);
  }

  function toggleMulti(id: string) {
    const ids = value as string[];
    const next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
    (onChange as (ids: string[]) => void)(next);
  }

  function handleCreateClick() {
    setOpen(false);
    setSearch("");
    setFocusedIndex(-1);
    onCreateClick?.();
  }

  async function createTag() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      if (onInlineCreate) {
        const newOpt = await onInlineCreate(newName.trim(), newColor);
        toggleMulti(newOpt.id);
        onCreated?.(newOpt);
        setNewName("");
        setShowNew(false);
      } else {
        const res = await fetch("/api/v1/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName.trim(), color: newColor }),
        });
        const data = await res.json();
        if (data.ok && data.tag) {
          const newTag: SmartSelectOption = { id: data.tag.id, label: data.tag.name, color: data.tag.color };
          toggleMulti(newTag.id);
          onCreated?.(newTag);
          setNewName("");
          setShowNew(false);
        } else {
          window.alert(data.error ?? "创建失败");
        }
      }
    } catch {
      window.alert("网络错误");
    } finally {
      setCreating(false);
    }
  }

  /* ---- Keyboard navigation on dropdown ---- */
  function handleDropdownKeyDown(e: React.KeyboardEvent) {
    const total = visible.length;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex(prev => {
          let next = prev + 1;
          return next < total ? next : 0;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex(prev => prev > 0 ? prev - 1 : total - 1);
        break;
      case "Home":
        e.preventDefault();
        setFocusedIndex(0);
        break;
      case "End":
        e.preventDefault();
        setFocusedIndex(total - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (search.trim() && visible.length === 1) {
          if (visible[0].isHeader) return;
          if (mode === "single") selectSingle(visible[0].id);
          else toggleMulti(visible[0].id);
          return;
        }
        if (focusedIndex >= 0 && focusedIndex < total) {
          const focusedOpt = visible[focusedIndex];
          if (focusedOpt.isHeader) {
            // Enter on a root group header → toggle collapse
            toggleGroup(focusedOpt.id);
            return;
          }
          if (focusedOpt.isGroup) {
            // Enter on a mid-level group → toggle collapse (group is also selectable, but Enter toggles first)
            toggleGroup(focusedOpt.id);
            return;
          }
          if (mode === "single") selectSingle(focusedOpt.id);
          else toggleMulti(focusedOpt.id);
        }
        break;
      case "Tab":
        setOpen(false);
        setSearch("");
        setShowNew(false);
        setFocusedIndex(-1);
        break;
    }
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (mode === "single") {
        const currentIndex = selectableOptions.findIndex(o => o.id === (value as string));
        const selectByIndex = (index: number) => {
          const next = selectableOptions[index];
          if (next) (onChange as (id: string) => void)(next.id);
        };

        switch (e.key) {
          case "ArrowDown":
          case "ArrowRight": {
            e.preventDefault();
            if (selectableOptions.length === 0) return;
            const nextIndex = currentIndex >= 0
              ? (currentIndex + 1) % selectableOptions.length
              : 0;
            selectByIndex(nextIndex);
            return;
          }
          case "ArrowUp":
          case "ArrowLeft": {
            e.preventDefault();
            if (selectableOptions.length === 0) return;
            const nextIndex = currentIndex >= 0
              ? (currentIndex - 1 + selectableOptions.length) % selectableOptions.length
              : selectableOptions.length - 1;
            selectByIndex(nextIndex);
            return;
          }
          case "Home":
            e.preventDefault();
            if (selectableOptions.length > 0) selectByIndex(0);
            return;
          case "End":
            e.preventDefault();
            if (selectableOptions.length > 0) selectByIndex(selectableOptions.length - 1);
            return;
        }
      }

      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          openDropdown("first");
          return;
        default:
          return;
      }
    }

    if (!searchable) {
      handleDropdownKeyDown(e);
    }
  }

  /* ---- ARIA IDs ---- */
  const listId = `ss-list-${useId()}`;

  /* ---- Dropdown content ---- */

  const dropdownContent = (
    <div
      ref={dropdownRef}
      onKeyDown={handleDropdownKeyDown}
      className="overflow-hidden rounded-[12px] border border-slate-200/80 bg-surface-white shadow-[0_18px_40px_rgba(15,23,42,0.12)]"
      style={{
        position: "fixed",
        top: dropdownPos.top,
        left: dropdownPos.left,
        width: dropdownPos.width,
        zIndex: 9999,
      }}
    >
      {/* Single mode */}
      {mode === "single" && (
        <>
          {/* Search + Create combined row, or standalone search/create */}
          {searchable && onCreateClick ? (
            <div className="flex items-center gap-1 border-b border-slate-200/70 px-2 pt-2 pb-1">
              <input
                data-search
                value={search}
                onChange={e => { setSearch(e.target.value); setFocusedIndex(0); }}
                className="h-7 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="搜索..."
              />
              <button
                type="button"
                onClick={handleCreateClick}
                className="secondary-button h-7 shrink-0 gap-0.5 px-2 text-xs text-blue-700 hover:bg-blue-50"
              >
                <Plus className="w-3 h-3" />
                {createLabel ?? "新增"}
              </button>
            </div>
          ) : searchable ? (
            <div className="border-b border-slate-200/70 px-2 pt-2 pb-1">
              <input
                data-search
                value={search}
                onChange={e => { setSearch(e.target.value); setFocusedIndex(0); }}
                className="h-7 w-full rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="搜索..."
              />
            </div>
          ) : onCreateClick ? (
            <button
              type="button"
              onClick={handleCreateClick}
              className="flex h-9 w-full items-center justify-between border-b border-slate-200/70 bg-slate-50/90 px-3 text-sm transition-colors hover:bg-blue-50/70"
            >
              <span className="text-slate-500">{placeholder || "请选择"}</span>
              <span className="flex items-center gap-1 font-medium text-blue-700">
                <Plus className="w-3.5 h-3.5" />
                {createLabel ?? "新增"}
              </span>
            </button>
          ) : null}
          {/* Options list with collapsible groups */}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="overflow-y-auto max-h-[240px]"
          >
            {visible.map((o, i) => {
              // Root group header (isHeader) is only a group label, never a selected value.
              if (o.isHeader) {
                return (
                  <div
                    key={o.id}
                    className={`flex h-8 w-full items-center justify-between px-3 text-xs font-medium transition-colors ${
                      i === focusedIndex
                          ? "bg-blue-50 text-blue-700"
                          : "hover:bg-slate-50"
                    }`}
                    onMouseEnter={() => setFocusedIndex(i)}
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(o.id)}
                      className="min-w-0 flex flex-1 items-center gap-1 text-left text-slate-600"
                    >
                      {collapsedGroups.has(o.id) && !isSearching
                        ? <ChevronRight className="w-3 h-3 shrink-0" />
                        : <ChevronDown className="w-3 h-3 shrink-0" />
                      }
                      <span className="truncate">{o.label}</span>
                    </button>
                    {!isSearching && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(o.id)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/80 hover:text-slate-600"
                      >
                        {groupChildCounts.get(o.id) ?? 0}
                      </button>
                    )}
                  </div>
                );
              }

              // Mid-level group (isGroup) — selectable AND collapsible
              if (o.isGroup) {
                const isSelected = o.id === (value as string);
                const isCollapsed = collapsedGroups.has(o.id) && !isSearching;
                const childCount = groupChildCounts.get(o.id) ?? 0;
                return (
                  <button
                    key={o.id}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => selectSingle(o.id)}
                    onMouseEnter={() => setFocusedIndex(i)}
                    className={`flex h-9 w-full items-center gap-1.5 px-3 text-left text-sm transition-colors ${
                      i === focusedIndex ? "bg-blue-50" : ""
                    } ${isSelected ? "font-medium text-blue-700" : "text-slate-700"}`}
                  >
                    {/* Collapse toggle area */}
                    <span
                      onClick={(e) => { e.stopPropagation(); toggleGroup(o.id); }}
                      className="flex shrink-0 cursor-pointer items-center gap-0.5 text-slate-400 hover:text-slate-600"
                    >
                      {isCollapsed
                        ? <ChevronRight className="w-3 h-3" />
                        : <ChevronDown className="w-3 h-3" />
                      }
                      <span className="text-[10px]">{childCount}</span>
                    </span>
                    {/* Selectable label — click selects this item */}
                    <span
                      className="truncate flex-1 cursor-pointer"
                    >
                      {o.label}
                    </span>
                    {o.subLabel && (
                      <span className="shrink-0 text-[10px] text-slate-400">{o.subLabel}</span>
                    )}
                  </button>
                );
              }

              // Regular selectable item
              return (
                <button
                  key={o.id}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={o.id === (value as string)}
                  onClick={() => selectSingle(o.id)}
                  onMouseEnter={() => setFocusedIndex(i)}
                  className={`flex h-9 w-full items-center gap-1.5 px-3 text-left text-sm transition-colors ${
                    i === focusedIndex ? "bg-blue-50" : ""
                  } ${
                    o.id === (value as string) ? "font-medium text-blue-700" : "text-slate-700"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {o.subLabel && (
                    <span className="shrink-0 text-[10px] text-slate-400">{o.subLabel}</span>
                  )}
                </button>
              );
            })}
            {visible.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                {search ? `无匹配"${search}"的结果` : "暂无选项"}
              </div>
            )}
          </div>
        </>
      )}

      {/* Multi mode */}
      {mode === "multi" && (
        <>
          {/* Search input */}
          {searchable && (
            <div className="px-2 pt-2 pb-1 border-b border-foreground/5">
              <input
                data-search
                value={search}
                onChange={e => { setSearch(e.target.value); setFocusedIndex(0); }}
                className="h-7 w-full rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="搜索标签..."
              />
            </div>
          )}
          {/* Inline create area or create button */}
          {!showNew ? (
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="flex h-9 w-full items-center justify-between border-b border-slate-200/70 bg-slate-50/90 px-3 text-sm transition-colors hover:bg-blue-50/70"
            >
              <span className="text-slate-500">{placeholder || "选择标签"}</span>
              <span className="flex items-center gap-1 font-medium text-blue-700">
                <Plus className="w-3.5 h-3.5" />
                新增
              </span>
            </button>
          ) : (
            <div className="space-y-2 border-b border-slate-200/70 bg-blue-50/60 px-3 py-2">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.stopPropagation(); createTag(); }
                    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
                      e.stopPropagation();
                    }
                  }}
                  className="h-8 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder="标签名称"
                />
                <button
                  onClick={createTag}
                  disabled={!newName.trim() || creating}
                  className="primary-button h-8 px-3 text-sm disabled:opacity-50"
                >
                  {creating ? "…" : "创建"}
                </button>
                <button
                  onClick={() => { setShowNew(false); setNewName(""); }}
                  className="secondary-button h-8 w-8 px-0 text-slate-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {/* Color picker */}
              <div className="flex gap-1.5">
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full border-2 transition-colors ${newColor === c ? "border-foreground scale-110" : "border-transparent"}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          )}
          {/* Options list with checkboxes */}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="overflow-y-auto max-h-[240px]"
          >
            {filtered.map((o, i) => {
              const checked = (value as string[]).includes(o.id);
              const c = o.color || "#7BA05B";
              return (
                <button
                  key={o.id}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => toggleMulti(o.id)}
                  onMouseEnter={() => setFocusedIndex(i)}
                  className={`flex h-9 w-full items-center gap-2 px-3 text-left text-sm transition-colors ${
                    i === focusedIndex ? "bg-blue-50" : ""
                  } ${
                    checked ? "font-medium" : ""
                  }`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    checked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-surface-white"
                  }`}>
                    {checked && <Check className="w-3 h-3" />}
                  </span>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c }} />
                  <span className="text-slate-700">{o.label}</span>
                </button>
              );
            })}
            {filtered.length === 0 && !showNew && (
              <div className="px-3 py-4 text-center text-xs text-slate-400">暂无标签，点击上方"新增"创建</div>
            )}
          </div>
        </>
      )}
    </div>
  );

  /* ---- Render ---- */

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpenToggle}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && focusedIndex >= 0 ? `${listId}-${focusedIndex}` : undefined}
        className="flex h-9 w-full items-center justify-between rounded-[10px] border border-slate-300/70 bg-surface-white px-3 text-sm outline-none transition-colors hover:border-slate-400/60 focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-100"
      >
        {mode === "single" ? (
          <span className={`${selectedLabel ? "text-slate-800" : "text-slate-400"} flex truncate items-center`}>
            {selectedLabel || placeholder || "请选择"}
            {selectedOption?.subLabel && (
              <span className="ml-1 shrink-0 text-[10px] text-slate-400">{selectedOption.subLabel}</span>
            )}
          </span>
        ) : (
          <MultiTriggerDisplay
            value={value as string[]}
            options={options}
            placeholder={placeholder}
          />
        )}
        {mode === "single" && (value as string) ? (
          <span className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); (onChange as (id: string) => void)(""); }}
              className="text-slate-300 transition-colors hover:text-slate-500"
              tabIndex={-1}
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </span>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
      </button>

      {/* Dropdown rendered via portal so it doesn't overflow parent container */}
      {open && createPortal(dropdownContent, document.body)}
    </>
  );
}

/* ---- Multi trigger display sub-component ---- */

function MultiTriggerDisplay({
  value,
  options,
  placeholder,
}: {
  value: string[];
  options: SmartSelectOption[];
  placeholder?: string;
}) {
  const selected = options.filter(o => value.includes(o.id));

  if (selected.length === 0) {
    return <span className="text-slate-400">{placeholder || "选择标签"}</span>;
  }

  return (
    <span className="flex items-center gap-1.5 truncate min-w-0">
      {selected.slice(0, 4).map(o => (
        <span
          key={o.id}
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: o.color || "#7BA05B" }}
        />
      ))}
      {selected.length > 4 && (
        <span className="shrink-0 text-xs text-slate-500">+{selected.length - 4}</span>
      )}
      <span className="shrink-0 text-xs text-slate-500">{selected.length}</span>
    </span>
  );
}

/* ---- useId polyfill for stable ARIA IDs ---- */
let _idCounter = 0;
function useId(): string {
  const [id] = useState(() => `ss-${++_idCounter}`);
  return id;
}
