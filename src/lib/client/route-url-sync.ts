"use client";

import { withBasePath, withoutBasePath } from "@/lib/base-path";

/**
 * Safe address-bar sync for view state (view / page / pageSize / fundCode / …).
 *
 * Next 16 patches `window.history.pushState` / `replaceState`: **every** call from
 * application code dispatches ACTION_RESTORE and resets the router's canonicalUrl
 * to the supplied URL (see `next/dist/client/components/app-router.js`,
 * `applyUrlFromHistoryPushReplace`). During a client-side navigation to another
 * route the old page subtree stays mounted until the RSC payload arrives — in dev
 * that can be tens of seconds while the route is compiled. A single
 * `replaceState` from that old subtree then cancels the in-flight navigation,
 * even when the URL written is byte-for-byte identical to the current one.
 *
 * That is exactly "click 系统设置, the spinner turns, and I'm back on the 7457
 * account view": Next restores the old `/?accountId=…&view=detail…` canonicalUrl.
 * Verified with Playwright: holding the /settings RSC payload and calling
 * `history.replaceState(null, "", location.href)` once is enough to bounce.
 *
 * So a pending navigation to a different pathname is recorded (capture-phase
 * link click, see FirstUseGuide) and cleared when `usePathname()` changes.
 * While it is pending, view-state URL writes and passive router refreshes are
 * skipped. The TTL is only a safety net for a navigation that never commits.
 */
const PENDING_KEY = "mmh:route:navigation-pending";
// Dev can spend a long time compiling a route for the first time. The marker is
// normally cleared by the shell's pathname effect; this is only a safety net.
const PENDING_TTL_MS = 60_000;

type PendingNavigation = { from: string; to: string; until: number };

function readPendingNavigation(): PendingNavigation | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingNavigation>;
    if (
      typeof parsed.from !== "string"
      || typeof parsed.to !== "string"
      || typeof parsed.until !== "number"
    ) return null;
    return { from: parsed.from, to: parsed.to, until: parsed.until };
  } catch {
    return null;
  }
}

export function isRouteNavigationPending(): boolean {
  const pending = readPendingNavigation();
  if (!pending) return false;
  if (Date.now() >= pending.until) {
    clearRouteNavigation();
    return false;
  }
  // The navigation has committed to another pathname; stop suppressing URL
  // syncing even if the shell's pathname effect has not run yet.
  if (typeof window !== "undefined" && withoutBasePath(window.location.pathname) !== pending.from) {
    clearRouteNavigation();
    return false;
  }
  return true;
}

export function clearRouteNavigation(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // sessionStorage can be unavailable (privacy mode); the TTL still bounds it.
  }
}

/**
 * Called from a capture-phase document click listener in the always-mounted
 * shell. Only a link that actually leaves the current pathname counts: a
 * `/?view=…` link stays on the same route and must not suppress URL syncing.
 */
export function markLeavingNavigationFromLink(href: string): void {
  if (typeof window === "undefined") return;
  let nextPath: string;
  try {
    nextPath = withoutBasePath(new URL(href, window.location.href).pathname);
  } catch {
    return;
  }
  const currentPath = withoutBasePath(window.location.pathname);
  if (nextPath === currentPath) return;
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ from: currentPath, to: nextPath, until: Date.now() + PENDING_TTL_MS } satisfies PendingNavigation),
    );
  } catch {
    // Without storage the guard degrades to the pathname / no-op checks below.
  }
}

/**
 * Passive `router.refresh()` / `router.replace(currentHref)` calls. Refreshing
 * while another route is pending re-renders from the stale canonicalUrl and
 * bounces the user back to the old view.
 */
export function canRefreshCurrentRoute(): boolean {
  return typeof window !== "undefined" && !isRouteNavigationPending();
}

/**
 * The single entry point for mirroring view state into the address bar.
 *
 * Refuses to write when:
 *  - a navigation to another pathname is still pending;
 *  - the target pathname is not the current one (an unmounted page must never
 *    rewrite `/settings` back into `/?…`);
 *  - the resulting URL is unchanged (a no-op write still dispatches
 *    ACTION_RESTORE and is enough to cancel a navigation).
 *
 * `nextHref` is an app-relative href; the fnOS gateway prefix is added here, so
 * callers must not wrap it in `withBasePath()` themselves.
 */
export function replaceCurrentRouteUrl(nextHref: string): boolean {
  if (typeof window === "undefined") return false;
  if (isRouteNavigationPending()) return false;
  const target = new URL(withBasePath(nextHref), window.location.href);
  const { pathname, search, hash } = window.location;
  if (target.pathname !== pathname) return false;
  const normalized = `${target.pathname}${target.search}${target.hash}`;
  if (normalized === `${pathname}${search}${hash}`) return false;
  window.history.replaceState(null, "", normalized);
  return true;
}
