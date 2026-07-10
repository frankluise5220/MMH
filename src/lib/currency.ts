type AccountCurrencyLike = {
  readonly name?: string | null;
  readonly currency?: string | null;
};

export function normalizeCurrency(value: unknown) {
  const text = String(value ?? "CNY").trim().toUpperCase();
  return text || "CNY";
}

export function resolveSameCurrencyTransfer(fromAccount: AccountCurrencyLike, toAccount: AccountCurrencyLike) {
  const fromCurrency = normalizeCurrency(fromAccount.currency);
  const toCurrency = normalizeCurrency(toAccount.currency);
  if (fromCurrency !== toCurrency) {
    const fromName = fromAccount.name?.trim() || "转出账户";
    const toName = toAccount.name?.trim() || "转入账户";
    throw new Error(`普通转账只支持同币种账户。${fromName} 是 ${fromCurrency}，${toName} 是 ${toCurrency}；跨币种需要使用换汇/跨币种转账流程。`);
  }
  return fromCurrency;
}
