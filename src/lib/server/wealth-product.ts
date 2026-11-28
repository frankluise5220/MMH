import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ResolveWealthProductInput = {
  householdId: string;
  /** 产品主数据身份优先于「机构 + 名称」：命中即采用。 */
  productId?: string | null;
  name?: string | null;
  /** 产品家族：wealth=理财（默认），advisor=投顾组合。查重与新建都按家族隔离。 */
  productType?: string | null;
  /**
   * 显式币种：调用方应传「买入账户」＝资金来源账户的币种（这笔买入实际结算的币种），
   * 投资账户币种只作 `fallbackCurrency`。缺省时按 `fallbackCurrency` 落库。
   */

  currency?: string | null;
  fallbackCurrency?: string | null;
  institutionId?: string | null;
  annualRate?: number | null;
};

function parsePositiveNumber(raw: unknown) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
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
 * `wealthAcc.currency ?? "CNY"` vs `recordCurrency ?? investAcc.currency`). A
 * foreign-currency wealth certificate could therefore be written with different
 * `WealthProduct.currency` depending on which entry path created it — the same
 * ledger, two different product masters.
 *
 * Rules, in order:
 * - `productId` is primary-key identity: it is matched by id inside the
 *   household and adopted as-is.
 *   A product with `institutionId = null` is a **universal product** and stays
 *   universal — buying it from one institution must not bind it to that one.
 * - Otherwise a product with the same institution + name is adopted as-is.
 * - Otherwise the product is created with `currency ?? fallbackCurrency ?? "CNY"`.
 *
 * **Currency is creation-time metadata, never an identity key.** An existing
 * master is adopted whatever its currency: the same fund can be held in
 * different currencies (share classes), and rows recorded before the currency
 * was aligned must stay editable. Rejecting a mismatch here stranded users who
 * could not save or re-save their own record (2026-11-27: a USD-mastered fund
 * inside an HKD wealth account failed on every edit with "Same-name wealth
 * product already exists, but its currency is USD; the current currency is
 * HKD"). Duplicate masters are already impossible — the unique key above fixes
 * one master per institution + name, so the first creator's currency wins.
 *
 * The resolver never mutates an existing product's terms: master data is
 * maintained through the product card (`/api/v1/wealth-products`).
 */
export async function resolveOrCreateWealthProduct(tx: Db, input: ResolveWealthProductInput) {
  const householdId = input.householdId;
  const productId = String(input.productId ?? "").trim();
  const name = String(input.name ?? "").trim();
  const productType = input.productType === "advisor" ? "advisor" : "wealth";
  const institutionId = String(input.institutionId ?? "").trim() || null;
  const requestedCurrency = normalizeOptionalCurrency(input.currency);
  const fallbackCurrency = normalizeOptionalCurrency(input.fallbackCurrency);
  const targetCurrency = normalizeCurrency(requestedCurrency ?? fallbackCurrency ?? "CNY");
  const annualRate = parsePositiveNumber(input.annualRate);

  // 投顾产品没有「通用（不限机构）」这一档（2026-11-03 用户裁定）：落账路径也必须带机构，
  // 否则会凭空造出一个没有机构的投顾产品，产品库和投顾下拉都再也选不到它。
  if (productType === "advisor" && !institutionId) {
    throw new Error("投顾产品必须指定所属机构");
  }

  if (productId) {
    const byId = await tx.wealthProduct.findFirst({
      where: { id: productId, householdId },
    });
    if (byId) {
      // 主键命中的产品一律照用，不校验币种：产品币种是建主数据时的属性，
      // 不是身份键；台账里已有「USD 主数据 + HKD 理财账户」的历史记录，
      // 校验币种会让这些记录再也保存不了（2026-11-27 用户报错）。
      // 无机构产品是「通用产品」：产品下拉对所有机构都会列出它，落账时也必须保持
      // institutionId = null。旧实现在这里把它就地收敛到当前机构，结果是第一个买入它的
      // 机构把通用产品变成了自己的专属产品（其它机构此后就选不到了），已在 2026-11-02 移除。
      return byId;
    }
  }

  if (!name) return null;

  const existing = await tx.wealthProduct.findFirst({
    where: { householdId, institutionId, name, productType },
  });
  // 同名（同机构）主数据已存在就沿用，币种不一致也不报错——见上方说明。
  if (existing) return existing;

  return tx.wealthProduct.create({
    data: {
      householdId,
      institutionId,
      name,
      productType,
      currency: targetCurrency,
      annualRate,
      isActive: true,
    },
  });
}
