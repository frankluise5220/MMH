export const DETAIL_PAGE_SIZE_OPTIONS = [40, 80] as const;
export const DETAIL_ALL_PAGE_SIZE = 50000;
/**
 * 「全部」模式的分块大小。整份列表一次要回来几万行、几十 MB JSON：请求会在传输
 * 中途被浏览器重置，或者静默等到超时，而失败只写进 console —— 表格里一行都不变，
 * 用户只看到「切全部没反应」，表头漏斗也仍然只有原来那几十条可选。所以「全部」
 * 改成按块顺序拉取、逐块追加：首块先让列表长出来，剩下的边到边补。
 * 5000 行 ≈ 10MB，覆盖绝大多数账户的整份明细（一次请求即完成）；更大的口径
 * （全部收支 4 万+ 条）则分若干块渐进呈现。
 */
export const DETAIL_ALL_CHUNK_SIZE = 5000;

export type DetailPaginationPreference = {
  pageSize: number;
  detailPage: number;
  detailAll: boolean;
  /** Auto-fit rows to the viewport height; manual size choice turns it off. */
  autoFit?: boolean;
};

export function normalizeDetailPageSize(value: unknown, fallback = 40) {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  const floored = Math.floor(parsed);
  return floored <= DETAIL_ALL_PAGE_SIZE ? floored : fallback;
}

export function normalizeDetailPage(value: unknown, fallback = 1) {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function detailPaginationCookieName(accountId: string) {
  const safeAccountId = String(accountId ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `mmh_detail_pagination_${safeAccountId}`;
}

export function encodeDetailPaginationPreference(pref: DetailPaginationPreference) {
  return encodeURIComponent(JSON.stringify({
    pageSize: normalizeDetailPageSize(pref.pageSize),
    detailPage: normalizeDetailPage(pref.detailPage),
    detailAll: pref.detailAll === true,
    autoFit: pref.autoFit !== false,
  }));
}

export function decodeDetailPaginationPreference(value: string | null | undefined): DetailPaginationPreference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<DetailPaginationPreference>;
    return {
      pageSize: normalizeDetailPageSize(parsed.pageSize),
      detailPage: normalizeDetailPage(parsed.detailPage),
      detailAll: parsed.detailAll === true,
      autoFit: parsed.autoFit !== false,
    };
  } catch {
    return null;
  }
}

/** Clamp the page number to the [1, totalPages] range. */
export function clampDetailPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

function readCookieValue(name: string) {
  if (typeof document === "undefined") return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? match[1] : null;
}

/** Read the account's detail pagination preference from sessionStorage (falling back to cookie). */
export function readStoredDetailPreference(accountId: string): DetailPaginationPreference | null {
  const key = detailPaginationCookieName(accountId);
  const stored = typeof window === "undefined"
    ? null
    : decodeDetailPaginationPreference(window.sessionStorage.getItem(key));
  return stored ?? decodeDetailPaginationPreference(readCookieValue(key));
}

/** Write the detail pagination preference to sessionStorage + cookie. */
export function writeStoredDetailPreference(
  accountId: string,
  pageSize: number,
  detailAll: boolean,
  detailPage: number,
  autoFit?: boolean,
) {
  if (typeof window === "undefined") return;
  const cookieName = detailPaginationCookieName(accountId);
  // Panels that do not manage auto-fit themselves must not flip the flag:
  // keep the previously stored value when the caller omits it.
  const previous = decodeDetailPaginationPreference(
    window.sessionStorage.getItem(cookieName) ?? readCookieValue(cookieName),
  );
  const value = encodeDetailPaginationPreference({
    pageSize,
    detailAll,
    detailPage,
    autoFit: autoFit ?? previous?.autoFit,
  });
  window.sessionStorage.setItem(cookieName, value);
  document.cookie = `${cookieName}=${value}; path=/; max-age=31536000; SameSite=Lax`;
}
