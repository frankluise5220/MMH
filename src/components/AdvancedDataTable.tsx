"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { SlidersHorizontal } from "lucide-react";
import { TableColumnFilter } from "./TableColumnFilter";

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
  render: (row: T, index: number) => ReactNode;
};

export type AdvancedDataTableBatchAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type AdvancedDataTableProps<T> = {
  storageKey: string;
  columns: AdvancedDataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  emptyText?: ReactNode;
  minTableWidth?: number;
  rowClassName?: (row: T, index: number) => string;
  onRowClick?: (row: T, index: number) => void;
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  batchActions?: AdvancedDataTableBatchAction[];
  batchActionSlot?: ReactNode;
  showFilters?: boolean;
  fillHeight?: boolean;
  compactRows?: boolean;
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
  selectable = false,
  selectedKeys,
  onSelectionChange,
  batchActions = [],
  batchActionSlot,
  showFilters = true,
  fillHeight = false,
  compactRows = false,
}: AdvancedDataTableProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [filters, setFilters] = useState<Partial<Record<string, string[]>>>({});
  const [activeFilterColumn, setActiveFilterColumn] = useState<string | null>(null);
  const [internalSelectedKeys, setInternalSelectedKeys] = useState<Set<string>>(new Set());

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
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = columnMenuRef.current;
      if (!node || !(event.target instanceof Node) || node.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

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
      return values?.includes(value);
    }));
  }, [columns, filters, rows, showFilters]);
  const allRowKeys = useMemo(() => filteredRows.map((row, index) => rowKey(row, index)), [filteredRows, rowKey]);

  const layout = useMemo(() => {
    const selectWidth = selectable ? 38 : 0;
    const baseWidths = visibleColumns.map((column) => {
      const saved = columnWidths[column.key];
      const minWidth = column.minWidth ?? 52;
      const width = Math.max(minWidth, Number.isFinite(saved) ? saved : column.width);
      return [column.key, width] as const;
    });
    const baseTotal = selectWidth + baseWidths.reduce((sum, [, width]) => sum + width, 0);
    const tableWidth = Math.max(minTableWidth ?? 0, viewportWidth || 0, baseTotal);
    const scale = baseTotal > 0 && baseTotal < tableWidth ? tableWidth / baseTotal : 1;
    return {
      tableWidth,
      selectWidth: selectWidth * scale,
      colWidths: Object.fromEntries(baseWidths.map(([key, width]) => [key, width * scale])),
    };
  }, [columnWidths, minTableWidth, selectable, viewportWidth, visibleColumns]);

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

  const selectedCount = effectiveSelectedKeys.size;
  const allSelected = allRowKeys.length > 0 && allRowKeys.every((key) => effectiveSelectedKeys.has(key));
  const hasAnyFilters = showFilters && Object.values(filters).some((values) => (values?.length ?? 0) > 0);
  const headerPaddingClass = compactRows ? "px-3 py-1.5" : "px-3 py-2";
  const cellPaddingClass = compactRows ? "px-3 py-1.5" : "px-3 py-2";
  const selectPaddingClass = compactRows ? "px-2 py-1.5" : "px-2 py-2";

  return (
    <div className={fillHeight ? "flex h-full min-h-0 flex-col" : "min-h-0"}>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          {selectable ? <span>已选 {selectedCount}</span> : null}
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
              清空筛选
            </button>
          ) : null}
          {selectedCount > 0 ? batchActions.map((action) => (
            <button key={action.label} type="button" onClick={action.onClick} disabled={action.disabled} className="secondary-button h-7 px-2 text-xs">
              {action.label}
            </button>
          )) : null}
          {selectedCount > 0 ? batchActionSlot : null}
        </div>
        <div ref={columnMenuRef} className="relative">
          <button type="button" onClick={() => setMenuOpen((open) => !open)} className="secondary-button h-7 px-2 text-xs" title="列设置">
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
              <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">显示列</div>
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
      </div>

      <div ref={viewportRef} className={fillHeight ? "min-h-0 flex-1 overflow-auto" : "overflow-auto"}>
        <table className="table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200" style={{ width: layout.tableWidth }}>
          <colgroup>
            {selectable ? <col style={{ width: layout.selectWidth }} /> : null}
            {visibleColumns.map((column) => <col key={column.key} style={{ width: layout.colWidths[column.key] ?? column.width }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              {selectable ? (
                <th className={`border-b border-slate-200 text-center ${selectPaddingClass}`}>
                  <input type="checkbox" checked={allSelected} onChange={(event) => toggleAllRows(event.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" aria-label="选择全部" />
                </th>
              ) : null}
              {visibleColumns.map((column) => (
                <th key={column.key} className={["relative select-none border-b border-slate-200 text-xs font-semibold text-slate-600", headerPaddingClass, alignClass(column.align), column.headerClassName ?? ""].join(" ")}>
                  {showFilters && column.filterText ? (
                    <TableColumnFilter
                      label={labelText(column.label, column.key)}
                      options={filterOptions[column.key] ?? []}
                      selectedValues={filters[column.key] ?? []}
                      open={activeFilterColumn === column.key}
                      onToggleOpen={() => setActiveFilterColumn((current) => current === column.key ? null : column.key)}
                      onClose={() => setActiveFilterColumn(null)}
                      onChange={(values) => setFilters((prev) => ({ ...prev, [column.key]: values }))}
                    />
                  ) : (
                    <span className="block truncate">{column.label}</span>
                  )}
                  <span role="separator" aria-orientation="vertical" onMouseDown={(event) => beginResize(event, column)} className="absolute right-[-3px] top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none hover:bg-blue-300/40" title="拖动调整列宽" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {filteredRows.length > 0 ? filteredRows.map((row, index) => {
              const key = rowKey(row, index);
              return (
                <tr key={key} onClick={onRowClick ? () => onRowClick(row, index) : undefined} className={rowClassName?.(row, index) ?? "hover:bg-slate-50"}>
                  {selectable ? (
                    <td className={`border-b border-slate-100 text-center ${selectPaddingClass}`}>
                      <input type="checkbox" checked={effectiveSelectedKeys.has(key)} onClick={(event) => event.stopPropagation()} onChange={(event) => toggleRow(key, event.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" aria-label="选择行" />
                    </td>
                  ) : null}
                  {visibleColumns.map((column) => (
                    <td key={column.key} className={["border-b border-slate-100 text-xs", cellPaddingClass, alignClass(column.align), column.className ?? ""].join(" ")}>
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
              );
            }) : (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-400" colSpan={(selectable ? 1 : 0) + visibleColumns.length || 1}>
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
