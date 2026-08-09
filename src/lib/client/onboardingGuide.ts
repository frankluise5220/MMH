"use client";

export const FIRST_USE_GUIDE_OPEN_EVENT = "mmh:first-use-guide:open";

export function dispatchFirstUseGuideOpen() {
  window.dispatchEvent(new CustomEvent(FIRST_USE_GUIDE_OPEN_EVENT));
}
