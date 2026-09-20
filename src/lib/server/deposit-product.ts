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
      where: { id: productId, householdId, ...(institutionId ? { institutionId } : {}) },
    });
    if (byId) {
      if (requestedCurrency && normalizeCurrency(byId.currency) !== targetCurrency) {
        throw new Error(sameNameCurrencyError(normalizeCurrency(byId.currency), targetCurrency));
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
