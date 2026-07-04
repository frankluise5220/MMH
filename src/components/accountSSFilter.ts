"use client";

import { useCallback, useMemo, useState } from "react";
import type { SmartSelectOption } from "./SmartSelect";

/** Shared owner-filter logic for account SmartSelect dropdowns. */
export function useAccountSSFilter(accountSSOptions?: SmartSelectOption[], controlledOwnerFilter?: string) {
  const [internalOwnerFilter, setInternalOwnerFilter] = useState("");
  const ownerFilter = controlledOwnerFilter ?? internalOwnerFilter;
  const setOwnerFilter = useCallback((next: string) => {
    if (controlledOwnerFilter === undefined) setInternalOwnerFilter(next);
  }, [controlledOwnerFilter]);
  const ownerFilterLabel = useMemo(() => ownerFilter || "全部", [ownerFilter]);
  const ownerNames = useMemo(() => {
    const names = new Set<string>();
    for (const option of accountSSOptions ?? []) {
      if (option.isHeader && option.label && option.label !== "未指定") names.add(option.label);
    }
    return Array.from(names);
  }, [accountSSOptions]);

  const cycleOwnerFilter = useCallback(() => {
    const owners = ownerNames;
    if (owners.length === 0) return;
    const current = ownerFilter;
    const idx = owners.indexOf(current);
    const next = idx < 0 ? owners[0] : owners[(idx + 1) % owners.length];
    if (next === owners[0] && current === owners[owners.length - 1]) {
      setOwnerFilter("");
    } else {
      setOwnerFilter(next);
    }
  }, [ownerFilter, ownerNames, setOwnerFilter]);

  const filteredOptions = useMemo(() => {
    if (!accountSSOptions) return undefined;
    const options = accountSSOptions;
    const nonHeaderOptions = options.filter((option) => !option.isHeader);
    if (!ownerFilter) return nonHeaderOptions;
    const headerId = options.find((option) => option.isHeader && option.label === ownerFilter)?.id;
    if (!headerId) return nonHeaderOptions;
    return nonHeaderOptions.filter((option) => option.parentId === headerId);
  }, [accountSSOptions, ownerFilter]);

  const visibleOptionIds = useMemo(
    () => (filteredOptions ? new Set(filteredOptions.map((option) => option.id)) : undefined),
    [filteredOptions],
  );

  return { ownerFilter, setOwnerFilter, ownerFilterLabel, cycleOwnerFilter, filteredOptions, visibleOptionIds, ownerNames };
}
