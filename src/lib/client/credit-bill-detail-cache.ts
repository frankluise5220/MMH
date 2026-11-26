import type { DetailEntry } from "@/components/DetailViewClient";
import { FINANCE_DATA_CHANGED_EVENT, financeChangeTouchesEntries, type FinanceDataChangedDetail } from "@/lib/client/refresh";

export type CreditBillDetailData = {
  billMonth: string;
  showAllDetails: boolean;
  totalCount: number;
  entries: DetailEntry[];
  cycle?: { statementMonth?: string; periodLabel?: string; isCurrentCycle?: boolean } | null;
};

type Scope = { householdId: string; accountId: string; billMonth: string; accountIds: readonly string[] };
type Stored = { scope: Scope; data: CreditBillDetailData; expiresAt: number; bytes: number };
type Request = { scope: Scope; valid: boolean; promise: Promise<CreditBillDetailData | undefined> };

/** A retention budget limits memory, never the number of rows returned to a caller. */
export class CreditBillDetailCache {
  private values = new Map<string, Stored>();
  private requests = new Map<string, Request>();
  private bytes = 0;

  constructor(private maxBytes = 8 * 1024 * 1024, private ttlMs = 10 * 60 * 1000) {}

  private key(scope: Scope) {
    return JSON.stringify([scope.householdId, scope.accountId, scope.billMonth, [...scope.accountIds].sort()]);
  }

  read(scope: Scope) {
    const key = this.key(scope);
    const stored = this.values.get(key);
    if (!stored) return undefined;
    this.values.delete(key);
    if (stored.expiresAt <= Date.now()) {
      this.bytes -= stored.bytes;
      return undefined;
    }
    this.values.set(key, stored);
    return stored.data;
  }

  async load(scope: Scope, fetchData: () => Promise<CreditBillDetailData>) {
    const cached = this.read(scope);
    if (cached) return cached;
    const key = this.key(scope);
    const pending = this.requests.get(key);
    if (pending) return pending.promise;
    const request: Request = {
      scope, valid: true,
      promise: Promise.resolve().then(fetchData).then((data) => {
        if (!request.valid) return undefined;
        // UTF-16 payload size plus object overhead is an estimate, not heap telemetry.
        const bytes = JSON.stringify(data).length * 2 + data.entries.length * 256 + 512;
        if (scope.billMonth !== "all" && data.entries.length === data.totalCount && bytes <= this.maxBytes) {
          while (this.bytes + bytes > this.maxBytes && this.values.size) {
            const oldest = this.values.keys().next().value!;
            this.bytes -= this.values.get(oldest)!.bytes;
            this.values.delete(oldest);
          }
          this.values.set(key, { scope, data, bytes, expiresAt: Date.now() + this.ttlMs });
          this.bytes += bytes;
        }
        return data;
      }).catch((error: unknown) => {
        if (request.valid) throw error;
        return undefined;
      }).finally(() => {
        if (this.requests.get(key) === request) this.requests.delete(key);
      }),
    };
    this.requests.set(key, request);
    return request.promise;
  }

  invalidate(accountIds?: readonly string[]) {
    const ids = new Set(accountIds);
    const affected = (scope: Scope) => !ids.size || ids.has(scope.accountId) || scope.accountIds.some((id) => ids.has(id));
    for (const [key, stored] of this.values) {
      if (!affected(stored.scope)) continue;
      this.bytes -= stored.bytes;
      this.values.delete(key);
    }
    for (const [key, request] of this.requests) {
      if (!affected(request.scope)) continue;
      request.valid = false;
      this.requests.delete(key);
    }
  }
}

export const creditBillDetailCache = new CreditBillDetailCache();

// Keep offscreen accounts current even when their detail panel is unmounted.
if (typeof window !== "undefined") {
  window.addEventListener(FINANCE_DATA_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail ?? {};
    if (financeChangeTouchesEntries(detail)) creditBillDetailCache.invalidate(detail.accountIds);
  });
}
