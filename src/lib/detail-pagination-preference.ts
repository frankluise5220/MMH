export const DETAIL_PAGE_SIZE_OPTIONS = [10, 20, 40] as const;

export type DetailPaginationPreference = {
  pageSize: number;
  detailPage: number;
  detailAll: boolean;
};

export function normalizeDetailPageSize(value: unknown, fallback = 20) {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return DETAIL_PAGE_SIZE_OPTIONS.includes(parsed as (typeof DETAIL_PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : fallback;
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
    };
  } catch {
    return null;
  }
}
