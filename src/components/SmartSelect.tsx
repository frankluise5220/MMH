"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Repeat,
  X,
} from "lucide-react";

export type SmartSelectOption = {
  /** Selectable option IDs should be real entity IDs. Use synthetic IDs only for non-selectable headers/groups. */
  id: string;
  label: string;
  subLabel?: string;
  color?: string | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
};

const SMART_SELECT_CREATED_EVENT = "mmh:smart-select:created";

function mergeSmartSelectOptions(base: SmartSelectOption[], extra: SmartSelectOption[]) {
  const merged = [...base];
  const seen = new Set(merged.map((option) => option.id));
  for (const option of extra) {
    if (!seen.has(option.id)) {
      merged.push(option);
      seen.add(option.id);
    }
  }
  return merged;
}

export function notifySmartSelectOptionCreated(option: SmartSelectOption) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SmartSelectOption>(SMART_SELECT_CREATED_EVENT, { detail: option }));
}

type SearchBehavior = boolean | "auto";
type HierarchyBehavior = boolean | "auto";

type SmartSelectSharedBehavior = {
  search?: SearchBehavior;
  hierarchy?: HierarchyBehavior;
  collapsibleGroups?: boolean;
  clearable?: boolean;
  cycleSelectionWithArrowKeys?: boolean;
  headerExtra?: ReactNode;
  minDropdownWidth?: number;
};

type SmartSelectSingleBehavior = SmartSelectSharedBehavior & {
  create?: {
    type: "button";
    onClick: () => void;
    label?: string;
  };
};

type SmartSelectMultiBehavior = SmartSelectSharedBehavior & {
  create?: {
    type: "inline";
    onCreate: (name: string, color: string) => Promise<SmartSelectOption>;
    onCreated?: (tag: SmartSelectOption) => void;
    buttonLabel?: string;
  };
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
  headerExtra?: ReactNode;
  onCycleOwnerFilter?: () => void;
  ownerFilterLabel?: string;
  behavior?: SmartSelectSingleBehavior;
};

type MultiModeProps = {
  mode: "multi";
  value: string[];
  onChange: (ids: string[]) => void;
  options: SmartSelectOption[];
  placeholder?: string;
  onInlineCreate?: (name: string, color: string) => Promise<SmartSelectOption>;
  onCreated?: (tag: SmartSelectOption) => void;
  behavior?: SmartSelectMultiBehavior;
};

export type SmartSelectProps = SingleModeProps | MultiModeProps;

const PRESET_COLORS = [
  "#7BA05B",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F43F5E",
  "#84CC16",
  "#6366F1",
  "#14B8A6",
  "#E11D48",
  "#0EA5E9",
];

function stripIndent(label: string) {
  return label.replace(/^[\u3000\s]+/, "");
}

function optionSearchText(option: SmartSelectOption) {
  return `${stripIndent(option.label)} ${option.subLabel ?? ""}`.toLowerCase();
}

function hasHierarchy(options: SmartSelectOption[]) {
  return options.some((option) => option.isHeader || option.isGroup || option.parentId);
}

function resolveHierarchyBehavior(options: SmartSelectOption[], behavior?: HierarchyBehavior) {
  if (behavior === true) return true;
  if (behavior === false) return false;
  return hasHierarchy(options);
}

function resolveSearchBehavior(
  options: SmartSelectOption[],
  behavior: SearchBehavior | undefined,
  hierarchy: boolean,
) {
  if (behavior === true) return true;
  if (behavior === false) return false;
  if (hierarchy) return true;
  return options.length > 10;
}

function filterFlatOptions(options: SmartSelectOption[], search: string) {
  if (!search.trim()) return options;
  const q = search.trim().toLowerCase();
  return options.filter((option) => optionSearchText(option).includes(q));
}

function filterWithGroups(options: SmartSelectOption[], search: string) {
  if (!search.trim()) return options;
  const q = search.trim().toLowerCase();
  const optionById = new Map(options.map((option) => [option.id, option]));
  const matchedIds = new Set<string>();
  const keepIds = new Set<string>();

  for (const option of options) {
    if (option.isHeader) continue;
    if (optionSearchText(option).includes(q)) {
      matchedIds.add(option.id);
      keepIds.add(option.id);
    }
  }

  for (const id of matchedIds) {
    let current = optionById.get(id);
    while (current?.parentId) {
      keepIds.add(current.parentId);
      current = optionById.get(current.parentId);
    }
  }

  return options.filter((option) => keepIds.has(option.id));
}

function buildGroupChildCounts(options: SmartSelectOption[]) {
  const counts = new Map<string, number>();
  for (const option of options) {
    if (!option.parentId || option.isHeader) continue;
    counts.set(option.parentId, (counts.get(option.parentId) ?? 0) + 1);
  }
  return counts;
}

function initialCollapsedGroups(
  options: SmartSelectOption[],
  selectedValue: string,
  enabled: boolean,
) {
  const collapsed = new Set<string>();
  if (!enabled) return collapsed;

  for (const option of options) {
    if (option.isGroup) collapsed.add(option.id);
  }

  if (!selectedValue) return collapsed;

  const optionById = new Map(options.map((option) => [option.id, option]));
  let current = optionById.get(selectedValue);
  while (current?.parentId) {
    collapsed.delete(current.parentId);
    current = optionById.get(current.parentId);
  }
  return collapsed;
}

function hasCollapsedAncestor(
  option: SmartSelectOption,
  collapsedGroups: Set<string>,
  optionById: Map<string, SmartSelectOption>,
) {
  let parentId = option.parentId;
  while (parentId) {
    if (collapsedGroups.has(parentId)) return true;
    parentId = optionById.get(parentId)?.parentId;
  }
  return false;
}

function buildVisibleOptions(
  filtered: SmartSelectOption[],
  collapsedGroups: Set<string>,
  forceExpanded: boolean,
  hierarchy: boolean,
) {
  if (!hierarchy || forceExpanded) return filtered;
  const optionById = new Map(filtered.map((option) => [option.id, option]));
  return filtered.filter((option) => !hasCollapsedAncestor(option, collapsedGroups, optionById));
}

function findInitialFocusedIndex(
  visible: SmartSelectOption[],
  mode: "single" | "multi",
  value: string | string[],
  preferredIndex?: "first" | "last",
) {
  if (visible.length === 0) return -1;
  if (preferredIndex === "first") return 0;
  if (preferredIndex === "last") return visible.length - 1;
  if (mode === "single") {
    const selectedIndex = visible.findIndex((option) => option.id === value);
    return selectedIndex >= 0 ? selectedIndex : 0;
  }
  return 0;
}

function isSelectable(option: SmartSelectOption) {
  return !option.isHeader;
}

function normalizeSingleBehavior(props: SingleModeProps, options: SmartSelectOption[]) {
  const behavior = props.behavior;
  const legacyCycleButton = props.onCycleOwnerFilter ? (
    <button
      type="button"
      onClick={props.onCycleOwnerFilter}
      title={`所有人：${props.ownerFilterLabel || "全部"}`}
      aria-label={`切换所有人，当前 ${props.ownerFilterLabel || "全部"}`}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
    >
      <Repeat className="h-3 w-3" />
    </button>
  ) : undefined;

  return {
    hierarchy: resolveHierarchyBehavior(options, behavior?.hierarchy),
    searchable: resolveSearchBehavior(
      options,
      behavior?.search ?? props.searchable,
      resolveHierarchyBehavior(options, behavior?.hierarchy),
    ),
    collapsibleGroups: behavior?.collapsibleGroups ?? true,
    clearable: behavior?.clearable ?? true,
    cycleSelectionWithArrowKeys: behavior?.cycleSelectionWithArrowKeys ?? true,
    headerExtra: behavior?.headerExtra ?? props.headerExtra ?? legacyCycleButton,
    minDropdownWidth: behavior?.minDropdownWidth,
    create: behavior?.create ?? (props.onCreateClick
      ? {
          type: "button" as const,
          onClick: props.onCreateClick,
          label: props.createLabel,
        }
      : undefined),
  };
}

function normalizeMultiBehavior(props: MultiModeProps, options: SmartSelectOption[]) {
  const behavior = props.behavior;
  return {
    hierarchy: resolveHierarchyBehavior(options, behavior?.hierarchy),
    searchable: resolveSearchBehavior(
      options,
      behavior?.search ?? false,
      resolveHierarchyBehavior(options, behavior?.hierarchy),
    ),
    collapsibleGroups: behavior?.collapsibleGroups ?? true,
    clearable: false,
    cycleSelectionWithArrowKeys: false,
    headerExtra: behavior?.headerExtra,
    minDropdownWidth: behavior?.minDropdownWidth,
    create: behavior?.create ?? (props.onInlineCreate
      ? {
          type: "inline" as const,
          onCreate: props.onInlineCreate,
          onCreated: props.onCreated,
        }
      : undefined),
  };
}

export function SmartSelect(props: SmartSelectProps) {
  const { mode, value, onChange, options, placeholder } = props;
  const [createdOptions, setCreatedOptions] = useState<SmartSelectOption[]>([]);
  const selectedCreatedOptions = useMemo(() => {
    const selectedIds = new Set(
      mode === "single"
        ? (value ? [value] : [])
        : (value as string[]),
    );
    if (selectedIds.size === 0) return [];
    return createdOptions.filter((option) => selectedIds.has(option.id));
  }, [createdOptions, mode, value]);
  const effectiveOptions = useMemo(
    () => mergeSmartSelectOptions(options, selectedCreatedOptions),
    [options, selectedCreatedOptions],
  );
  const normalizedBehavior = mode === "single"
    ? normalizeSingleBehavior(props, effectiveOptions)
    : normalizeMultiBehavior(props, effectiveOptions);

  const {
    hierarchy,
    searchable,
    collapsibleGroups,
    clearable,
    cycleSelectionWithArrowKeys,
    headerExtra,
    minDropdownWidth,
    create,
  } = normalizedBehavior;

  const isSingleCreateButton = mode === "single" && create?.type === "button" ? create : undefined;
  const isMultiInlineCreate = mode === "multi" && create?.type === "inline" ? create : undefined;

  const listId = useId();
  const selectedOption = mode === "single"
    ? effectiveOptions.find((option) => option.id === value)
    : undefined;
  const selectedLabel = selectedOption ? stripIndent(selectedOption.label) : "";
  const groupChildCounts = useMemo(() => buildGroupChildCounts(effectiveOptions), [effectiveOptions]);
  const selectableOptions = useMemo(() => effectiveOptions.filter(isSelectable), [effectiveOptions]);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });

  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const inlineCreateInputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!searchable) return effectiveOptions;
    return hierarchy ? filterWithGroups(effectiveOptions, search) : filterFlatOptions(effectiveOptions, search);
  }, [effectiveOptions, hierarchy, search, searchable]);

  const visible = useMemo(
    () => buildVisibleOptions(filtered, collapsedGroups, search.trim().length > 0, hierarchy),
    [collapsedGroups, filtered, hierarchy, search],
  );

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setSearch("");
    setShowNew(false);
    setFocusedIndex(-1);
  }, []);

  const calcPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const minWidth = Math.max(isSingleCreateButton ? 300 : 0, minDropdownWidth ?? 0);
    const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const estimatedHeight = (searchable ? 42 : 0)
      + ((isSingleCreateButton || isMultiInlineCreate) ? 42 : 0)
      + Math.min(visible.length || effectiveOptions.length || 1, 7) * 36
      + 16;
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const openAbove = below < estimatedHeight && above > below;
    const top = openAbove
      ? Math.max(8, rect.top - estimatedHeight - 4)
      : rect.bottom + 4;
    setDropdownPos({ top, left, width });
  }, [effectiveOptions.length, isMultiInlineCreate, isSingleCreateButton, minDropdownWidth, searchable, visible.length]);

  const openDropdown = useCallback((preferredIndex?: "first" | "last") => {
    const nextCollapsed = initialCollapsedGroups(
      effectiveOptions,
      mode === "single" ? value : "",
      hierarchy && collapsibleGroups,
    );
    const nextFiltered = searchable
      ? (hierarchy ? filterWithGroups(effectiveOptions, "") : filterFlatOptions(effectiveOptions, ""))
      : effectiveOptions;
    const nextVisible = buildVisibleOptions(nextFiltered, nextCollapsed, false, hierarchy);

    setCollapsedGroups(nextCollapsed);
    setSearch("");
    setShowNew(false);
    setOpen(true);
    setFocusedIndex(findInitialFocusedIndex(nextVisible, mode, value, preferredIndex));
    window.requestAnimationFrame(() => calcPosition());
  }, [calcPosition, collapsibleGroups, effectiveOptions, hierarchy, mode, searchable, value]);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => calcPosition();
    const handleResize = () => calcPosition();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [calcPosition, open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return;
      if (dropdownRef.current?.contains(event.target as Node)) return;
      closeDropdown();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeDropdown, open]);

  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    const listNode = listRef.current;
    const row = listNode?.children[focusedIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, open]);

  useEffect(() => {
    if (!showNew) return;
    inlineCreateInputRef.current?.focus();
  }, [showNew]);

  useEffect(() => {
    if (!open || !searchable) return;
    const input = dropdownRef.current?.querySelector<HTMLInputElement>("input[data-search]");
    input?.focus();
  }, [open, searchable]);

  useEffect(() => {
    const handleCreated = (event: Event) => {
      const option = (event as CustomEvent<SmartSelectOption>).detail;
      if (!option?.id || !option.label) return;
      setCreatedOptions((prev) => mergeSmartSelectOptions(prev, [option]));
    };
    window.addEventListener(SMART_SELECT_CREATED_EVENT, handleCreated);
    return () => window.removeEventListener(SMART_SELECT_CREATED_EVENT, handleCreated);
  }, []);

  function selectSingle(id: string) {
    (onChange as (id: string) => void)(id);
    closeDropdown();
  }

  function toggleMulti(id: string) {
    const current = value as string[];
    const next = current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id];
    (onChange as (ids: string[]) => void)(next);
  }

  async function createInlineOption() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      if (isMultiInlineCreate) {
        const newOption = await isMultiInlineCreate.onCreate(newName.trim(), newColor);
        setCreatedOptions((prev) => mergeSmartSelectOptions(prev, [newOption]));
        toggleMulti(newOption.id);
        isMultiInlineCreate.onCreated?.(newOption);
      } else {
        const res = await fetch("/api/v1/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName.trim(), color: newColor }),
        });
        const data = await res.json();
        if (!data.ok || !data.tag) {
          window.alert(data.error ?? "创建失败");
          return;
        }
        const newOption: SmartSelectOption = {
          id: data.tag.id,
          label: data.tag.name,
          color: data.tag.color,
        };
        toggleMulti(newOption.id);
      }
      setNewName("");
      setShowNew(false);
    } catch {
      window.alert("网络错误");
    } finally {
      setCreating(false);
    }
  }

  function handleDropdownKeyDown(event: React.KeyboardEvent) {
    const total = visible.length;
    if (total === 0 && event.key !== "Tab") return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusedIndex((prev) => (prev + 1 < total ? prev + 1 : 0));
        return;
      case "ArrowUp":
        event.preventDefault();
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : total - 1));
        return;
      case "Home":
        event.preventDefault();
        setFocusedIndex(0);
        return;
      case "End":
        event.preventDefault();
        setFocusedIndex(total - 1);
        return;
      case "Enter": {
        event.preventDefault();
        if (search.trim() && visible.length === 1) {
          const only = visible[0];
          if (only.isHeader) return;
          if (only.isGroup && hierarchy && collapsibleGroups) {
            toggleGroup(only.id);
            return;
          }
          if (mode === "single") selectSingle(only.id);
          else toggleMulti(only.id);
          return;
        }
        if (focusedIndex < 0 || focusedIndex >= total) return;
        const focused = visible[focusedIndex];
        if (focused.isHeader) {
          if (hierarchy && collapsibleGroups) toggleGroup(focused.id);
          return;
        }
        if (focused.isGroup && hierarchy && collapsibleGroups) {
          toggleGroup(focused.id);
          return;
        }
        if (mode === "single") selectSingle(focused.id);
        else toggleMulti(focused.id);
        return;
      }
      case "Escape":
        event.preventDefault();
        closeDropdown();
        return;
      case "Tab":
        closeDropdown();
        return;
      default:
        return;
    }
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!open && mode === "single" && cycleSelectionWithArrowKeys) {
      const currentIndex = selectableOptions.findIndex((option) => option.id === value);
      const selectByIndex = (index: number) => {
        const next = selectableOptions[index];
        if (next) (onChange as (id: string) => void)(next.id);
      };

      switch (event.key) {
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          if (selectableOptions.length > 0) {
            selectByIndex(currentIndex >= 0 ? (currentIndex + 1) % selectableOptions.length : 0);
          }
          return;
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          if (selectableOptions.length > 0) {
            selectByIndex(
              currentIndex >= 0
                ? (currentIndex - 1 + selectableOptions.length) % selectableOptions.length
                : selectableOptions.length - 1,
            );
          }
          return;
        case "Home":
          event.preventDefault();
          if (selectableOptions.length > 0) selectByIndex(0);
          return;
        case "End":
          event.preventDefault();
          if (selectableOptions.length > 0) selectByIndex(selectableOptions.length - 1);
          return;
      }
    }

    if (!open) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDropdown("first");
      }
      return;
    }

    if (!searchable) handleDropdownKeyDown(event);
  }

  const dropdown = (
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
      {mode === "single" ? (
        <>
          {(searchable || isSingleCreateButton || headerExtra) ? (
            <div className="flex items-center gap-1 border-b border-slate-200/70 px-2 pt-2 pb-1">
              {searchable ? (
                <input
                  data-search
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setFocusedIndex(0);
                  }}
                  className="h-7 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder="搜索..."
                />
              ) : (
                <div className="flex-1" />
              )}
              {isSingleCreateButton ? (
                <button
                  type="button"
                  onClick={() => {
                    closeDropdown();
                    isSingleCreateButton.onClick();
                  }}
                  title={isSingleCreateButton.label ?? "新增"}
                  aria-label={isSingleCreateButton.label ?? "新增"}
                  className="secondary-button !px-0 h-7 w-7 shrink-0 text-blue-600 hover:bg-blue-50"
                >
                  <Plus className="h-[18px] w-[18px]" />
                </button>
              ) : null}
              {headerExtra}
            </div>
          ) : null}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="max-h-[240px] overflow-y-auto"
          >
            {visible.map((option, index) => {
              if (option.isHeader) {
                const collapsed = collapsedGroups.has(option.id) && search.trim().length === 0;
                return (
                  <div
                    key={option.id}
                    className={`flex h-8 w-full items-center justify-between px-3 text-xs font-medium transition-colors ${
                      index === focusedIndex ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"
                    }`}
                    onMouseEnter={() => setFocusedIndex(index)}
                  >
                    <button
                      type="button"
                      onClick={() => hierarchy && collapsibleGroups && toggleGroup(option.id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-0.5 text-left text-slate-600"
                    >
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded">
                        {hierarchy && collapsibleGroups ? (
                          collapsed
                            ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                            : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                        ) : null}
                      </span>
                      <span className="truncate">{option.label}</span>
                    </button>
                    {!search.trim() && hierarchy ? (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-slate-400">
                        {groupChildCounts.get(option.id) ?? 0}
                      </span>
                    ) : null}
                  </div>
                );
              }

              if (option.isGroup) {
                const selected = option.id === value;
                const collapsed = collapsedGroups.has(option.id) && search.trim().length === 0;
                return (
                  <button
                    key={option.id}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => selectSingle(option.id)}
                    onMouseEnter={() => setFocusedIndex(index)}
                    className={`flex h-9 w-full items-center gap-1.5 px-3 text-left text-sm transition-colors ${
                      index === focusedIndex ? "bg-blue-50" : ""
                    } ${selected ? "font-medium text-blue-700" : "text-slate-700"}`}
                  >
                    <span
                      onClick={(event) => {
                        event.stopPropagation();
                        if (hierarchy && collapsibleGroups) toggleGroup(option.id);
                      }}
                      className="flex shrink-0 cursor-pointer items-center gap-1 px-0.5 text-slate-400 hover:text-slate-600"
                    >
                      {hierarchy && collapsibleGroups ? (
                        <>
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded">
                            {collapsed ? (
                              <ChevronRight className="h-4 w-4" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                          </span>
                          <span className="text-[10px]">{groupChildCounts.get(option.id) ?? 0}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="flex-1 truncate">{option.label}</span>
                    {option.subLabel ? (
                      <span className="shrink-0 text-[10px] text-slate-400">{option.subLabel}</span>
                    ) : null}
                  </button>
                );
              }

              const selected = option.id === value;
              return (
                <button
                  key={option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectSingle(option.id)}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={`flex h-9 w-full items-center gap-1.5 px-3 text-left text-sm transition-colors ${
                    index === focusedIndex ? "bg-blue-50" : ""
                  } ${selected ? "font-medium text-blue-700" : "text-slate-700"}`}
                >
                  <span className="truncate">{option.label}</span>
                  {option.subLabel ? (
                    <span className="shrink-0 text-[10px] text-slate-400">{option.subLabel}</span>
                  ) : null}
                </button>
              );
            })}
            {visible.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                {search ? `没有匹配“${search}”的选项` : "暂无选项"}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {searchable ? (
            <div className="border-b border-slate-200/70 px-2 pt-2 pb-1">
              <input
                data-search
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setFocusedIndex(0);
                }}
                className="h-7 w-full rounded-[8px] border border-slate-300/70 bg-white px-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="搜索..."
              />
            </div>
          ) : null}

          {isMultiInlineCreate ? (
            !showNew ? (
              <button
                type="button"
                onClick={() => setShowNew(true)}
                title={isMultiInlineCreate.buttonLabel ?? "新增"}
                aria-label={isMultiInlineCreate.buttonLabel ?? "新增"}
                className="flex h-9 w-full items-center justify-between border-b border-slate-200/70 bg-slate-50/90 px-3 text-sm transition-colors hover:bg-blue-50/70"
              >
                <span className="text-slate-500">{placeholder || "选择标签"}</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-blue-50/80 text-blue-700">
                  <Plus className="h-[18px] w-[18px]" />
                </span>
              </button>
            ) : (
              <div className="space-y-2 border-b border-slate-200/70 bg-blue-50/60 px-3 py-2">
                <div className="flex gap-2">
                  <input
                    ref={inlineCreateInputRef}
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.stopPropagation();
                        void createInlineOption();
                      }
                      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                        event.stopPropagation();
                      }
                    }}
                    className="h-8 flex-1 rounded-[8px] border border-slate-300/70 bg-white px-2 text-sm outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder="标签名称"
                  />
                  <button
                    type="button"
                    onClick={() => void createInlineOption()}
                    disabled={!newName.trim() || creating}
                    className="primary-button h-8 px-3 text-sm disabled:opacity-50"
                  >
                    {creating ? "..." : "创建"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNew(false);
                      setNewName("");
                    }}
                    className="secondary-button h-8 w-8 px-0 text-slate-400"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewColor(color)}
                      className={`h-5 w-5 rounded-full border-2 transition-colors ${
                        newColor === color ? "scale-110 border-foreground" : "border-transparent"
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            )
          ) : null}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="max-h-[240px] overflow-y-auto"
          >
            {visible.map((option, index) => {
              const checked = (value as string[]).includes(option.id);
              const color = option.color || PRESET_COLORS[0];
              return (
                <button
                  key={option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => toggleMulti(option.id)}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={`flex h-9 w-full items-center gap-2 px-3 text-left text-sm transition-colors ${
                    index === focusedIndex ? "bg-blue-50" : ""
                  } ${checked ? "font-medium" : ""}`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    checked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-surface-white"
                  }`}>
                    {checked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate text-slate-700">{option.label}</span>
                </button>
              );
            })}
            {visible.length === 0 && !showNew ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">暂无选项</div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <div
        ref={triggerRef}
        role="button"
        tabIndex={0}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && focusedIndex >= 0 ? `${listId}-${focusedIndex}` : undefined}
        className="flex h-9 w-full items-center justify-between rounded-[10px] border border-slate-300/70 bg-surface-white px-3 text-sm outline-none transition-colors hover:border-slate-400/60 focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-100"
      >
        {mode === "single" ? (
          <span className={`${selectedLabel ? "text-slate-800" : "text-slate-400"} flex min-w-0 items-center truncate`}>
            {selectedLabel || placeholder || "请选择"}
            {selectedOption?.subLabel ? (
              <span className="ml-1 shrink-0 text-[10px] text-slate-400">{selectedOption.subLabel}</span>
            ) : null}
          </span>
        ) : (
          <MultiTriggerDisplay
            value={value as string[]}
            options={effectiveOptions}
            placeholder={placeholder}
          />
        )}
        {mode === "single" && value && clearable ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                (onChange as (id: string) => void)("");
              }}
              className="text-slate-300 transition-colors hover:text-slate-500"
              tabIndex={-1}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </span>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
      </div>
      {open ? createPortal(dropdown, document.body) : null}
    </>
  );
}

function MultiTriggerDisplay({
  value,
  options,
  placeholder,
}: {
  value: string[];
  options: SmartSelectOption[];
  placeholder?: string;
}) {
  const selected = options.filter((option) => value.includes(option.id));

  if (selected.length === 0) {
    return <span className="text-slate-400">{placeholder || "请选择"}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {selected.slice(0, 3).map((option) => (
        <span
          key={option.id}
          className="inline-flex min-w-0 max-w-[120px] items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
          style={{
            backgroundColor: `${option.color || PRESET_COLORS[0]}18`,
            borderColor: `${option.color || PRESET_COLORS[0]}60`,
            color: option.color || PRESET_COLORS[0],
          }}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: option.color || PRESET_COLORS[0] }}
          />
          <span className="truncate">{option.label}</span>
        </span>
      ))}
      {selected.length > 3 ? (
        <span className="shrink-0 text-xs text-slate-500">+{selected.length - 3}</span>
      ) : null}
    </span>
  );
}
