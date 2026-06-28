"use client";

import { useMemo, useCallback, useState, type ReactNode } from "react";
import { Repeat } from "lucide-react";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";

/** Small wrapper around SmartSelect that adds an owner-filter cycle button.
 *  Keeps SmartSelect purely generic — this is where account-specific UX lives. */
export function AccountSelect({
  value,
  onChange,
  options = [],
  placeholder,
  onCreateClick,
  createLabel,
  className,
  children,
}: {
  value: string;
  onChange: (id: string) => void;
  options?: SmartSelectOption[];
  placeholder?: string;
  onCreateClick?: () => void;
  createLabel?: string;
  className?: string;
  /** Extra content rendered inside the SS dropdown top bar (e.g. cycle button).
   *  SmartSelect renders this as a slot in the search/create row area.
   *  For now we render the cycle button inside a small wrapper outside SS. */
  children?: ReactNode;
}) {
  const [ownerFilter, setOwnerFilter] = useState("");

  const ownerNames = useMemo(() => {
    const names = new Set<string>();
    for (const o of options) {
      if (o.isHeader && o.label) names.add(o.label);
    }
    return Array.from(names).filter(n => n !== "未指定").sort();
  }, [options]);

  const cycleOwnerFilter = useCallback(() => {
    if (ownerNames.length === 0) return;
    const idx = ownerNames.indexOf(ownerFilter);
    const next = idx < 0 ? ownerNames[0] : ownerNames[(idx + 1) % ownerNames.length];
    setOwnerFilter(next === ownerNames[0] && ownerFilter === ownerNames[ownerNames.length - 1] ? "" : next);
  }, [ownerFilter, ownerNames]);

  const filteredOptions = useMemo(() => {
    if (!ownerFilter) return options.filter(o => !o.isHeader);
    const headerId = options.find(o => o.isHeader && o.label === ownerFilter)?.id;
    if (!headerId) return options.filter(o => !o.isHeader);
    return options.filter(o => o.parentId === headerId);
  }, [options, ownerFilter]);

  const cycleButton = ownerNames.length > 0 ? (
    <button
      type="button"
      onClick={cycleOwnerFilter}
      title={`所有人：${ownerFilter || "全部"}`}
      aria-label={`切换所有人，当前 ${ownerFilter || "全部"}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="w-3.5 h-3.5" />
    </button>
  ) : undefined;

  return (
    <div style={className ? undefined : undefined}>
      <SmartSelect
        mode="single"
        value={value}
        onChange={onChange}
        options={filteredOptions}
        placeholder={placeholder}
        searchable
        onCreateClick={onCreateClick}
        createLabel={createLabel}
        headerExtra={cycleButton}
      />
    </div>
  );
}
