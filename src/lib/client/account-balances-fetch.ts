// Shared fetch for account display balances.
//
// Several components (sidebar, page-header balance) listen to the same
// FINANCE_DATA_CHANGED_EVENT with slightly different debounce timers
// (~80ms vs ~100ms). Without coalescing, a single save triggers 2-3
// concurrent calls, and each full `/internal` call recomputes every
// household balance from the transaction history — one of the main
// reasons saving an entry feels slow on large datasets.
//
// In-flight coalescing only: results are never cached, so consumers always
// observe balances that are as fresh as the latest request.
//
// When a finance event carries `accountIds`, callers must use
// `fetchScopedAccountBalances` instead of the full household recompute.

type InternalAccountBalancesPayload = {
  ok?: boolean;
  baseCurrency?: string;
  totalConvertedBalance?: number;
  missingFxCurrencies?: string[];
  accounts?: Array<Record<string, unknown>>;
} | null;

export type ScopedAccountBalance = {
  id: string;
  balance: number;
  kind: string;
  currency?: string | null;
  convertedBalance?: number | null;
  baseCurrency?: string | null;
  fxRate?: number | null;
  fxRateDate?: string | null;
  fxRateMissing?: boolean;
};

type ScopedAccountBalancesPayload = {
  ok: true;
  baseCurrency: string;
  data: ScopedAccountBalance[];
  totalConvertedBalance: number | null;
} | null;

type ConvertedSeedItem = {
  id?: string | null;
  convertedBalance?: number | null;
  /**
   * `ledger` = 账面口径（关联了货基的电子钱包）：屏幕上显示真实余额，但它对总资产的
   * 贡献恒为 0，索引里必须按 0 记，否则下一次统计口径的增量补丁会拿真实值当「原本计入
   * 的值」而从总额里减掉。
   */
  balanceScope?: "ledger" | null;
  /** 分组节点（固定资产小类、往来款汇总行）。 */
  children?: ConvertedSeedItem[];
  /** 多币种子账户：必须一起进折余额索引，否则子账户余额补丁会让总额增量失效。 */
  subAccounts?: ConvertedSeedItem[];
};

let inFlight: Promise<InternalAccountBalancesPayload> | null = null;
const scopedInFlight = new Map<string, Promise<ScopedAccountBalancesPayload>>();
const convertedBalanceById = new Map<string, number | null>();
let seededTotalConvertedBalance: number | null = null;

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isSyntheticSidebarId(id: string) {
  return id.startsWith("__");
}

export function seedTotalConvertedBalance(total: number | null | undefined) {
  // Header net worth is the only valid total. Do not seed from a sidebar
  // subset — that would make incremental patches start from the wrong base.
  if (typeof total === "number" && Number.isFinite(total)) {
    seededTotalConvertedBalance = total;
  }
}

export function seedConvertedBalances(items: ConvertedSeedItem[], totalConvertedBalance?: number | null) {
  const walk = (item: ConvertedSeedItem) => {
    const id = String(item.id ?? "").trim();
    if (id && !isSyntheticSidebarId(id)) {
      convertedBalanceById.set(
        id,
        item.balanceScope === "ledger" ? 0 : finiteOrNull(item.convertedBalance ?? null),
      );
    }
    for (const child of item.children ?? []) walk(child);
    for (const child of item.subAccounts ?? []) walk(child);
  };
  for (const item of items) walk(item);
  seedTotalConvertedBalance(totalConvertedBalance);
}

function applyScopedConvertedBalanceDelta(accounts: ScopedAccountBalance[]): number | null {
  if (seededTotalConvertedBalance == null) return null;
  if (accounts.some((account) => !convertedBalanceById.has(account.id))) return null;
  let nextTotal = seededTotalConvertedBalance;
  for (const account of accounts) {
    const previous = finiteOrNull(convertedBalanceById.get(account.id) ?? null) ?? 0;
    const next = finiteOrNull(account.convertedBalance ?? null) ?? 0;
    nextTotal += next - previous;
    convertedBalanceById.set(account.id, finiteOrNull(account.convertedBalance ?? null));
  }
  seededTotalConvertedBalance = nextTotal;
  return nextTotal;
}

export function fetchInternalAccountBalances(): Promise<InternalAccountBalancesPayload> {
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const res = await fetch("/api/v1/accounts/internal", { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("application/json")) return null;
      const payload = (await res.json()) as InternalAccountBalancesPayload;
      if (payload?.ok && Array.isArray(payload.accounts)) {
        seedConvertedBalances(payload.accounts as ConvertedSeedItem[], payload.totalConvertedBalance);
      }
      return payload;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = request;
  return request;
}

export function fetchScopedAccountBalances(
  accountIds: string[],
  /**
   * `ledger: true` = 账面口径（关联了货基的电子钱包返回真实余额），只给明细页表头用。
   * 这类请求**不能**参与 sidebar 总资产的增量补丁，否则统计口径会被账面口径污染。
   */
  options?: { ledger?: boolean },
): Promise<ScopedAccountBalancesPayload> {
  const ids = Array.from(new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return Promise.resolve(null);
  const ledger = options?.ledger === true;
  const idKey = ids.slice().sort().join(",");
  const key = ledger ? `ledger:${idKey}` : idKey;
  const existing = scopedInFlight.get(key);
  if (existing) return existing;
  const query = `/api/v1/accounts/balances?ids=${encodeURIComponent(idKey)}${ledger ? "&ledger=1" : ""}`;
  const request = (async () => {
    try {
      const res = await fetch(query, { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("application/json")) return null;
      const payload = await res.json() as {
        ok?: boolean;
        baseCurrency?: string;
        data?: ScopedAccountBalance[];
      };
      if (!payload?.ok || !Array.isArray(payload.data)) return null;
      return {
        ok: true as const,
        baseCurrency: String(payload.baseCurrency || "CNY"),
        data: payload.data,
        // 账面口径的数值不参与统计缓存，直接不给总额增量。
        totalConvertedBalance: ledger ? null : applyScopedConvertedBalanceDelta(payload.data),
      };
    } catch {
      return null;
    } finally {
      scopedInFlight.delete(key);
    }
  })();
  scopedInFlight.set(key, request);
  return request;
}
