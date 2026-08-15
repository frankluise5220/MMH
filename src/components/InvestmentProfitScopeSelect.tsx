"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

export type InvestmentProfitScopeOption = {
  value: string;
  label: string;
  href: string;
  title?: string;
};

export function InvestmentProfitScopeSelect({
  selectedScope,
  allOption,
  institutionOptions,
  accountOptions,
}: {
  selectedScope: string;
  allOption: InvestmentProfitScopeOption;
  institutionOptions: InvestmentProfitScopeOption[];
  accountOptions: InvestmentProfitScopeOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [draftScope, setDraftScope] = useState(selectedScope);
  const { t } = useI18n();
  const optionByValue = new Map(
    [
      allOption,
      ...institutionOptions,
      ...accountOptions,
    ].map((option) => [option.value, option]),
  );

  useEffect(() => {
    setDraftScope(selectedScope);
  }, [selectedScope]);

  return (
    <label className="flex shrink-0 items-center gap-1.5">
      <span className="text-xs font-medium text-slate-500">{t("investmentProfitScope.scopeLabel")}</span>
      <select
        value={draftScope}
        disabled={isPending}
        onChange={(event) => {
          const nextScope = event.currentTarget.value;
          const option = optionByValue.get(nextScope);
          if (!option) return;
          setDraftScope(nextScope);
          startTransition(() => {
            router.push(option.href, { scroll: false });
          });
        }}
        className="h-8 w-64 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
      >
        <option value={allOption.value}>{allOption.label}</option>
        {institutionOptions.length ? (
          <optgroup label={t("investmentProfitScope.byInstitution")}>
            {institutionOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {accountOptions.length ? (
          <optgroup label={t("investmentProfitScope.byAccount")}>
            {accountOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}
