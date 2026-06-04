"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { NestedAddModal } from "./NestedAddModal";

type AccountKindValue = "cash" | "bank_debit" | "bank_credit" | "ewallet" | "investment" | "loan" | "other";
type FundProductTypeValue = "fund" | "money" | "wealth" | "deposit";

const FUND_PRODUCT_LABELS: Record<FundProductTypeValue, string> = {
  fund: "开放式基金",
  money: "货币基金",
  wealth: "银行理财",
  deposit: "活期/存款",
};

export function CreateAccountForm({
  groups,
  institutions,
  action,
}: {
  groups: { id: string; name: string }[];
  institutions: { id: string; name: string }[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [kind, setKind] = useState<AccountKindValue>("other");
  const [investProductType, setInvestProductType] = useState<FundProductTypeValue>("fund");
  const [groupId, setGroupId] = useState("");
  const [institutionId, setInstitutionId] = useState("");
  const [groupList, setGroupList] = useState(groups);
  const [institutionList, setInstitutionList] = useState(institutions);
  const [nestedOpen, setNestedOpen] = useState<"institution" | "group" | null>(null);

  const isBillLike = kind === "bank_credit" || kind === "loan";

  function handleInstitutionCreated(id: string, name: string) {
    setInstitutionList(prev => [...prev, { id, name }]);
    setInstitutionId(id);
  }

  function handleGroupCreated(id: string, name: string) {
    setGroupList(prev => [...prev, { id, name }]);
    setGroupId(id);
  }

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
            onChange={(e) => setKind(e.target.value as AccountKindValue)}
          >
            <option value="cash">现金</option>
            <option value="bank_debit">借记卡</option>
            <option value="bank_credit">信用卡</option>
            <option value="ewallet">电子钱包</option>
            <option value="investment">投资</option>
            <option value="loan">贷款</option>
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
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">分组</div>
            <button type="button" onClick={() => setNestedOpen("group")}
              className="flex items-center gap-0.5 h-6 px-1.5 rounded text-[10px] text-blue-600 hover:bg-blue-50 border border-transparent hover:border-blue-200">
              <Plus className="w-3 h-3" />新增分组
            </button>
          </div>
          <select
            name="groupId"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none w-full"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">未指定分组</option>
            {groupList.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">机构</div>
            <button type="button" onClick={() => setNestedOpen("institution")}
              className="flex items-center gap-0.5 h-6 px-1.5 rounded text-[10px] text-blue-600 hover:bg-blue-50 border border-transparent hover:border-blue-200">
              <Plus className="w-3 h-3" />新增机构
            </button>
          </div>
          <select
            name="institutionId"
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none w-full"
            value={institutionId}
            onChange={(e) => setInstitutionId(e.target.value)}
          >
            <option value="">不指定机构</option>
            {institutionList.map((it) => (
              <option key={it.id} value={it.id}>{it.name}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="h-9 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
        >
          保存账户
        </button>
      </form>

      <NestedAddModal
        entityType="group"
        open={nestedOpen === "group"}
        onClose={() => setNestedOpen(null)}
        onCreated={handleGroupCreated}
      />
      <NestedAddModal
        entityType="institution"
        open={nestedOpen === "institution"}
        onClose={() => setNestedOpen(null)}
        onCreated={handleInstitutionCreated}
      />
    </>
  );
}
