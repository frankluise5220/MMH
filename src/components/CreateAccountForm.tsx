"use client";

import { useState } from "react";
import { NestedAddModal } from "./EntityCreateForm";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { institutionTypeLabel } from "@/lib/account-kinds";

type AccountKindValue = "cash" | "bank_debit" | "bank_credit" | "ewallet" | "investment" | "loan" | "other";
type FundProductTypeValue = "fund" | "money" | "wealth" | "deposit";

const FUND_PRODUCT_LABELS: Record<FundProductTypeValue, string> = {
  fund: "开放式基金",
  money: "货币基金",
  wealth: "银行理财",
  deposit: "活期/存款",
};

type InstitutionWithType = { id: string; name: string; type?: string };

export function CreateAccountForm({
  groups,
  institutions,
  action,
}: {
  groups: { id: string; name: string }[];
  institutions: InstitutionWithType[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [kind, setKind] = useState<AccountKindValue>("other");
  const [investProductType, setInvestProductType] = useState<FundProductTypeValue>("fund");
  const [groupId, setGroupId] = useState("");
  const [institutionId, setInstitutionId] = useState("");
  const [groupList, setGroupList] = useState(groups);
  const [institutionList, setInstitutionList] = useState<InstitutionWithType[]>(institutions);
  const [nestedOpen, setNestedOpen] = useState<"institution" | "group" | null>(null);

  const isBillLike = kind === "bank_credit" || kind === "loan";

  function handleInstitutionCreated(id: string, name: string, extra?: { type?: string }) {
    setInstitutionList(prev => [...prev, { id, name, type: extra?.type }]);
    if (kind === "loan" ? extra?.type === "debt" : extra?.type !== "debt") setInstitutionId(id);
  }

  function handleGroupCreated(id: string, name: string) {
    setGroupList(prev => [...prev, { id, name }]);
    setGroupId(id);
  }

  const filteredInstitutionList = institutionList.filter((it) =>
    kind === "loan" ? it.type === "debt" : it.type !== "debt"
  );

  const institutionOptions: SmartSelectOption[] = [
    ...filteredInstitutionList.map(it => ({
      id: it.id,
      label: it.name,
      subLabel: institutionTypeLabel(it.type ?? null),
    })),
  ];

  const groupOptions: SmartSelectOption[] = [
    ...groupList.map(g => ({
      id: g.id,
      label: g.name,
    })),
  ];

  return (
    <>
      <form action={action} className="grid grid-cols-1 gap-3">
        <input
          name="accountName"
          className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
          placeholder="账户名称，例如：招行3833 / 微信零钱 / 余额宝"
          required
        />

        <div className="grid grid-cols-2 gap-2">
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
            <option value="investment">投资</option>
            <option value="loan">债务/债权</option>
            <option value="other">其他</option>
          </select>
          <input
            name="currency"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
            defaultValue="CNY"
            placeholder="币种"
          />
        </div>

        {kind === "investment" && (
          <div className="space-y-1.5">
            <div className="text-xs text-slate-500">投资产品类型</div>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(FUND_PRODUCT_LABELS) as FundProductTypeValue[]).map((pt) => (
                <button
                  key={pt}
                  type="button"
                  onClick={() => setInvestProductType(pt)}
                  className={`h-8 rounded-md border text-xs ${
                    investProductType === pt
                      ? "bg-blue-50 text-blue-700 border-blue-200 font-medium"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {FUND_PRODUCT_LABELS[pt]}
                </button>
              ))}
            </div>
            <input type="hidden" name="investProductType" value={investProductType} />
          </div>
        )}

        {isBillLike && (
          <div className="grid grid-cols-2 gap-2">
            <input
              name="billingDay"
              className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder="账单日 1-31"
              inputMode="numeric"
            />
            <input
              name="repaymentDay"
              className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder="还款日 1-31"
              inputMode="numeric"
            />
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs text-slate-500">所有人</div>
          <SmartSelect
            mode="single"
            value={groupId}
            onChange={setGroupId}
            options={groupOptions}
            placeholder="选择所有人"
            onCreateClick={() => setNestedOpen("group")}
            createLabel="新增所有人"
          />
          <input type="hidden" name="groupId" value={groupId} />
        </div>

        <div className="space-y-1">
          <div className="text-xs text-slate-500">往来机构/人员</div>
          <SmartSelect
            mode="single"
            value={institutionId}
            onChange={setInstitutionId}
            options={institutionOptions}
            placeholder="选择往来机构/人员"
            searchable={true}
            onCreateClick={() => setNestedOpen("institution")}
            createLabel="新增往来机构/人员"
          />
          <input type="hidden" name="institutionId" value={institutionId} />
        </div>

        <button
          type="submit"
          className="h-9 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
        >
          保存账户
        </button>
      </form>

      <NestedAddModal
        mode="compact"
        entityType="group"
        open={nestedOpen === "group"}
        onClose={() => setNestedOpen(null)}
        onCreated={handleGroupCreated}
      />
      <NestedAddModal
        mode="compact"
        entityType="institution"
        open={nestedOpen === "institution"}
        onClose={() => setNestedOpen(null)}
        onCreated={handleInstitutionCreated}
        defaultType={kind === "loan" ? "debt" : undefined}
      />
    </>
  );
}
