"use client";

import { useMemo, useState } from "react";
import { Building2, CheckCircle2, Landmark, Plus, UserRound } from "lucide-react";

import { DebtTransactionModal } from "@/components/DebtTransactionModal";
import { EntityCreateForm } from "@/components/EntityCreateForm";

type CounterpartyGuideRow = {
  id: string;
  name: string;
  shortName: string | null;
  type: string | null;
  accountCount: number;
  payable: number;
  receivable: number;
};

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  kind?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  institutionType?: string | null;
  isInstitutionLoan?: boolean;
  debtDirection?: "payable" | "receivable" | null;
};

type SmartSelectLikeOption = {
  id: string;
  label: string;
  subLabel?: string;
  title?: string;
  isHeader?: boolean;
  parentId?: string;
  kind?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  billingDay?: number | null;
  currency?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function typeLabel(type?: string | null) {
  return type === "organization" ? "往来组织" : "往来人员";
}

export function LiabilitiesGuideClient({
  counterparties,
  debtAccounts,
  debtObjectOptions,
  cashAccounts,
  cashAccountSSOptions,
  nestedFieldData,
  defaultCashAccountId,
  action,
}: {
  counterparties: CounterpartyGuideRow[];
  debtAccounts: AccountOption[];
  debtObjectOptions: SmartSelectLikeOption[];
  cashAccounts: AccountOption[];
  cashAccountSSOptions: SmartSelectLikeOption[];
  nestedFieldData: NestedFieldData;
  defaultCashAccountId: string;
  action: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
}) {
  const [rows, setRows] = useState(counterparties);
  const [selectedId, setSelectedId] = useState(counterparties[0]?.id ?? "");
  const [showCreate, setShowCreate] = useState(counterparties.length === 0);

  const selectedRow = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const existingNames = useMemo(
    () => rows.flatMap((row) => [row.name, row.shortName?.trim() || ""]).filter(Boolean),
    [rows],
  );

  function handleCreated(id: string, name: string, extra?: { type?: string }) {
    const nextRow: CounterpartyGuideRow = {
      id,
      name,
      shortName: null,
      type: extra?.type ?? "person",
      accountCount: 0,
      payable: 0,
      receivable: 0,
    };
    setRows((current) => [...current, nextRow]);
    setSelectedId(id);
    setShowCreate(false);
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">往来款向导</div>
            <div className="text-xs text-slate-500">先建立往来人员，再记录借入、借出、还款或收回</div>
          </div>
          <button type="button" onClick={() => setShowCreate(true)} className="secondary-button h-8 gap-1 px-3 text-xs">
            <Plus className="h-3.5 w-3.5" />
            新增往来人员
          </button>
        </div>
      </header>

      <EntityCreateForm
        mode="full"
        layout="modal"
        open={showCreate}
        onClose={() => setShowCreate(false)}
        entityType="counterparty"
        defaultType="person"
        title="新增往来人员"
        nameLabel="往来对象名称"
        namePlaceholder="例如：张三、某某公司"
        existingNames={existingNames}
        onCreated={handleCreated}
      />

      <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 md:px-5 md:py-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(380px,1.1fr)]">
        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <UserRound className="h-4 w-4 text-blue-500" />
              往来人员列表
            </div>
            <div className="text-xs text-slate-400">{rows.length} 个对象</div>
          </div>
          <div className="divide-y divide-slate-100">
            {rows.length > 0 ? rows.map((row) => {
              const active = row.id === selectedRow?.id;
              const net = row.receivable - row.payable;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={`block w-full px-4 py-3 text-left transition-colors ${active ? "bg-blue-50" : "hover:bg-slate-50"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-800">{row.shortName?.trim() || row.name}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{typeLabel(row.type)}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{row.accountCount > 0 ? `${row.accountCount} 个往来账户` : "还没有往来款记录"}</div>
                    </div>
                    <div className="shrink-0 text-right text-xs tabular-nums">
                      <div className={row.payable > 0 ? "text-rose-700" : "text-slate-400"}>应付 ¥{formatMoney(row.payable)}</div>
                      <div className={row.receivable > 0 ? "text-emerald-700" : "text-slate-400"}>应收 ¥{formatMoney(row.receivable)}</div>
                      {net !== 0 ? <div className="mt-0.5 text-[11px] text-slate-500">净额 ¥{formatMoney(Math.abs(net))}</div> : null}
                    </div>
                  </div>
                </button>
              );
            }) : (
              <div className="px-4 py-10 text-center">
                <div className="text-sm font-medium text-slate-700">还没有往来人员</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">先添加一个借入借出、代付或待结算对象。新增后，这里会出现“新建往来款”按钮。</div>
                <button type="button" onClick={() => setShowCreate(true)} className="primary-button mt-4 h-8 gap-1 px-3 text-xs">
                  <Plus className="h-3.5 w-3.5" />
                  新增往来人员
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-500" />
              新建往来款说明
            </div>
            {selectedRow ? (
              <DebtTransactionModal
                key={selectedRow.id}
                debtAccounts={debtAccounts}
                cashAccounts={cashAccounts}
                debtObjectOptions={debtObjectOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                nestedFieldData={nestedFieldData}
                defaultDebtInstitutionId={`counterparty:${selectedRow.id}`}
                defaultCashAccountId={defaultCashAccountId}
                action={action}
                triggerLabel="新建往来款"
              />
            ) : null}
          </div>

          <div className="space-y-3 p-4">
            {selectedRow ? (
              <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm leading-6 text-blue-900">
                当前选中：{selectedRow.shortName?.trim() || selectedRow.name}。点击右上角“新建往来款”后，弹窗里的“往来对象”会默认选中它；也可以在弹窗内切换或直接新增对象。
              </div>
            ) : (
              <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
                先在左侧新增一个往来人员。没有往来对象时，不显示新建往来款按钮，避免直接建出无归属的往来账户。
              </div>
            )}

            <div className="grid gap-3">
              {[
                {
                  title: "1. 选择操作类型",
                  text: "借入表示对方给你钱；借出表示你给对方钱；还款和收回用于冲减已有余额。",
                },
                {
                  title: "2. 选择资金账户",
                  text: "资金账户是现金、借记卡、电子钱包或信用卡这一侧，用来记录钱实际从哪里流入或流出。",
                },
                {
                  title: "3. 选择往来对象",
                  text: "普通往来必须先选对象。没有对象时，可以在左侧列表新增，也可以在弹窗的往来对象下拉里直接新增。",
                },
                {
                  title: "4. 确认往来账户",
                  text: "普通人员/组织通常复用该对象下的同一个往来账户；不选账户时，保存会自动复用或创建“某某的往来款”。",
                },
                {
                  title: "5. 填金额和备注",
                  text: "本金是要形成或冲减的往来余额；利息只在还款或收回时需要。备注用于说明原因，例如临时周转、代付餐费。",
                },
              ].map((item) => (
                <div key={item.title} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {item.title}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-600">{item.text}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-slate-400" />
                建议顺序
              </div>
              <div className="mt-2 text-xs leading-5 text-slate-600">
                新手阶段建议先建“人/公司”，再录第一笔借入或借出；以后发生还款、收回、代付返还时，都继续选择同一个往来对象，这样余额才能自然结清。
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
