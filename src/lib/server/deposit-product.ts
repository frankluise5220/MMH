import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency, normalizeOptionalCurrency } from "@/lib/currency";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export type ResolveDepositProductInput = {
  householdId: string;
  productId?: string | null;
  name?: string | null;
  currency?: string | null;
  institutionId?: string | null;
  annualRate?: number | null;
  termDays?: number | null;
  shortName?: string | null;
  note?: string | null;
};

function parsePositiveNumber(raw: unknown) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function sameNameCurrencyError(existingCurrency: string, requestedCurrency: string) {
  return `Same-name deposit product already exists, but its currency is ${existingCurrency}; the current currency is ${requestedCurrency}`;
}

/**
 * Resolves an institution-scoped deposit product master.
 * Identity is household + institution + name. Currency mismatch on the same name is an error.
 * Per-lot rate/term stay on the deposit record; product defaults are optional fill-ins.
 *
 * `productId` 是主键级身份，优先于「机构 + 名称」：household 内命中即采用。
 * 旧实现在按 id 查询时附带 institutionId 过滤，机构对不上会静默落到下面的同名分支，
 * 造成两类静默错误（2026-09-30 实测复现）：
 *   - 改指到同名的另一条产品：lot 引用 `dprod_5fa439df…`（institutionId = NULL），
 *     当前存款账户在恒丰 → 返回的是恒丰同名行，用户选的产品被换掉；
 *   - 新建一条同名重复产品：lot 引用 `1年期`（institutionId = NULL），当前机构下无同名行
 *     → 直接 create 出 `1年期@民泰`，明明选的是已有产品。
 */
export async function resolveOrCreateDepositProduct(tx: Db, input: ResolveDepositProductInput) {
  const householdId = input.householdId;
  const productId = String(input.productId ?? "").trim();
  const name = String(input.name ?? "").trim();
  const institutionId = String(input.institutionId ?? "").trim() || null;
  const requestedCurrency = normalizeOptionalCurrency(input.currency);
  const targetCurrency = requestedCurrency ? normalizeCurrency(requestedCurrency) : "CNY";
  const annualRate = parsePositiveNumber(input.annualRate);
  const termDaysRaw = parsePositiveNumber(input.termDays);
  const termDays = termDaysRaw == null ? null : Math.round(termDaysRaw);
  const shortName = String(input.shortName ?? "").trim() || null;
  const note = String(input.note ?? "").trim() || null;

  if (productId) {
    const byId = await tx.depositProduct.findFirst({
      where: { id: productId, householdId },
    });
    if (byId) {
      if (requestedCurrency && normalizeCurrency(byId.currency) !== targetCurrency) {
        throw new Error(sameNameCurrencyError(normalizeCurrency(byId.currency), targetCurrency));
      }
      // 迁移遗留的产品 institutionId = NULL，而 GET /api/v1/deposit-products 按机构过滤，
      // 这类产品在任何机构的下拉里都查不到（实测：库中 7 条）。被某机构下的存单引用时
      // 就地收敛：该机构已有同名产品（唯一键 householdId+institutionId+name）则改指那条，
      // 否则认领到该机构，让它在对应机构的下拉里重新可见。
      if (institutionId && !byId.institutionId) {
        const twin = await tx.depositProduct.findFirst({
          where: { householdId, institutionId, name: byId.name },
        });
        if (twin) {
          if (normalizeCurrency(twin.currency) !== targetCurrency) {
            throw new Error(sameNameCurrencyError(normalizeCurrency(twin.currency), targetCurrency));
          }
          return twin;
        }
        return tx.depositProduct.update({
          where: { id: byId.id },
          data: { institutionId },
        });
      }
      return byId;
    }
  }

  if (!name) return null;

  const existing = await tx.depositProduct.findFirst({
    where: { householdId, institutionId, name },
  });
  if (existing) {
    if (normalizeCurrency(existing.currency) !== targetCurrency) {
      throw new Error(sameNameCurrencyError(normalizeCurrency(existing.currency), targetCurrency));
    }
    return existing;
  }

  return tx.depositProduct.create({
    data: {
      householdId,
      institutionId,
      name,
      shortName,
      currency: targetCurrency,
      annualRate,
      termDays,
      note,
      isActive: true,
    },
  });
}
