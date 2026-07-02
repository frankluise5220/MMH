"use client";

import { useMemo, useState } from "react";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { EntityCreateForm } from "./EntityCreateForm";
import { institutionTypeLabel } from "@/lib/account-kinds";
import { isDepositAccount } from "@/lib/account-kind-utils";

type GroupOption = { id: string; name: string };
type InstitutionOption = { id: string; name: string; type?: string };
type FundQueryApiOption = { id: string; code: string; name: string };
type AccountKindValue =
  | "cash"
  | "bank_debit"
  | "bank_credit"
  | "ewallet"
  | "deposit"
  | "investment"
  | "loan"
  | "other";
type FundProductTypeValue = "fund" | "money" | "wealth";
type CostBasisMethodValue = "moving_avg" | "fifo" | "lifo";

const FUND_PRODUCT_LABELS: Record<FundProductTypeValue, string> = {
  fund: "开放式基金",
  money: "货币基金",
  wealth: "银行理财",
};

const COST_BASIS_LABELS: Record<CostBasisMethodValue, string> = {
  moving_avg: "移动平均",
  fifo: "先进先出 FIFO",
  lifo: "后进先出 LIFO",
};

export function AccountEditModalButton({
  label,
  title,
  account,
  groups,
  institutions,
  fundQueryApis,
  action,
  variant = "default",
}: {
  label: string;
  title: string;
  account: {
    id: string;
    name: string;
    groupId: string;
    institutionId: string | null;
    kind: AccountKindValue;
    currency: string;
    billingDay: number | null;
    repaymentDay: number | null;
    creditLimit: string | null;
    numberMasked: string | null;
    investProductType: string | null;
    costBasisMethod: string | null;
    defaultFundQueryApiId: string | null;
    fundUnitsDecimals?: number | null;
    debtDirection?: string | null;
  };
  groups: GroupOption[];
  institutions: InstitutionOption[];
  fundQueryApis: FundQueryApiOption[];
  action: (formData: FormData) => void | Promise<void>;
  variant?: "default" | "credit";
}) {
  const [open, setOpen] = useState(false);
  const normalizedKind = isDepositAccount(account) ? "deposit" : account.kind;
  const [kind, setKind] = useState<AccountKindValue>(normalizedKind);
  const [investProductType, setInvestProductType] = useState<FundProductTypeValue>(
    normalizedKind === "investment" ? ((account.investProductType as FundProductTypeValue) ?? "fund") : "fund",
  );
  const [costBasisMethod, setCostBasisMethod] = useState<CostBasisMethodValue>(
    (account.costBasisMethod as CostBasisMethodValue) ?? "moving_avg",
  );
  const [groupId, setGroupId] = useState(account.groupId);
  const [institutionId, setInstitutionId] = useState(account.institutionId ?? "");
  const [groupList, setGroupList] = useState(groups);
  const [institutionList, setInstitutionList] = useState<InstitutionOption[]>(institutions);
  const [nestedEntityType, setNestedEntityType] = useState<"institution" | "group" | null>(null);

  const buttonClassName =
    variant === "credit"
      ? "h-8 rounded-md border border-blue-200 bg-blue-50 px-2 text-xs text-blue-700 hover:bg-blue-100"
      : "h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50";

  const initialCreditLimit = useMemo(() => account.creditLimit ?? "", [account.creditLimit]);

  function handleInstitutionCreated(id: string, name: string, extra?: { type?: string }) {
    setInstitutionList((prev) => [...prev, { id, name, type: extra?.type }]);
    if (kind === "loan" ? extra?.type === "debt" : extra?.type !== "debt") {
      setInstitutionId(id);
    }
    setNestedEntityType(null);
  }

  function handleGroupCreated(id: string, name: string) {
    setGroupList((prev) => [...prev, { id, name }]);
    setGroupId(id);
    setNestedEntityType(null);
  }

  const filteredInstitutionList = institutionList.filter((it) =>
    kind === "loan" ? it.type === "debt" : it.type !== "debt",
  );

  const institutionOptions: SmartSelectOption[] = filteredInstitutionList.map((it) => ({
    id: it.id,
    label: it.name,
    subLabel: institutionTypeLabel(it.type ?? null),
  }));

  const groupOptions: SmartSelectOption[] = groupList.map((g) => ({
    id: g.id,
    label: g.name,
  }));

  return (
    <>
      <button type="button" className={buttonClassName} onClick={() => setOpen(true)}>
        {label}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
          onMouseDown={() => setOpen(false)}
        >
          <div
            className="max-h-[calc(100vh-2rem)] w-[560px] max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">{title}</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              >
                ×
              </button>
            </div>

            <form action={action} className="mt-3 space-y-4">
              <input type="hidden" name="accountId" value={account.id} />
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="institutionId" value={institutionId} />

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  name="name"
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none sm:col-span-2"
                  defaultValue={account.name}
                />

                <div>
                  <div className="mb-1 text-xs text-slate-500">所有人</div>
                  <SmartSelect
                    mode="single"
                    value={groupId}
                    onChange={setGroupId}
                    options={groupOptions}
                    placeholder="选择所有人"
                    onCreateClick={() => setNestedEntityType("group")}
                    createLabel="新增所有人"
                  />
                </div>

                <div>
                  <div className="mb-1 text-xs text-slate-500">往来机构/人员</div>
                  <SmartSelect
                    mode="single"
                    value={institutionId}
                    onChange={setInstitutionId}
                    options={institutionOptions}
                    placeholder="选择往来机构/人员"
                    searchable
                    onCreateClick={() => setNestedEntityType("institution")}
                    createLabel="新增往来机构/人员"
                  />
                </div>

                <select
                  name="kind"
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as AccountKindValue);
                    setInstitutionId("");
                  }}
                >
                  <option value="cash">现金</option>
                  <option value="bank_debit">借记卡</option>
                  <option value="bank_credit">信用卡</option>
                  <option value="ewallet">电子钱包</option>
                  <option value="deposit">存款</option>
                  <option value="investment">投资</option>
                  <option value="loan">债务/债权</option>
                  <option value="other">其他</option>
                </select>

                {kind === "investment" ? (
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500">投资账户类型</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(Object.keys(FUND_PRODUCT_LABELS) as FundProductTypeValue[]).map((pt) => (
                        <button
                          key={pt}
                          type="button"
                          onClick={() => setInvestProductType(pt)}
                          className={`h-8 rounded-md border text-xs ${
                            investProductType === pt
                              ? "border-blue-200 bg-blue-50 font-medium text-blue-700"
                              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {FUND_PRODUCT_LABELS[pt]}
                        </button>
                      ))}
                    </div>
                    <input type="hidden" name="investProductType" value={investProductType} />
                    {investProductType === "fund" ? (
                      <>
                        <div className="mt-2 text-xs text-slate-500">份额位数</div>
                        <input
                          name="fundUnitsDecimals"
                          defaultValue={account.fundUnitsDecimals ?? 3}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                          inputMode="numeric"
                        />
                      </>
                    ) : null}
                    <div className="mt-2 text-xs text-slate-500">成本摊薄方式</div>
                    <select
                      name="costBasisMethod"
                      value={costBasisMethod}
                      onChange={(e) => setCostBasisMethod(e.target.value as CostBasisMethodValue)}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      {(Object.keys(COST_BASIS_LABELS) as CostBasisMethodValue[]).map((m) => (
                        <option key={m} value={m}>
                          {COST_BASIS_LABELS[m]}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 text-xs text-slate-500">默认净值查询 API</div>
                    <select
                      name="defaultFundQueryApiId"
                      defaultValue={account.defaultFundQueryApiId ?? ""}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      <option value="">默认（按优先级尝试）</option>
                      {fundQueryApis.map((api) => (
                        <option key={api.id} value={api.id}>
                          {api.name} ({api.code})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <input
                  name="currency"
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  defaultValue={account.currency}
                />
              </div>

                  {kind === "bank_credit" ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-xs font-semibold text-slate-700">账单与额度</div>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      name="numberMasked"
                      className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      defaultValue={account.numberMasked ?? ""}
                      placeholder="编号/尾号，例如：3833"
                    />
                    <input
                      name="creditLimit"
                      className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      defaultValue={initialCreditLimit}
                      placeholder="额度，例如：50000"
                      inputMode="decimal"
                    />
                    <input
                      name="billingDay"
                      className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      defaultValue={account.billingDay ?? ""}
                      placeholder="每月账单日 1-31"
                      inputMode="numeric"
                    />
                    <input
                      name="repaymentDay"
                      className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      defaultValue={account.repaymentDay ?? ""}
                      placeholder="每月还款日 1-31"
                      inputMode="numeric"
                    />
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="h-9 rounded-md bg-blue-600 px-3 text-sm text-white hover:bg-blue-700"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {nestedEntityType ? (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open
          onClose={() => setNestedEntityType(null)}
          onCreated={nestedEntityType === "institution" ? handleInstitutionCreated : handleGroupCreated}
          defaultType={kind === "loan" && nestedEntityType === "institution" ? "debt" : undefined}
        />
      ) : null}
    </>
  );
}
