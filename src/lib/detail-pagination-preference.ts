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
/**
 * 「全部」模式的首屏页大小。切到「全部」时整份数据要几秒到几十秒，先取一小页
 * （500 行 ≈ 1MB）立刻渲染：行数超过表格的虚拟化阈值（200 行）后虚拟滚动条
 * 马上出现，剩下的全量在后台继续拉，取完再整份替换。用户不再盯着原来那一页
 * 「自适应」行数干等。
 */
export const DETAIL_ALL_FIRST_PAGE_SIZE = 500;
/**
 * 「全部」首屏（服务端直出的那一页）最少要有多少行。
 *
 * 「全部」里没有「每页多少条」这回事：URL / 偏好里的 `pageSize`（用户手动选的
 * 18/40，或自适应落地值）只对分页模式有意义。而服务端只直出这一页、剩下的由
 * 客户端分块补 —— 几千行一个块，往返要几百毫秒到数秒。若这一页比一屏还少，
 * 分块回来之前表格底部就空着几行白块，看起来像「全部只有 18 条」。
 *
 * 60 行在 31px 紧凑行高下能铺 1860px、41px 行高下 2460px，覆盖到 4K 全屏；
 * 再多没有意义（首屏每一行都要带上账户 / 标签 / 附件摘要，RSC payload 会变大）。
 */
export const DETAIL_ALL_FIRST_VIEWPORT_PAGE_SIZE = 60;

type DetailPaginationPreference = {
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

function encodeDetailPaginationPreference(pref: DetailPaginationPreference) {
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
