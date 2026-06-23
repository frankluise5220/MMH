"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, RefreshCw, Shield, Trash2, X } from "lucide-react";
import { getHouseholdDisplayName } from "@/lib/household-display";

type Household = {
  id: string;
  name: string;
  createdAt?: string;
};

type CreateForm = {
  name: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  adminPasswordConfirm: string;
};

type SwitchForm = {
  householdId: string;
  username: string;
  password: string;
};

type DeleteForm = {
  householdId: string;
  confirmName: string;
  dbPassword: string;
};

const emptyCreateForm: CreateForm = {
  name: "",
  adminName: "",
  adminEmail: "",
  adminPassword: "",
  adminPasswordConfirm: "",
};

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function LedgerSettingsPage() {
  const router = useRouter();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [active, setActive] = useState<Household | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSystem, setIsSystem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [switchForm, setSwitchForm] = useState<SwitchForm | null>(null);
  const [deleteForm, setDeleteForm] = useState<DeleteForm | null>(null);

  const activeId = active?.id ?? "";
  const activeName = getHouseholdDisplayName(active);
  const deleteTarget = useMemo(
    () => households.find((item) => item.id === deleteForm?.householdId) ?? null,
    [deleteForm?.householdId, households],
  );

  async function loadHouseholds() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/v1/households", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "读取账簿失败");
      }
      setHouseholds(data.households ?? []);
      setActive(data.active ?? null);
      setIsAdmin(data.isAdmin === true);
      setIsSystem(data.isSystem === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取账簿失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHouseholds();
  }, []);

  async function switchTo(householdId: string, username?: string, password?: string) {
    setBusy(`switch:${householdId}`);
    setError("");
    try {
      const res = await fetch("/api/v1/households/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ householdId, username, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "切换账簿失败");
      }
      setSwitchForm(null);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换账簿失败");
    } finally {
      setBusy(null);
    }
  }

  function startSwitch(household: Household) {
    if (household.id === activeId) return;
    if (isAdmin) {
      void switchTo(household.id);
      return;
    }
    setError("");
    setSwitchForm({
      householdId: household.id,
      username: household.name,
      password: "",
    });
  }

  async function createLedger() {
    const name = createForm.name.trim();
    const adminName = createForm.adminName.trim() || name;
    const adminEmail = createForm.adminEmail.trim();
    if (!name) {
      setError("请填写账簿名");
      return;
    }
    if (!adminName) {
      setError("请填写管理员用户名");
      return;
    }
    if (!adminEmail) {
      setError("请填写邮箱");
      return;
    }
    if (!createForm.adminPassword) {
      setError("请设置管理员密码");
      return;
    }
    if (createForm.adminPassword !== createForm.adminPasswordConfirm) {
      setError("两次输入的密码不一致");
      return;
    }

    setBusy("create");
    setError("");
    try {
      const res = await fetch("/api/v1/households", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          adminName,
          adminEmail,
          adminPassword: createForm.adminPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "新增账簿失败");
      }
      setShowCreate(false);
      setCreateForm(emptyCreateForm);
      await loadHouseholds();
      await switchTo(data.household.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增账簿失败");
    } finally {
      setBusy(null);
    }
  }

  async function renameLedger(householdId: string) {
    const name = editName.trim();
    if (!name) {
      setError("请填写账簿名");
      return;
    }
    setBusy(`rename:${householdId}`);
    setError("");
    try {
      const res = await fetch("/api/v1/households", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: householdId, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "修改账簿名失败");
      }
      setEditingId(null);
      setEditName("");
      await loadHouseholds();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改账簿名失败");
    } finally {
      setBusy(null);
    }
  }

  async function deleteLedger() {
    if (!deleteForm || !deleteTarget) return;
    const displayName = getHouseholdDisplayName(deleteTarget);
    if (deleteForm.confirmName.trim() !== displayName) {
      setError(`请输入账簿名“${displayName}”确认删除`);
      return;
    }
    if (!deleteForm.dbPassword.trim()) {
      setError("请输入系统密码");
      return;
    }
    setBusy(`delete:${deleteForm.householdId}`);
    setError("");
    try {
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deleteForm.dbPassword, verifySystem: true }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.ok) {
        throw new Error(verifyData.error ?? "系统密码验证失败");
      }

      const res = await fetch("/api/v1/households", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteForm.householdId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "删除账簿失败");
      }
      setDeleteForm(null);
      await loadHouseholds();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除账簿失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">账簿管理</h2>
          <p className="mt-1 text-xs text-slate-500">账簿存放在数据库中，可在这里切换、新增和维护名称。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadHouseholds()}
            disabled={loading}
            className="h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw className={`mx-auto h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => {
              setError("");
              setCreateForm({ ...emptyCreateForm, adminName: "admin" });
              setShowCreate(true);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            新增账簿
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">当前账簿</div>
            <div className="mt-1 text-xs text-slate-500">{active ? activeName : "正在读取"}</div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="w-[36%] px-4 py-2 text-left">账簿名</th>
                <th className="w-[14%] px-3 py-2 text-left">状态</th>
                <th className="w-[24%] px-3 py-2 text-left">创建时间</th>
                <th className="px-4 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">正在读取账簿</td>
                </tr>
              ) : households.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">暂无账簿</td>
                </tr>
              ) : (
                households.map((household) => {
                  const isActive = household.id === activeId;
                  const isEditing = editingId === household.id;
                  const displayName = getHouseholdDisplayName(household);
                  const rowBusy = busy?.endsWith(household.id);
                  return (
                    <tr key={household.id} className={isActive ? "bg-blue-50/40" : undefined}>
                      <td className="px-4 py-2 align-middle">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void renameLedger(household.id);
                                if (event.key === "Escape") {
                                  setEditingId(null);
                                  setEditName("");
                                }
                              }}
                              autoFocus
                              className="form-input h-8"
                            />
                            <button
                              type="button"
                              onClick={() => renameLedger(household.id)}
                              disabled={rowBusy}
                              className="h-8 w-8 rounded-md border border-slate-200 bg-white text-emerald-700 hover:bg-slate-50 disabled:opacity-50"
                              title="保存"
                            >
                              <Check className="mx-auto h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null);
                                setEditName("");
                              }}
                              disabled={rowBusy}
                              className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                              title="取消"
                            >
                              <X className="mx-auto h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="font-medium text-slate-800">{displayName}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-middle">
                        {isActive ? (
                          <span className="inline-flex h-6 items-center rounded-full bg-blue-100 px-2 text-xs font-medium text-blue-700">当前</span>
                        ) : (
                          <span className="text-xs text-slate-400">可切换</span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-middle text-xs text-slate-500">{formatDate(household.createdAt)}</td>
                      <td className="px-4 py-2 align-middle">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => startSwitch(household)}
                            disabled={isActive || rowBusy}
                            className="h-8 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            切换
                          </button>
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(household.id);
                                setEditName(displayName);
                              }}
                              disabled={rowBusy}
                              className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                              title="编辑名称"
                            >
                              <Pencil className="mx-auto h-4 w-4" />
                            </button>
                          ) : null}
                          {isSystem ? (
                            <button
                              type="button"
                              onClick={() => {
                                setError("");
                                setDeleteForm({ householdId: household.id, confirmName: "", dbPassword: "" });
                              }}
                              disabled={isActive || households.length <= 1 || rowBusy}
                              className="h-8 w-8 rounded-md border border-slate-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50"
                              title={isActive ? "先切换到其他账簿再删除" : "删除账簿"}
                            >
                              <Trash2 className="mx-auto h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showCreate ? (
        <Modal title="新增账簿" onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="form-label">账簿名</span>
                <input
                  value={createForm.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setCreateForm((prev) => ({ ...prev, name, adminName: prev.adminName === "" || prev.adminName === prev.name ? name : prev.adminName }));
                  }}
                  className="form-input"
                  autoFocus
                />
              </label>
              <label className="grid gap-1.5">
                <span className="form-label">管理员用户名</span>
                <input
                  value={createForm.adminName}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminName: event.target.value }))}
                  className="form-input"
                />
              </label>
              <label className="grid gap-1.5 sm:col-span-2">
                <span className="form-label">邮箱</span>
                <input
                  type="email"
                  value={createForm.adminEmail}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminEmail: event.target.value }))}
                  className="form-input"
                  autoComplete="email"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="form-label">管理员密码</span>
                <input
                  type="password"
                  value={createForm.adminPassword}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminPassword: event.target.value }))}
                  className="form-input"
                  autoComplete="new-password"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="form-label">确认密码</span>
                <input
                  type="password"
                  value={createForm.adminPasswordConfirm}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminPasswordConfirm: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createLedger();
                  }}
                  className="form-input"
                  autoComplete="new-password"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} disabled={busy === "create"} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                取消
              </button>
              <button type="button" onClick={createLedger} disabled={busy === "create"} className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {busy === "create" ? "新增中" : "新增"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {switchForm ? (
        <Modal title="切换账簿" onClose={() => setSwitchForm(null)}>
          <div className="space-y-4">
            <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
              切换到：{getHouseholdDisplayName(households.find((item) => item.id === switchForm.householdId))}
            </div>
            <label className="grid gap-1.5">
              <span className="form-label">目标账簿管理员用户名</span>
              <input
                value={switchForm.username}
                onChange={(event) => setSwitchForm((prev) => prev ? { ...prev, username: event.target.value } : prev)}
                className="form-input"
                autoFocus
              />
            </label>
            <label className="grid gap-1.5">
              <span className="form-label">密码</span>
              <input
                type="password"
                value={switchForm.password}
                onChange={(event) => setSwitchForm((prev) => prev ? { ...prev, password: event.target.value } : prev)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void switchTo(switchForm.householdId, switchForm.username, switchForm.password);
                }}
                className="form-input"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSwitchForm(null)} disabled={busy?.startsWith("switch:")} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                取消
              </button>
              <button type="button" onClick={() => switchTo(switchForm.householdId, switchForm.username, switchForm.password)} disabled={busy?.startsWith("switch:")} className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                确认切换
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {deleteForm && deleteTarget ? (
        <Modal title="删除账簿" onClose={() => setDeleteForm(null)} tone="danger">
          <div className="space-y-4">
            <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              将删除“{getHouseholdDisplayName(deleteTarget)}”及其账户、交易、分类、用户等数据。此操作不可撤销。
            </div>
            <label className="grid gap-1.5">
              <span className="form-label">输入账簿名确认</span>
              <input
                value={deleteForm.confirmName}
                onChange={(event) => setDeleteForm((prev) => prev ? { ...prev, confirmName: event.target.value } : prev)}
                className="form-input"
                autoFocus
              />
            </label>
            <label className="grid gap-1.5">
              <span className="form-label inline-flex items-center gap-1.5"><Shield className="h-3.5 w-3.5 text-amber-500" />系统密码</span>
              <input
                type="password"
                value={deleteForm.dbPassword}
                onChange={(event) => setDeleteForm((prev) => prev ? { ...prev, dbPassword: event.target.value } : prev)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void deleteLedger();
                }}
                className="form-input"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteForm(null)} disabled={busy?.startsWith("delete:")} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                取消
              </button>
              <button type="button" onClick={deleteLedger} disabled={busy?.startsWith("delete:")} className="h-9 rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  tone = "default",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className={`flex items-center justify-between border-b px-5 py-4 ${tone === "danger" ? "border-red-100 bg-red-50" : "border-slate-200 bg-slate-50"}`}>
          <div className={`text-sm font-semibold ${tone === "danger" ? "text-red-800" : "text-slate-800"}`}>{title}</div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md text-slate-500 hover:bg-white" title="关闭">
            <X className="mx-auto h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
