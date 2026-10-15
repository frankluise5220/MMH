/**
 * fnOS unified-gateway path prefix.
 *
 * The fnOS gateway registers the app under `gatewayPrefix` (/app/mmh) and
 * forwards every request **with that prefix intact** -- it is not stripped.
 * Official requirement: "HTTP 和 WebSocket 路由应保持在声明的 gatewayPrefix 下".
 * So the app itself must serve its routes under the prefix.
 *
 * `next.config.ts` turns `MMH_BASE_PATH` into Next's `basePath`, which fixes
 * `redirect()`, `<Link>`, the router and `/_next/*` asset URLs automatically.
 * Next does NOT rewrite hand-written URLs, so the same value is re-exported as
 * NEXT_PUBLIC_MMH_BASE_PATH for: `fetch()`, `window.location`, raw asset
 * `src`, `metadata.icons`, the PWA manifest body and the service-worker scope.
 *
 * Empty on Docker / Synology / Android, where the app is served from the origin
 * root and nothing needs prefixing -- `withBasePath` is then the identity.
 */
export const MMH_BASE_PATH = (process.env.NEXT_PUBLIC_MMH_BASE_PATH || "").replace(/\/+$/, "");

/**
 * Prefix an origin-absolute path with the fnOS gateway prefix (no-op elsewhere).
 *
 * Idempotent, and the "already prefixed" test looks at the PATH only: Next
 * collapses a basePath'd root route to the BARE prefix plus its query
 * (`/?view=allcash` -> `/app/mmh?view=allcash`), so a raw
 * `startsWith(basePath + "/")` test misses that form and prepends the prefix a
 * second time (`/app/mmh/app/mmh?view=allcash`).
 *
 * WHICH SIDE OF THE LINE A URL IS ON -- getting this backwards is a live bug in
 * both directions, so check it before "fixing" a prefix:
 *
 *  - Next-managed APIs take the RAW app-relative path, never this helper:
 *    `<Link href="/reports">`, `router.push("/reports")`, `redirect("/login")`.
 *    Next prepends basePath itself, and its `addBasePath` is NOT idempotent, so
 *    wrapping one of these produces `/app/mmh/app/mmh/...`.
 *  - Anything the BROWSER resolves by itself takes `withBasePath()`: `fetch()` /
 *    XHR, `window.location.assign/replace`/`location.href`, `history.pushState` /
 *    `replaceState`, `window.open`, a raw `<a href>` (next/link is not involved
 *    there) and image `src` (next/image adds no basePath to src either).
 *    `next.config.ts` basePath cannot reach any of those.
 *
 * Layer 2 is the runtime shim in `src/app/layout.tsx`: it rewrites those
 * browser-level exits, so a forgotten call still works on fnOS instead of
 * dropping the prefix. Layer 3 is `scripts/check-fnos-gateway-guards.cjs`, which
 * fails packaging when a new bare-root exit appears -- the call site has to stay
 * correct on its own, because the shim only exists on gateway builds.
 */
export function withBasePath(path: string): string {
  if (!MMH_BASE_PATH) return path;
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  const pathOnly = path.split(/[?#]/, 1)[0] ?? path;
  if (pathOnly === MMH_BASE_PATH || pathOnly.startsWith(`${MMH_BASE_PATH}/`)) return path;
  return `${MMH_BASE_PATH}${path}`;
}
