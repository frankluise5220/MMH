type AccountCurrencyLike = {
  readonly name?: string | null;
  readonly currency?: string | null;
};

export const CURRENCY_OPTIONS = [
  { value: "CNY" },
  { value: "USD" },
  { value: "JPY" },
  { value: "EUR" },
  { value: "HKD" },
  { value: "GBP" },
] as const;

export function normalizeCurrency(value: unknown) {
  const text = String(value ?? "CNY").trim().toUpperCase();
  return text || "CNY";
}

export function normalizeOptionalCurrency(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

export function resolveSameCurrencyTransfer(fromAccount: AccountCurrencyLike, toAccount: AccountCurrencyLike) {
  const fromCurrency = normalizeCurrency(fromAccount.currency);
  const toCurrency = normalizeCurrency(toAccount.currency);
  if (fromCurrency !== toCurrency) {
    const fromName = fromAccount.name?.trim() || "source account";
    const toName = toAccount.name?.trim() || "target account";
    throw new Error(
      `Standard transfers only support accounts with the same currency. ${fromName} is ${fromCurrency}, ${toName} is ${toCurrency}; use the currency exchange or cross-currency transfer flow for different currencies.`
    );
  }
  return fromCurrency;
}
