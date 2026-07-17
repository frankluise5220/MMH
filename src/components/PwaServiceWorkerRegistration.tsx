"use client";

import { useEffect } from "react";

export function PwaServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      }).catch((error) => {
        console.warn("MMH service worker registration failed:", error);
      });
    }, { once: true });
  }, []);

  return null;
}
