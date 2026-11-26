import assert from "node:assert/strict";
import { CreditBillDetailCache, type CreditBillDetailData } from "../src/lib/client/credit-bill-detail-cache";

const scope = (accountId: string, billMonth = "2026-11", accountIds = [accountId]) => ({ householdId: "household-1", accountId, billMonth, accountIds });
const data = (billMonth = "2026-11", totalCount = 0): CreditBillDetailData => ({ billMonth, showAllDetails: false, entries: [], totalCount });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const cache = new CreditBillDetailCache();
  let fetches = 0;
  const value = data();
  const fetchData = async () => { fetches += 1; return value; };
  await Promise.all([cache.load(scope("a"), fetchData), cache.load(scope("a"), fetchData)]);
  assert.equal(fetches, 1, "Concurrent reads share a request");
  assert.equal(await cache.load(scope("a"), fetchData), value);
  assert.equal(fetches, 1, "Warm reads avoid a request");
  assert.equal(cache.read({ ...scope("a"), householdId: "household-2" }), undefined, "Households cannot share a cached result");
  await cache.load(scope("other"), fetchData);
  await cache.load(scope("primary", "2026-11", ["primary", "supplementary"]), fetchData);
  cache.invalidate(["supplementary"]);
  assert.equal(cache.read(scope("primary", "2026-11", ["primary", "supplementary"])), undefined);
  assert.equal(cache.read(scope("other")), value, "Unrelated accounts retain their cache");

  const stale = deferred<CreditBillDetailData>();
  const pending = cache.load(scope("race"), () => stale.promise);
  cache.invalidate(["race"]);
  const fresh = data("2026-10");
  assert.equal(await cache.load(scope("race"), async () => fresh), fresh);
  stale.resolve(value);
  assert.equal(await pending, undefined, "Invalidated responses cannot reach the display");
  assert.equal(cache.read(scope("race")), fresh, "Old completion cannot replace the fresh value");

  await cache.load(scope("partial"), async () => data("2026-11", 501));
  assert.equal(cache.read(scope("partial")), undefined, "Partial responses are never treated as complete");
  const small = new CreditBillDetailCache(1);
  assert.equal(await small.load(scope("large"), async () => value), value, "Budget never truncates a result");
  assert.equal(small.read(scope("large")), undefined);
  const expiring = new CreditBillDetailCache(1024, -1);
  await expiring.load(scope("expired"), async () => value);
  assert.equal(expiring.read(scope("expired")), undefined);
  const bounded = new CreditBillDetailCache(1300);
  await bounded.load(scope("oldest"), async () => value);
  await bounded.load(scope("newest"), async () => value);
  assert.equal(bounded.read(scope("oldest")), undefined, "Memory pressure evicts oldest values");
  assert.equal(bounded.read(scope("newest")), value);
  cache.invalidate();
  assert.equal(cache.read(scope("other")), undefined);
  console.log("Credit detail cache: reuse, scoped invalidation, races, completeness and budget passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
