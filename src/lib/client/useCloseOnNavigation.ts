"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function useCloseOnNavigation(open: boolean, onClose: () => void) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentLocation = `${pathname}?${searchParams.toString()}`;
  const previousLocationRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (previousLocationRef.current === null) {
      previousLocationRef.current = currentLocation;
      return;
    }
    if (previousLocationRef.current === currentLocation) return;
    previousLocationRef.current = currentLocation;
    if (open) onCloseRef.current();
  }, [currentLocation, open]);
}
