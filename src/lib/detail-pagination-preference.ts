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
/**
 * 分页模式首屏（服务端直出的那一页）最少取多少行。
 *
 * 「自适应」的落地页大小只有浏览器量得出来，服务端首屏只能用 cookie 里上一次
 * 的测量值。窗口变大（换显示器、关掉侧边栏、浏览器全屏）后那个值就偏小：首屏
 * 只铺十几行、下面空一大片，要等「表格测量 → 改页大小 → 重新取数」这一趟往返
 * 才补齐（大账户上实测数秒），用户看到的就是「自适应没在最初始生效」。
 *
 * 所以首屏按 `max(pageSize, 60)` 取数，客户端量出真实行数后**本地切片**显示
 * （`BasicDetailPanel` 的 `pageEntries`），第一帧就有足够行铺满视口，不再有那
 * 段空档。多取的行只是白拿的 RSC payload —— 覆盖范围与「全部」首屏相同，60 行
 * 在 31px 紧凑行高下 1860px、41px 行高下 2460px，够铺到 4K 全屏。
 */
export const DETAIL_PAGED_FIRST_FETCH_ROWS = 60;
/**
 * 分页模式下「整份窗口预取」推迟多久开始（毫秒）。
 *
 * 首屏那一页由 RSC 直出，整份预取只是翻页 / 缩窗时的备料；和首屏同时发起只会把
 * 服务端 CPU 占满，让用户紧接着的下一次「切账户」（又一次 RSC 渲染）排队 ——
 * 实测同一次切换从 1.3s 掉到 2.3-3.2s。留出一帧渲染 + 一个空档再开始。
 */
export const DETAIL_PRELOAD_IDLE_DELAY_MS = 1500;

export type DetailDateRangePreference = { from: string; to: string };

type DetailPaginationPreference = {
  pageSize: number;
  detailPage: number;
  detailAll: boolean;
  /** Auto-fit rows to the viewport height; manual size choice turns it off. */
  autoFit?: boolean;
  /**
   * 时间轴「显示范围」，**按视图（账户 / 全部收支）各自一份**。
   *
   * `null` = 用户没动过，用服务端算的默认观测窗口（`设置 → 显示 → 明细默认观测
   * 窗口`）。以前范围只活在这个视图的组件状态里：切去别的账户再回来、或者刷新
   * 一次页面就回落到默认窗口 —— 用户明明改过，看起来就是「被改回去了」。
   */
  range?: DetailDateRangePreference | null;
};

const DETAIL_DATE_PART_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 空串 = 「该端不限」，合法日期串原样返回，别的一律当没写。 */
export function normalizeDetailDatePart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return "";
  return DETAIL_DATE_PART_RE.test(trimmed) ? trimmed : null;
}

/** 两端都为空（不限）时返回 null —— 与「没存过」等价，都走服务端默认窗口。 */
export function normalizeDetailDateRange(from: unknown, to: unknown): DetailDateRangePreference | null {
  const nextFrom = normalizeDetailDatePart(from);
  const nextTo = normalizeDetailDatePart(to);
  if (nextFrom === null || nextTo === null) return null;
  if (!nextFrom && !nextTo) return null;
  return { from: nextFrom, to: nextTo };
}

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

/**
 * 「最近一次自适应量到的行数」，**不分账户**。
 *
 * 每个账户的落地值存在自己的 cookie 里，新账户（或刚清过 cookie 的账户）没有，
 * 服务端首屏只能退回写死的 40 行 —— 1080p 窗口下会先铺 40 行、溢出小半屏，
 * 等浏览器量完才收缩。而一台设备上一次量出来的行数对同一窗口里的所有账户都
 * 成立，拿它当首屏兜底，新账户的第一帧就基本正确。
 */
export const DETAIL_LAST_FIT_ROWS_COOKIE = "mmh_detail_last_fit_rows";

export function detailPaginationCookieName(accountId: string) {
  const safeAccountId = String(accountId ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `mmh_detail_pagination_${safeAccountId}`;
}

function encodeDetailPaginationPreference(pref: DetailPaginationPreference) {
  const range = normalizeDetailDateRange(pref.range?.from, pref.range?.to);
  return encodeURIComponent(JSON.stringify({
    pageSize: normalizeDetailPageSize(pref.pageSize),
    detailPage: normalizeDetailPage(pref.detailPage),
    detailAll: pref.detailAll === true,
    autoFit: pref.autoFit !== false,
    // 没存过范围时不写这两个键：cookie 保持原样，默认窗口口径也不会被空串占位。
    ...(range ? { rangeFrom: range.from, rangeTo: range.to } : {}),
  }));
}

export function decodeDetailPaginationPreference(value: string | null | undefined): DetailPaginationPreference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<DetailPaginationPreference> & {
      rangeFrom?: unknown;
      rangeTo?: unknown;
    };
    return {
      pageSize: normalizeDetailPageSize(parsed.pageSize),
      detailPage: normalizeDetailPage(parsed.detailPage),
      detailAll: parsed.detailAll === true,
      autoFit: parsed.autoFit !== false,
      range: normalizeDetailDateRange(parsed.rangeFrom, parsed.rangeTo),
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
    // 翻页 / 改行数不该顺手把用户选的时间轴范围抹掉：cookie 是一个整体，重写
    // 时必须把没参与的字段带上。
    range: previous?.range ?? null,
  });
  persistPreference(cookieName, value);
  // 只有「自适应」的落地值才代表这台设备这个窗口能放多少行；手选的固定行数
  // 不能拿去给别的账户当首屏兜底。
  if (autoFit === true) {
    document.cookie = `${DETAIL_LAST_FIT_ROWS_COOKIE}=${normalizeDetailPageSize(pageSize)}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

/**
 * 时间轴的「显示范围」按视图单独落盘（sessionStorage + cookie）。
 *
 * 每次导航都会重新挂载面板，而服务端首屏按 cookie 里的这份范围取数（见
 * `app/(sidebar)/page.tsx` 的 `initialDetailDateRange`）——两边共用同一个 cookie，
 * 切走再回来、刷新页面都还是用户选的那段，不会「被改回去」。
 * `null` 表示恢复默认观测窗口。
 */
export function writeStoredDetailRangePreference(accountId: string, range: DetailDateRangePreference | null) {
  if (typeof window === "undefined") return;
  const cookieName = detailPaginationCookieName(accountId);
  const previous = decodeDetailPaginationPreference(
    window.sessionStorage.getItem(cookieName) ?? readCookieValue(cookieName),
  );
  const value = encodeDetailPaginationPreference({
    pageSize: previous?.pageSize ?? 40,
    detailPage: previous?.detailPage ?? 1,
    detailAll: previous?.detailAll === true,
    autoFit: previous?.autoFit,
    range,
  });
  persistPreference(cookieName, value);
}

function persistPreference(cookieName: string, value: string) {
  window.sessionStorage.setItem(cookieName, value);
  document.cookie = `${cookieName}=${value}; path=/; max-age=31536000; SameSite=Lax`;
}
