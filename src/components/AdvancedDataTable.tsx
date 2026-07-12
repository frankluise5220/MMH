"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, GripVertical, SlidersHorizontal } from "lucide-react";
import { DateRangeColumnFilter, TableColumnFilter } from "./TableColumnFilter";
import { useI18n } from "@/lib/i18n";

const HORIZONTAL_SCROLL_TOLERANCE_PX = 4;

export type AdvancedDataTableColumn<T> = {
  key: string;
  label: ReactNode;
  width: number;
  minWidth?: number;
  align?: "left" | "center" | "right";
  hideable?: boolean;
  defaultHidden?: boolean;
  className?: string;
  headerClassName?: string;
  filterText?: (row: T) => string;
  sortValue?: (row: T) => string | number | null | undefined;
  filterKind?: "multi" | "dateRange";
  render: (row: T, index: number) => ReactNode;
};

export type AdvancedDataTableBatchAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type AdvancedDataTableSummaryRow = {
  cells: Readonly<Record<string, ReactNode | undefined>>;
  selectCell?: ReactNode;
  rowClassName?: string;
  cellClassName?: string;
};

export type AdvancedDataTableDropPosition = "before" | "after";

type RowItem<T> = {
  row: T;
  index: number;
  key: string;
};

function reorderRowItems<T>(items: RowItem<T>[], sourceKey: string, targetKey: string, position: AdvancedDataTableDropPosition) {
  const sourceIndex = items.findIndex((item) => item.key === sourceKey);
  const targetIndex = items.findIndex((item) => item.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const next = [...items];
  const [moving] = next.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((item) => item.key === targetKey);
  if (targetIndexAfterRemoval < 0) return items;
  next.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
  return next.every((item, index) => item.key === items[index]?.key) ? items : next;
}

export type AdvancedDataTableProps<T> = {
  storageKey: string;
  columns: AdvancedDataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  emptyText?: ReactNode;
  minTableWidth?: number;
  rowClassName?: (row: T, index: number) => string;
  onRowClick?: (row: T, index: number) => void;
  onRowDoubleClick?: (row: T, index: number) => void;
  draggableRows?: boolean;
  rowDragDisabled?: (row: T, index: number) => boolean;
  rowDropAllowed?: (sourceRow: T, targetRow: T, sourceIndex: number, targetIndex: number, position: AdvancedDataTableDropPosition) => boolean;
  onRowReorder?: (sourceRow: T, targetRow: T, sourceIndex: number, targetIndex: number, position: AdvancedDataTableDropPosition) => void | Promise<void>;
  selectable?: boolean;
  selectOnRowClick?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  batchActions?: AdvancedDataTableBatchAction[];
  batchActionSlot?: ReactNode;
  showFilters?: boolean;
  fillHeight?: boolean;
  compactRows?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarLeftContent?: ReactNode;
  toolbarRightContent?: ReactNode;
  showColumnVisibilityButton?: boolean;
  columnVisibilityTriggerId?: string;
  summaryRow?: AdvancedDataTableSummaryRow;
};

function alignClass(align?: "left" | "center" | "right") {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function labelText(label: ReactNode, fallback: string) {
  return typeof label === "string" ? label : fallback;
}

function sortFilterValue(a: string, b: string) {
  if (a === "-") return 1;
  if (b === "-") return -1;
  return a.localeCompare(b, "zh-CN", { numeric: true });
}

export function AdvancedDataTable<T>({
  storageKey,
  columns,
  rows,
  rowKey,
  emptyText = "暂无数据",
  minTableWidth,
  rowClassName,
  onRowClick,
  onRowDoubleClick,
  draggableRows = false,
  rowDragDisabled,
  rowDropAllowed,
  onRowReorder,
  selectable = false,
  selectOnRowClick = false,
  selectedKeys,
  onSelectionChange,
  batchActions = [],
  batchActionSlot,
  showFilters = true,
  fillHeight = false,
  compactRows = false,
  toolbarMode = "default",
  toolbarLeftContent,
  toolbarRightContent,
  showColumnVisibilityButton = true,
  columnVisibilityTriggerId,
  summaryRow,
}: AdvancedDataTableProps<T>) {
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const viewportRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [needsHorizontalScroll, setNeedsHorizontalScroll] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [filters, setFilters] = useState<Partial<Record<string, string[]>>>({});
  const [activeFilterColumn, setActiveFilterColumn] = useState<string | null>(null);
  const [sortState, setSortState] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);
  const [internalSelectedKeys, setInternalSelectedKeys] = useState<Set<string>>(new Set());
  const [draggedRowKey, setDraggedRowKey] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<{ key: string; position: AdvancedDataTableDropPosition } | null>(null);
  const suppressNextClickRef = useRef(false);

  const effectiveSelectedKeys = selectedKeys ?? internalSelectedKeys;
  const hiddenStorageKey = `${storageKey}:hidden:v2`;
  const defaultHiddenKeys = useMemo(
    () => columns.filter((column) => column.defaultHidden).map((column) => column.key),
    [columns],
  );

  useEffect(() => {
    setColumnWidths(readJson<Record<string, number>>(`${storageKey}:widths`, {}));
    const savedHiddenKeys = readJson<string[] | null>(hiddenStorageKey, null);
    const legacyHiddenKeys = savedHiddenKeys == null ? readJson<string[]>(`${storageKey}:hidden`, []) : [];
    setHiddenKeys(new Set(savedHiddenKeys ?? [...defaultHiddenKeys, ...legacyHiddenKeys]));
  }, [defaultHiddenKeys, hiddenStorageKey, storageKey]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewportWidth(Math.floor(node.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setNeedsHorizontalScroll(node.scrollWidth > node.clientWidth + HORIZONTAL_SCROLL_TOLERANCE_PX);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const table = node.querySelector("table");
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [columns, fillHeight, hiddenKeys, minTableWidth, selectable, viewportWidth, rows.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = columnMenuRef.current;
      if (!node || !(event.target instanceof Node) || node.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!columnVisibilityTriggerId) return;
    const onTrigger = () => setMenuOpen(true);
    window.addEventListener(columnVisibilityTriggerId, onTrigger);
    return () => window.removeEventListener(columnVisibilityTriggerId, onTrigger);
  }, [columnVisibilityTriggerId]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => !hiddenKeys.has(column.key)),
    [columns, hiddenKeys],
  );
  const filterOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    for (const column of columns) {
      if (!column.filterText) continue;
      options[column.key] = Array.from(
        new Set(rows.map((row) => column.filterText?.(row).trim() || "-")),
      ).sort(sortFilterValue);
    }
    return options;
  }, [columns, rows]);
  const filteredRows = useMemo(() => {
    if (!showFilters) return rows;
    const activeFilters = Object.entries(filters).filter(([, values]) => (values?.length ?? 0) > 0);
    if (activeFilters.length === 0) return rows;
    return rows.filter((row) => activeFilters.every(([key, values]) => {
      const column = columns.find((item) => item.key === key);
      if (!column?.filterText) return true;
      const value = column.filterText(row).trim() || "-";
      if (column.filterKind === "dateRange") {
        const [from = "", to = ""] = values ?? [];
        if (from && value < from) return false;
        if (to && value > to) return false;
        return true;
      }
      return values?.includes(value);
    }));
  }, [columns, filters, rows, showFilters]);
  const orderedRows = useMemo(() => {
    if (!sortState) return filteredRows;
    const column = columns.find((item) => item.key === sortState.key);
    const readValue = column?.sortValue ?? column?.filterText;
    if (!readValue) return filteredRows;
    return filteredRows
      .map((row, index) => ({ row, index, value: readValue(row) }))
      .sort((a, b) => {
        const aEmpty = a.value == null || a.value === "";
        const bEmpty = b.value == null || b.value === "";
        if (aEmpty || bEmpty) {
          if (aEmpty && bEmpty) return a.index - b.index;
          return aEmpty ? 1 : -1;
        }
        const compared = typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), "zh-CN", { numeric: true });
        return compared === 0
          ? a.index - b.index
          : sortState.direction === "asc" ? compared : -compared;
      })
      .map((item) => item.row);
  }, [columns, filteredRows, sortState]);
  const allRowKeys = useMemo(() => orderedRows.map((row, index) => rowKey(row, index)), [orderedRows, rowKey]);
  const rowItems = useMemo(
    () => orderedRows.map((row, index) => ({ row, index, key: rowKey(row, index) })),
    [orderedRows, rowKey],
  );
  const displayRowItems = useMemo(() => {
    if (!draggedRowKey || !dragTarget) return rowItems;
    return reorderRowItems(rowItems, draggedRowKey, dragTarget.key, dragTarget.position);
  }, [dragTarget, draggedRowKey, rowItems]);

  const layout = useMemo(() => {
    const controlWidth = selectable ? (draggableRows ? 58 : 38) : (draggableRows ? 30 : 0);
    const baseWidths = visibleColumns.map((column) => {
      const saved = columnWidths[column.key];
      const minWidth = column.minWidth ?? 52;
      const preferredWidth = Math.max(minWidth, Number.isFinite(saved) ? saved : column.width);
      return { key: column.key, minWidth, preferredWidth } as const;
    });
    const minColumnsTotal = baseWidths.reduce((sum, column) => sum + column.minWidth, 0);
    const basePreferredColumnsTotal = baseWidths.reduce((sum, column) => sum + column.preferredWidth, 0);
    const basePreferredTotal = controlWidth + basePreferredColumnsTotal;
    const preferredTotal = Math.max(minTableWidth ?? 0, basePreferredTotal);
    const preferredScale =
      basePreferredColumnsTotal > 0 && preferredTotal > basePreferredTotal
        ? Math.max(0, preferredTotal - controlWidth) / basePreferredColumnsTotal
        : 1;
    const preferredWidths = baseWidths.map((column) => ({
      ...column,
      preferredWidth: Math.max(column.minWidth, column.preferredWidth * preferredScale),
    }));
    const preferredColumnsTotal = preferredWidths.reduce((sum, column) => sum + column.preferredWidth, 0);
    const minTotal = controlWidth + minColumnsTotal;
    const availableWidth = viewportWidth || preferredTotal;

    if (availableWidth >= controlWidth + preferredColumnsTotal) {
      const availableColumnWidth = Math.max(0, availableWidth - controlWidth);
      const growScale = preferredColumnsTotal > 0 ? availableColumnWidth / preferredColumnsTotal : 1;
      return {
        tableWidth: availableWidth,
        controlWidth,
        colWidths: Object.fromEntries(
          preferredWidths.map((column) => [column.key, column.preferredWidth * growScale]),
        ),
      };
    }

    if (availableWidth >= minTotal) {
      const availableColumnWidth = Math.max(0, availableWidth - controlWidth);
      const shrinkNeeded = Math.max(0, preferredColumnsTotal - availableColumnWidth);
      const shrinkCapacity = preferredWidths.reduce(
        (sum, column) => sum + Math.max(0, column.preferredWidth - column.minWidth),
        0,
      );
      return {
        tableWidth: availableWidth,
        controlWidth,
        colWidths: Object.fromEntries(
          preferredWidths.map((column) => {
            if (shrinkCapacity <= 0) return [column.key, column.minWidth];
            const capacity = Math.max(0, column.preferredWidth - column.minWidth);
            return [column.key, column.preferredWidth - shrinkNeeded * (capacity / shrinkCapacity)];
          }),
        ),
      };
    }

    return {
      tableWidth: minTotal,
      controlWidth,
      colWidths: Object.fromEntries(baseWidths.map((column) => [column.key, column.minWidth])),
    };
  }, [columnWidths, draggableRows, minTableWidth, selectable, viewportWidth, visibleColumns]);

  const setSelection = useCallback((next: Set<string>) => {
    if (onSelectionChange) onSelectionChange(next);
    else setInternalSelectedKeys(next);
  }, [onSelectionChange]);

  const setColumnWidth = useCallback((key: string, width: number, minWidth: number) => {
    setColumnWidths((prev) => {
      const next = { ...prev, [key]: Math.max(minWidth, Math.round(width)) };
      writeJson(`${storageKey}:widths`, next);
      return next;
    });
  }, [storageKey]);

  const beginResize = useCallback((event: ReactMouseEvent, column: AdvancedDataTableColumn<T>) => {
    event.preventDefault();
    event.stopPropagation();
    const minWidth = column.minWidth ?? 52;
    const startX = event.clientX;
    const startWidth = layout.colWidths[column.key] ?? columnWidths[column.key] ?? column.width;
    const onMove = (moveEvent: MouseEvent) => {
      setColumnWidth(column.key, startWidth + moveEvent.clientX - startX, minWidth);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [columnWidths, layout.colWidths, setColumnWidth]);

  function toggleColumn(key: string) {
    const column = columns.find((item) => item.key === key);
    if (!column?.hideable) return;
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeJson(hiddenStorageKey, Array.from(next));
      return next;
    });
  }

  function toggleAllRows(checked: boolean) {
    setSelection(checked ? new Set(allRowKeys) : new Set());
  }

  function toggleRow(key: string, checked: boolean) {
    const next = new Set(effectiveSelectedKeys);
    if (checked) next.add(key);
    else next.delete(key);
    setSelection(next);
  }

  function toggleSort(key: string) {
    setSortState((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }

  function handleRowDragStart(event: ReactDragEvent<HTMLElement>, key: string, dragDisabled: boolean) {
    const fromHandle = event.target instanceof Element && !!event.target.closest("[data-row-drag-handle]");
    if (!draggableRows || dragDisabled || !fromHandle) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
    setDraggedRowKey(key);
    suppressNextClickRef.current = true;
  }

  function getDropPosition(event: ReactDragEvent<HTMLTableRowElement>): AdvancedDataTableDropPosition {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function canDropOnRow(targetRow: T, targetIndex: number, targetKey: string, dragDisabled: boolean, position: AdvancedDataTableDropPosition) {
    if (!draggableRows || dragDisabled || !draggedRowKey || draggedRowKey === targetKey) return false;
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === draggedRowKey);
    if (sourceIndex < 0) return false;
    return rowDropAllowed?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, position) ?? true;
  }

  function handleRowDragOver(event: ReactDragEvent<HTMLTableRowElement>, row: T, index: number, key: string, dragDisabled: boolean) {
    const position = getDropPosition(event);
    if (!canDropOnRow(row, index, key, dragDisabled, position)) {
      if (key === draggedRowKey && dragTarget) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
      if (key !== draggedRowKey) setDragTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragTarget({ key, position });
  }

  function handleRowDragEnd() {
    setDraggedRowKey(null);
    setDragTarget(null);
    window.setTimeout(() => {
      suppressNextClickRef.current = false;
    }, 0);
  }

  function hasActiveTextSelection() {
    if (typeof window === "undefined") return false;
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
  }

  function dropOnPreviewTarget(sourceKey: string) {
    if (!dragTarget) return false;
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === sourceKey);
    const targetIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === dragTarget.key);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;
    const targetRow = filteredRows[targetIndex];
    const targetDragDisabled = rowDragDisabled?.(targetRow, targetIndex) ?? false;
    if (targetDragDisabled) return false;
    if (!(rowDropAllowed?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, dragTarget.position) ?? true)) return false;
    void onRowReorder?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, dragTarget.position);
    return true;
  }

  function handleRowDrop(event: ReactDragEvent<HTMLTableRowElement>, targetRow: T, targetIndex: number, targetKey: string, dragDisabled: boolean) {
    if (!draggableRows || dragDisabled) return;
    event.preventDefault();
    const sourceKey = draggedRowKey ?? event.dataTransfer.getData("text/plain");
    const position = getDropPosition(event);
    dropOnRowAtPosition(event, sourceKey, targetRow, targetIndex, targetKey, dragDisabled, position);
  }

  function dropOnRowAtPosition(
    event: ReactDragEvent<HTMLTableRowElement>,
    sourceKey: string,
    targetRow: T,
    targetIndex: number,
    targetKey: string,
    dragDisabled: boolean,
    position: AdvancedDataTableDropPosition,
  ) {
    handleRowDragEnd();
    if (dragDisabled || !sourceKey) return;
    if (sourceKey === targetKey) {
      dropOnPreviewTarget(sourceKey);
      return;
    }
    const sourceIndex = orderedRows.findIndex((row, index) => rowKey(row, index) === sourceKey);
    if (sourceIndex < 0) return;
    if (!(rowDropAllowed?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, position) ?? true)) return;
    void onRowReorder?.(orderedRows[sourceIndex], targetRow, sourceIndex, targetIndex, position);
  }

  const selectedCount = effectiveSelectedKeys.size;
  const allSelected = allRowKeys.length > 0 && allRowKeys.every((key) => effectiveSelectedKeys.has(key));
  const hasAnyFilters = showFilters && Object.values(filters).some((values) => (values?.length ?? 0) > 0);
  const headerPaddingClass = compactRows ? "px-3 py-1.5" : "px-3 py-2";
  const cellPaddingClass = compactRows ? "px-3 py-1.5" : "px-3 py-2";
  const selectPaddingClass = compactRows ? "px-2 py-1.5" : "px-2 py-2";
  const showToolbar =
    toolbarMode !== "none" &&
    (
      toolbarMode === "default" ||
      !!toolbarLeftContent ||
      !!toolbarRightContent ||
      showColumnVisibilityButton
    );

  return (
    <div className={fillHeight ? "flex h-full min-h-0 flex-col" : "min-h-0"}>
      {showToolbar ? (
        <div
          data-batch-popover-boundary
          className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 bg-white px-3 py-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-slate-500">
            {toolbarMode === "custom" ? (
              toolbarLeftContent
            ) : (
              <>
                {selectable ? <span>{tf("table.selectedCount", { count: selectedCount })}</span> : null}
                {hasAnyFilters ? <span>{filteredRows.length}/{rows.length}</span> : null}
                {hasAnyFilters ? (
                  <button
                    type="button"
                    onClick={() => {
                      setFilters({});
                      setActiveFilterColumn(null);
                    }}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    {t("table.clearFilters")}
                  </button>
                ) : null}
                {selectedCount > 0 ? batchActions.map((action) => (
                  <button key={action.label} type="button" onClick={action.onClick} disabled={action.disabled} className="secondary-button h-7 px-2 text-xs">
                    {action.label}
                  </button>
                )) : null}
                {selectedCount > 0 ? batchActionSlot : null}
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toolbarMode === "custom" ? toolbarRightContent : null}
            {showColumnVisibilityButton ? (
              <div ref={columnMenuRef} className="relative">
                <button type="button" onClick={() => setMenuOpen((open) => !open)} className="secondary-button h-7 px-2 text-xs" title={t("table.columnSettings")}>
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
                {menuOpen ? (
                  <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
                    <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">{t("table.visibleColumns")}</div>
                    <div className="max-h-56 space-y-1 overflow-y-auto">
                      {columns.map((column) => (
                        <label key={column.key} className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${column.hideable ? "cursor-pointer text-slate-700 hover:bg-slate-50" : "text-slate-400"}`}>
                          <input type="checkbox" checked={!hiddenKeys.has(column.key)} disabled={!column.hideable} onChange={() => toggleColumn(column.key)} className="h-3.5 w-3.5 rounded border-slate-300" />
                          <span className="truncate">{column.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div
        ref={viewportRef}
        className={
          fillHeight
            ? `${needsHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden"} min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]`
            : `${needsHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden"} overflow-y-scroll [scrollbar-gutter:stable]`
        }
      >
        <table className="table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200" style={{ width: layout.tableWidth }}>
          <colgroup>
            {(selectable || draggableRows) ? <col style={{ width: layout.controlWidth }} /> : null}
            {visibleColumns.map((column) => <col key={column.key} style={{ width: layout.colWidths[column.key] ?? column.width }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              {(selectable || draggableRows) ? (
                <th className={`border-b border-slate-200 text-center ${selectPaddingClass}`}>
                  {selectable ? (
                    <input type="checkbox" checked={allSelected} onChange={(event) => toggleAllRows(event.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" aria-label={t("table.selectAll")} />
                  ) : null}
                </th>
              ) : null}
              {visibleColumns.map((column) => (
                <th key={column.key} className={["relative select-none border-b border-slate-200 text-center text-xs font-semibold text-slate-600", headerPaddingClass, column.headerClassName ?? ""].join(" ")}>
                  <div className="flex items-center justify-center gap-1">
                    {showFilters && column.filterText ? (
                      column.filterKind === "dateRange" ? (
                        <DateRangeColumnFilter
                          label={labelText(column.label, column.key)}
                          from={filters[column.key]?.[0] ?? ""}
                          to={filters[column.key]?.[1] ?? ""}
                          open={activeFilterColumn === column.key}
                          onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                          onClose={() => setActiveFilterColumn(null)}
                          onChange={({ from, to }) =>
                            setFilters((prev) => {
                              if (!from && !to) {
                                const next = { ...prev };
                                delete next[column.key];
                                return next;
                              }
                              return { ...prev, [column.key]: [from, to] };
                            })
                          }
                        />
                      ) : (
                        <TableColumnFilter
                          label={labelText(column.label, column.key)}
                          options={filterOptions[column.key] ?? []}
                          selectedValues={filters[column.key] ?? []}
                          open={activeFilterColumn === column.key}
                          onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                          onClose={() => setActiveFilterColumn(null)}
                          onChange={(values) =>
                            setFilters((prev) => {
                              if (!values || values.length === 0) {
                                const next = { ...prev };
                                delete next[column.key];
                                return next;
                              }
                              return { ...prev, [column.key]: values };
                            })
                          }
                        />
                      )
                    ) : (
                      <span className="block truncate text-center">{column.label}</span>
                    )}
                    {column.sortValue || column.filterText ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ${sortState?.key === column.key ? "text-blue-600" : "text-slate-300 hover:text-slate-500"}`}
                        title={sortState?.key === column.key ? (sortState.direction === "asc" ? "当前升序，点击改为降序" : "当前降序，点击取消排序") : "排序"}
                        aria-label={`${labelText(column.label, column.key)}排序`}
                      >
                        {sortState?.key === column.key
                          ? sortState.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
                          : <ChevronsUpDown className="h-3.5 w-3.5" />}
                      </button>
                    ) : null}
                  </div>
                  <span role="separator" aria-orientation="vertical" onMouseDown={(event) => beginResize(event, column)} className="absolute right-[-3px] top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none hover:bg-blue-300/40" title={t("table.resizeColumn")} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {displayRowItems.length > 0 ? displayRowItems.map(({ row, index, key }, displayIndex) => {
              const isSelected = effectiveSelectedKeys.has(key);
              const dragDisabled = sortState != null || (rowDragDisabled?.(row, index) ?? false);
              const isDragging = draggedRowKey != null;
              const isDraggedRow = draggedRowKey === key;
              const isAllowedDropTarget = dragTarget
                ? canDropOnRow(row, index, key, dragDisabled, dragTarget.position)
                : false;
              const isBlockedDropTarget = isDragging && !isDraggedRow && !isAllowedDropTarget;
              const toggleCurrentRow = () => {
                if (!selectable || !selectOnRowClick) return;
                toggleRow(key, !isSelected);
              };
              return (
                <tr
                  key={key}
                  onClick={() => {
                    if (suppressNextClickRef.current) {
                      suppressNextClickRef.current = false;
                      return;
                    }
                    if (hasActiveTextSelection()) return;
                    toggleCurrentRow();
                    onRowClick?.(row, displayIndex);
                  }}
                  onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row, displayIndex) : undefined}
                  onDragOver={(event) => handleRowDragOver(event, row, index, key, dragDisabled)}
                  onDrop={(event) => handleRowDrop(event, row, index, key, dragDisabled)}
                  className={[
                    rowClassName?.(row, displayIndex) ?? "hover:bg-slate-50",
                    selectable && selectOnRowClick ? "cursor-pointer" : "",
                    isBlockedDropTarget ? "cursor-not-allowed" : "",
                    isDraggedRow ? "bg-blue-50/70 ring-1 ring-inset ring-blue-200 shadow-[inset_0_0_0_1px_#bfdbfe]" : "",
                    isSelected ? "bg-blue-50/90 hover:bg-blue-100/80" : "",
                  ].filter(Boolean).join(" ")}
                >
                  {(selectable || draggableRows) ? (
                    <td className={`border-b border-slate-100 text-center ${selectPaddingClass}`}>
                      <div className="flex items-center justify-center gap-1">
                        {draggableRows ? (
                          <button
                            type="button"
                            draggable={!dragDisabled}
                            data-row-drag-handle
                            onClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => handleRowDragStart(event, key, dragDisabled)}
                            onDragEnd={handleRowDragEnd}
                            className={`flex h-5 w-4 items-center justify-center rounded text-slate-300 transition hover:bg-slate-100 hover:text-slate-500 ${dragDisabled ? "cursor-not-allowed opacity-30" : "cursor-grab active:cursor-grabbing"}`}
                            title="拖动排序"
                            aria-label="拖动排序"
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                        {selectable ? (
                          <input type="checkbox" checked={isSelected} onClick={(event) => event.stopPropagation()} onChange={(event) => toggleRow(key, event.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" aria-label={t("table.selectRow")} />
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                  {visibleColumns.map((column) => (
                    <td key={column.key} className={["select-text border-b border-slate-100 text-xs", cellPaddingClass, alignClass(column.align), column.className ?? ""].join(" ")}>
                      {column.render(row, displayIndex)}
                    </td>
                  ))}
                </tr>
              );
            }) : (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-400" colSpan={((selectable || draggableRows) ? 1 : 0) + visibleColumns.length || 1}>
                  {emptyText === "暂无数据" ? t("table.empty") : emptyText}
                </td>
              </tr>
            )}
          </tbody>
          {summaryRow ? (
            <tfoot className="sticky bottom-0 z-[1] bg-slate-50/95 backdrop-blur-sm">
              <tr className={summaryRow.rowClassName ?? ""}>
                {(selectable || draggableRows) ? (
                  <td className={`border-t border-slate-200 text-center ${selectPaddingClass} ${summaryRow.cellClassName ?? ""}`}>
                    {summaryRow.selectCell ?? null}
                  </td>
                ) : null}
                {visibleColumns.map((column) => (
                  <td
                    key={column.key}
                    className={[
                      "border-t border-slate-200 text-xs font-medium text-slate-700",
                      cellPaddingClass,
                      alignClass(column.align),
                      summaryRow.cellClassName ?? "",
                    ].join(" ")}
                  >
                    {summaryRow.cells[column.key] ?? null}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
