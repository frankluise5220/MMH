"use client";

import { useEffect } from "react";

export function SidebarRefreshOnMount({
  refreshKey,
}: {
  refreshKey: string;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    }, 60);
    return () => window.clearTimeout(timer);
  }, [refreshKey]);

  return null;
}
