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

/** Prefix an origin-absolute path with the fnOS gateway prefix (no-op elsewhere). */
export function withBasePath(path: string): string {
  if (!MMH_BASE_PATH) return path;
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (path === MMH_BASE_PATH || path.startsWith(`${MMH_BASE_PATH}/`)) return path;
  return `${MMH_BASE_PATH}${path}`;
}
