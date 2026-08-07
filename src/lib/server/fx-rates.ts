import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { toNumber } from "@/lib/date-utils";

const FX_RATE_SOURCE = "frankfurter";

function dateOnlyUtc(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseRate(value: unknown) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export type CurrencyAmount = {
  amount: number;
  currency?: string | null;
};

export type ConversionRate = {
  fromCurrency: string;
  toCurrency: string;
  rate: number | null;
  rateDate: string | null;
  source: string | null;
  missing: boolean;
};

export async function getHouseholdBaseCurrency(householdId: string) {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { baseCurrency: true },
  });
  return normalizeCurrency(household?.baseCurrency);
}

async function fetchExternalRate(fromCurrency: string, toCurrency: string) {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (from === to) {
    return { rate: 1, rateDate: ymd(dateOnlyUtc()), source: "same_currency" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const rate = parseRate(data?.rates?.[to]);
    const dateText = typeof data?.date === "string" ? data.date : ymd(dateOnlyUtc());
    if (!rate) return null;
    return { rate, rateDate: dateText, source: FX_RATE_SOURCE };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function setFxRate(params: {
  householdId: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate?: Date | string | null;
  source?: string;
}) {
  const fromCurrency = normalizeCurrency(params.fromCurrency);
  const toCurrency = normalizeCurrency(params.toCurrency);
  const rate = parseRate(params.rate);
  if (!rate) throw new Error("汇率不正确");
  const rateDate = typeof params.rateDate === "string"
    ? dateOnlyUtc(new Date(params.rateDate))
    : params.rateDate instanceof Date
      ? dateOnlyUtc(params.rateDate)
      : dateOnlyUtc();
  return prisma.fxRate.upsert({
    where: {
      householdId_baseCurrency_quoteCurrency_rateDate: {
        householdId: params.householdId,
        baseCurrency: fromCurrency,
        quoteCurrency: toCurrency,
        rateDate,
      },
    },
    create: {
      householdId: params.householdId,
      baseCurrency: fromCurrency,
      quoteCurrency: toCurrency,
      rate,
      rateDate,
      source: params.source ?? "manual",
    },
    update: {
      rate,
      source: params.source ?? "manual",
    },
  });
}

export async function getConversionRate(params: {
  householdId: string;
  fromCurrency: string;
  toCurrency: string;
  refreshMissing?: boolean;
}): Promise<ConversionRate> {
  const fromCurrency = normalizeCurrency(params.fromCurrency);
  const toCurrency = normalizeCurrency(params.toCurrency);
  if (fromCurrency === toCurrency) {
    return { fromCurrency, toCurrency, rate: 1, rateDate: ymd(dateOnlyUtc()), source: "same_currency", missing: false };
  }

  const cached = await prisma.fxRate.findFirst({
    where: {
      householdId: params.householdId,
      baseCurrency: fromCurrency,
      quoteCurrency: toCurrency,
    },
    orderBy: [{ rateDate: "desc" }, { updatedAt: "desc" }],
  });
  if (cached) {
    return {
      fromCurrency,
      toCurrency,
      rate: toNumber(cached.rate),
      rateDate: ymd(cached.rateDate),
      source: cached.source,
      missing: false,
    };
  }

  if (params.refreshMissing) {
    const external = await fetchExternalRate(fromCurrency, toCurrency);
    if (external) {
      const row = await setFxRate({
        householdId: params.householdId,
        fromCurrency,
        toCurrency,
        rate: external.rate,
        rateDate: external.rateDate,
        source: external.source,
      });
      return {
        fromCurrency,
        toCurrency,
        rate: toNumber(row.rate),
        rateDate: ymd(row.rateDate),
        source: row.source,
        missing: false,
      };
    }
  }

  return { fromCurrency, toCurrency, rate: null, rateDate: null, source: null, missing: true };
}

export async function convertCurrencyAmount(params: {
  householdId: string;
  amount: number;
  fromCurrency?: string | null;
  toCurrency: string;
  refreshMissing?: boolean;
}) {
  const rate = await getConversionRate({
    householdId: params.householdId,
    fromCurrency: params.fromCurrency ?? "CNY",
    toCurrency: params.toCurrency,
    refreshMissing: params.refreshMissing,
  });
  if (rate.rate == null) return { amount: null as number | null, rate };
  return { amount: params.amount * rate.rate, rate };
}

export async function convertCurrencyAmounts(params: {
  householdId: string;
  amounts: CurrencyAmount[];
  toCurrency: string;
  refreshMissing?: boolean;
}) {
  const toCurrency = normalizeCurrency(params.toCurrency);
  const sourceCurrencies = Array.from(new Set(params.amounts.map((item) => normalizeCurrency(item.currency))));
  const rates = new Map<string, ConversionRate>();
  const rateRows = await Promise.all(sourceCurrencies.map((source) => getConversionRate({
      householdId: params.householdId,
      fromCurrency: source,
      toCurrency,
      refreshMissing: params.refreshMissing,
    })));
  for (const rate of rateRows) {
    rates.set(rate.fromCurrency, rate);
  }

  let total = 0;
  const missingCurrencies: string[] = [];
  for (const item of params.amounts) {
    const source = normalizeCurrency(item.currency);
    const rate = rates.get(source);
    if (!rate || rate.rate == null) {
      if (!missingCurrencies.includes(source)) missingCurrencies.push(source);
      continue;
    }
    total += item.amount * rate.rate;
  }

  return {
    total,
    toCurrency,
    rates: Array.from(rates.values()),
    missingCurrencies,
  };
}
