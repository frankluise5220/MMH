import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ResolveWealthProductInput = {
  householdId: string;
  /** 产品主数据身份优先于「机构 + 名称」：命中即采用。 */
  productId?: string | null;
  name?: string | null;
  /** 显式币种；缺省时按 `fallbackCurrency`（账户币种）落库。 */
  currency?: string | null;
  fallbackCurrency?: string | null;
  institutionId?: string | null;
  annualRate?: number | null;
};

function parsePositiveNumber(raw: unknown) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function currencyMismatchError(existing: string, requested: string) {
  return `Same-name wealth product already exists, but its currency is ${existing}; the current currency is ${requested}`;
}

/**
 * Resolves an institution-scoped wealth product master. Identity is
 * household + institution + name (`@@unique([householdId, institutionId, name])`),
 * mirroring `resolveOrCreateDepositProduct`.
 *
 * Before this module existed the same lookup was hand-written in four places
 * (`transactions/detail` POST/PUT split-wealth paths and two spots in
 * `sidebar-actions/transaction-actions`), each inventing its own `currency`
 * fallback chain (`wealthAcc.currency ?? cashAcc.currency ?? "CNY"` vs
 * `wealthAcc.currency ?? "CNY"` vs `recordCurrency ?? investAcc.currency`), and
 * only one of them verified the currency of an explicitly chosen product. A
 * foreign-currency wealth certificate could therefore be written with different
 * `WealthProduct.currency` depending on which entry path created it — the same
 * ledger, two different product masters.
 *
 * Rules, in order:
 * - `productId` is primary-key identity: it is matched by id inside the
 *   household and its currency is validated against the requested one.
 *   A product with `institutionId = null` is a **universal product** and stays
 *   universal — buying it from one institution must not bind it to that one.
 * - Otherwise a product with the same institution + name is adopted; a currency
 *   mismatch is an error, never a silent duplicate.
 * - Otherwise the product is created with `currency ?? fallbackCurrency ?? "CNY"`.
 *
 * The resolver never mutates an existing product's terms: master data is
 * maintained through the product card (`/api/v1/wealth-products`).
 */
export async function resolveOrCreateWealthProduct(tx: Db, input: ResolveWealthProductInput) {
  const householdId = input.householdId;
  const productId = String(input.productId ?? "").trim();
  const name = String(input.name ?? "").trim();
  const institutionId = String(input.institutionId ?? "").trim() || null;
  const requestedCurrency = normalizeOptionalCurrency(input.currency);
  const fallbackCurrency = normalizeOptionalCurrency(input.fallbackCurrency);
  const targetCurrency = normalizeCurrency(requestedCurrency ?? fallbackCurrency ?? "CNY");
  const annualRate = parsePositiveNumber(input.annualRate);

  if (productId) {
    const byId = await tx.wealthProduct.findFirst({
      where: { id: productId, householdId },
    });
    if (byId) {
      if (requestedCurrency && normalizeCurrency(byId.currency) !== targetCurrency) {
        throw new Error(currencyMismatchError(normalizeCurrency(byId.currency), targetCurrency));
      }
      // 无机构产品是「通用产品」：产品下拉对所有机构都会列出它，落账时也必须保持
      // institutionId = null。旧实现在这里把它就地收敛到当前机构，结果是第一个买入它的
      // 机构把通用产品变成了自己的专属产品（其它机构此后就选不到了），已在 2026-11-02 移除。
      return byId;
    }
  }

  if (!name) return null;

  const existing = await tx.wealthProduct.findFirst({
    where: { householdId, institutionId, name },
  });
  if (existing) {
    if (normalizeCurrency(existing.currency) !== targetCurrency) {
      throw new Error(currencyMismatchError(normalizeCurrency(existing.currency), targetCurrency));
    }
    return existing;
  }

  return tx.wealthProduct.create({
    data: {
      householdId,
      institutionId,
      name,
      currency: targetCurrency,
      annualRate,
      isActive: true,
    },
  });
}
