"use client";

import type { ReactNode } from "react";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";

const STORAGE_KEY = "mmh:reports:summary-height";

export function ReportResizableSplit({
  hasDetails,
  children,
}: {
  hasDetails: boolean;
  children: ReactNode;
}) {
  return (
    <ResizableVerticalSplit
      storageKey={STORAGE_KEY}
      hasLowerPane={hasDetails}
      separatorLabel="调整统计表高度"
      separatorTitle="拖动调整统计表高度"
    >
      {children}
    </ResizableVerticalSplit>
  );
}
