"use client";

import { useState, useEffect, useRef, RefObject } from "react";
import { useRouter } from "next/navigation";
import { Plus, Check, Pencil, X, Trash2, Shield } from "lucide-react";
import { getHouseholdDisplayName } from "@/lib/household-display";

type Household = { id: string; name: string; createdAt?: string };

export function LedgerSwitcher({
  current,
  anchorRef,
  open,
  onOpenChange,
}: {
  current: Household | null;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [isSystemUser, setIsSystemUser] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // 切换账簿验证对话框
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);
  const [switchUsername, setSwitchUsername] = useState("");
  const [switchPassword, setSwitchPassword] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [switching, setSwitching] = useState(false);

  // 创建账簿对话框状态
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createAdminName, setCreateAdminName] = useState("");
  const [createAdminPassword, setCreateAdminPassword] = useState("");
  const [createAdminPasswordConfirm, setCreateAdminPasswordConfirm] = useState("");
  const [createAdminEmail, setCreateAdminEmail] = useState("");
  const [createDialogError, setCreateDialogError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // 删除账簿状态
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteDbPassword, setDeleteDbPassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSwitchTargetId(null);
      setSwitchUsername("");
      setSwitchPassword("");
      setSwitchError("");
      return;
    }
    fetch("/api/v1/households")
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setHouseholds(d.households);
          setIsAdminUser(d.isAdmin ?? false);
          setIsSystemUser(d.isSystem ?? false);
        }
      })
      .catch(() => {});
  }, [open]);

  const showSwitchList = isAdminUser || households.length > 1;

  // 切换账簿：弹出验证对话框
  function startSwitch(id: string) {
    const h = households.find(x => x.id === id);
    setSwitchTargetId(id);
    setSwitchUsername(h?.name ?? "");
    setSwitchPassword("");
    setSwitchError("");
  }

  async function handleSwitchVerify() {
    if (!switchTargetId || !switchPassword.trim() || !switchUsername.trim() || switching) return;
    setSwitching(true);
    setSwitchError("");
    try {
      const res = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: switchUsername.trim(), password: switchPassword, householdId: switchTargetId }),
      });
      const d = await res.json();
      if (d.ok) {
        await switchTo(switchTargetId, switchUsername.trim(), switchPassword);
      } else {
        setSwitchError(d.error ?? "验证失败");
      }
    } catch {
      setSwitchError("网络错误，请重试");
    } finally {
      setSwitching(false);
    }
  }

  async function switchTo(id: string, username?: string, password?: string) {
    const res = await fetch("/api/v1/households/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ householdId: id, username, password }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!res.ok || data?.ok === false) {
      setSwitchError(data?.error ?? `切换失败：HTTP ${res.status}`);
      return false;
    }
    onOpenChange(false);
    router.push("/");
    router.refresh();
    return true;
  }

  function openCreateDialog() {
    const name = newName.trim();
    if (!name || adding) return;
    setCreateAdminName(name); // 默认用账簿名称作为管理员用户名
    setCreateAdminPassword("");
    setCreateAdminEmail("");
    setCreateDialogError("");
    setShowCreateDialog(true);
  }

  async function handleCreateWithAdmin() {
    const name = newName.trim();
    if (!name || adding) return;
    if (!createAdminName.trim() || !createAdminPassword.trim()) {
      setCreateDialogError("请填写管理员用户名和密码");
      return;
    }
    if (createAdminPassword !== createAdminPasswordConfirm) {
      setCreateDialogError("两次输入的密码不一致");
      return;
    }
    if (!createAdminEmail.trim()) {
      setCreateDialogError("请输入邮箱");
      return;
    }
    setAdding(true);
    setCreateDialogError("");
    try {
      const res = await fetch("/api/v1/households", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          adminName: createAdminName.trim(),
          adminPassword: createAdminPassword,
          adminEmail: createAdminEmail.trim(),
        }),
      });
      const d = await res.json();
      if (d.ok) {
        setShowCreateDialog(false);
        await switchTo(d.household.id);
      } else {
        setCreateDialogError(d.error ?? "创建失败");
      }
    } catch {
      setCreateDialogError("网络错误，请重试");
    } finally {
      setAdding(false);
      if (!showCreateDialog) setNewName("");
    }
  }

  async function renameHousehold(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 50) return;
    try {
      const res = await fetch("/api/v1/households", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: trimmed }),
      });
      if (res.ok) {
        setEditingId(null);
        setEditName("");
        fetch("/api/v1/households")
          .then(r => r.json())
          .then(d => { if (d.ok) setHouseholds(d.households); })
          .catch(() => {});
        router.refresh();
      }
    } catch { /* ignore */ }
  }

  function openDeleteDialog(id: string) {
    const h = households.find(x => x.id === id);
    setDeletingId(id);
    setDeleteConfirmName("");
    setDeleteDbPassword("");
    setDeleteError(h ? `请输入账簿名称 "${getHouseholdDisplayName(h)}" 以确认删除` : "");
  }

  async function handleDelete() {
    if (!deletingId) return;
    const h = households.find(x => x.id === deletingId);
    if (!h) return;
    const displayName = getHouseholdDisplayName(h);
    if (deleteConfirmName.trim() !== displayName) {
      setDeleteError(`名称不匹配，请输入 "${displayName}" 以确认删除`);
      return;
    }
    if (!deleteDbPassword.trim()) {
      setDeleteError("请输入数据库密码以确认删除");
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      // 先验证数据库密码
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deleteDbPassword, verifySystem: true }),
      });
      const vd = await verifyRes.json();
      if (!vd.ok) {
        setDeleteError(vd.error ?? "数据库密码错误");
        setDeleting(false);
        return;
      }
      // 执行删除
      const res = await fetch("/api/v1/households", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deletingId }),
      });
      const d = await res.json();
      if (d.ok) {
        setDeletingId(null);
        setDeleteConfirmName("");
        setDeleteDbPassword("");
        const r = await fetch("/api/v1/households");
        const rd = await r.json();
        if (rd.ok) {
          setHouseholds(rd.households);
          if (current?.id === deletingId && rd.households.length > 0) {
            await switchTo(rd.households[0].id);
          }
        }
        router.refresh();
      } else {
        setDeleteError(d.error ?? "删除失败");
      }
    } catch {
      setDeleteError("网络错误，请重试");
    } finally {
      setDeleting(false);
    }
  }

  // 根据锚点位置自动决定向上/向下展开，避免移动到顶部后弹到屏幕外
  const anchor = anchorRef.current;
  const anchorRect = anchor?.getBoundingClientRect();
  const dropdownStyle: React.CSSProperties = anchorRect
    ? (() => {
        const width = Math.max(anchorRect.width, 240);
        const left = Math.min(Math.max(anchorRect.left, 8), Math.max(window.innerWidth - width - 8, 8));
        const shouldOpenDown = anchorRect.top < window.innerHeight / 2;
        return shouldOpenDown
          ? {
              position: "fixed",
              left,
              top: anchorRect.bottom + 4,
              width,
              zIndex: 50,
            }
          : {
              position: "fixed",
              left,
              bottom: window.innerHeight - anchorRect.top + 4,
              width,
              zIndex: 50,
            };
      })()
    : { position: "fixed", left: 8, top: 8, zIndex: 50 };

  const hasData = households.length > 0;

  if (!open) return null;
  if (!showSwitchList && hasData && households.length <= 1) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => { onOpenChange(false); setEditingId(null); }} />
      <div
        style={dropdownStyle}
        className="rounded-xl border border-foreground/10 bg-white/95 shadow-lg shadow-foreground/5 py-1 backdrop-blur-sm"
      >
          <div className="px-3 py-2 text-[10px] font-bold text-foreground/30 uppercase tracking-[0.2em] border-b border-foreground/5">
            切换账簿
          </div>

          <div className="max-h-[40vh] overflow-y-auto">
            {households.map((h) => {
              const isActive = current?.id === h.id;
              const isEditing = editingId === h.id;
              const displayName = getHouseholdDisplayName(h);
              return (
                <div key={h.id}>
                  {isEditing ? (
                    <div className="flex items-center gap-1 px-3 py-2">
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameHousehold(h.id, editName);
                          if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                        }}
                        autoFocus
                        className="flex-1 h-7 rounded border border-foreground/10 bg-white px-2 text-xs outline-none text-foreground"
                      />
                      <button
                        type="button"
                        onClick={() => renameHousehold(h.id, editName)}
                        className="h-7 w-7 rounded border border-foreground/10 bg-white flex items-center justify-center text-accent-green hover:bg-foreground/5"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingId(null); setEditName(""); }}
                        className="h-7 w-7 rounded border border-foreground/10 bg-white flex items-center justify-center text-foreground/40 hover:bg-foreground/5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { if (!isActive) startSwitch(h.id); }}
                      className={`group w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-foreground/5 transition-colors ${
                        isActive ? "bg-foreground/8 text-foreground font-semibold" : "text-foreground/70"
                      }`}
                    >
                      <span className="truncate pr-2">{displayName}</span>
                      <div className="flex items-center gap-1.5">
                        {isSystemUser && !isActive && households.length > 1 && (
                          <Trash2
                            className="h-3 w-3 text-foreground/20 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); openDeleteDialog(h.id); }}
                          />
                        )}
                        {isAdminUser && !isActive && (
                          <Pencil
                            className="h-3 w-3 text-foreground/20 hover:text-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); setEditingId(h.id); setEditName(h.name); }}
                          />
                        )}
                        {isActive && <Check className="h-3.5 w-3.5 text-accent-green" />}
                      </div>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {isAdminUser && (
            <div className="border-t border-foreground/5 px-2 py-1.5">
              <div className="flex items-center gap-1">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") openCreateDialog(); }}
                  placeholder="新建账簿…"
                  className="flex-1 h-7 rounded border border-foreground/10 bg-white px-2 text-xs outline-none text-foreground"
                />
                <button
                  type="button"
                  onClick={openCreateDialog}
                  disabled={adding || !newName.trim()}
                  className="h-7 w-7 rounded border border-foreground/10 bg-white flex items-center justify-center text-foreground/40 hover:bg-foreground/5 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 切换账簿验证对话框 */}
        {switchTargetId && (() => {
          const h = households.find(x => x.id === switchTargetId);
          if (!h) return null;
          const displayName = getHouseholdDisplayName(h);
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
                  <div className="text-base font-semibold text-slate-800">切换到 "{displayName}"</div>
                  <div className="mt-1 text-xs text-slate-500">请输入该账簿的管理员用户名和密码</div>
                </div>

                <div className="p-6 space-y-4">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">管理员用户名</div>
                    <input
                      value={switchUsername}
                      onChange={(e) => setSwitchUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSwitchVerify(); }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                      placeholder="输入管理员用户名"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">密码</div>
                    <input
                      type="password"
                      value={switchPassword}
                      onChange={(e) => setSwitchPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSwitchVerify(); }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                      placeholder="输入登录密码"
                    />
                  </div>

                  {switchError && (
                    <div className="text-sm text-red-600">{switchError}</div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        router.push("/login");
                      }}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      忘记密码？去登录页找回
                    </button>
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setSwitchTargetId(null); setSwitchUsername(""); setSwitchPassword(""); setSwitchError(""); }}
                      disabled={switching}
                      className="flex-1 h-10 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={handleSwitchVerify}
                      disabled={switching || !switchUsername.trim() || !switchPassword.trim()}
                      className="flex-1 h-10 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                    >
                      {switching ? "验证中…" : "确认切换"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* 创建账簿对话框 */}
        {showCreateDialog && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div ref={dialogRef} className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
                <div className="text-base font-semibold text-slate-800">新建账簿</div>
                <div className="mt-1 text-xs text-slate-500">设置管理员账户以保护数据安全</div>
              </div>

              <div className="p-6 space-y-4">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">管理员用户名</div>
                  <input
                    value={createAdminName}
                    onChange={(e) => setCreateAdminName(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder="输入管理员用户名"
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">邮箱</div>
                  <input
                    type="email"
                    value={createAdminEmail}
                    onChange={(e) => setCreateAdminEmail(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder="用于密码找回"
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">管理员密码</div>
                  <input
                    type="password"
                    value={createAdminPassword}
                    onChange={(e) => setCreateAdminPassword(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder="设置登录密码"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">确认密码</div>
                  <input
                    type="password"
                    value={createAdminPasswordConfirm}
                    onChange={(e) => setCreateAdminPasswordConfirm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreateWithAdmin(); }}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                    placeholder="再次输入密码"
                    autoComplete="new-password"
                  />
                </div>

                {createDialogError && (
                  <div className="text-sm text-red-600">{createDialogError}</div>
                )}

                <div className="pt-2 text-xs text-slate-400">
                  创建后将自动生成默认收支分类（餐饮、交通、工资等），后续可自行增删。
                </div>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowCreateDialog(false); setCreateAdminName(""); setCreateAdminPassword(""); setCreateAdminPasswordConfirm(""); setCreateAdminEmail(""); }}
                    disabled={adding}
                    className="flex-1 h-10 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateWithAdmin}
                    disabled={adding || !createAdminName.trim() || !createAdminPassword.trim() || !createAdminPasswordConfirm.trim() || !createAdminEmail.trim()}
                    className="flex-1 h-10 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {adding ? "创建中…" : "创建账簿"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 删除账簿确认对话框 */}
        {deletingId && (() => {
          const h = households.find(x => x.id === deletingId);
          if (!h) return null;
          const displayName = getHouseholdDisplayName(h);
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
                <div className="px-6 py-5 border-b border-red-100 bg-red-50">
                  <div className="text-base font-semibold text-red-800">删除账簿</div>
                  <div className="mt-1 text-xs text-red-600">此操作不可撤销，将删除该账簿及其所有关联数据</div>
                </div>

                <div className="p-6 space-y-4">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      请输入账簿名称 <span className="font-bold text-slate-800">"{displayName}"</span> 以确认删除
                    </div>
                    <input
                      value={deleteConfirmName}
                      onChange={(e) => { setDeleteConfirmName(e.target.value); setDeleteError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDelete(); }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-red-100 focus:border-red-400"
                      placeholder={displayName}
                      autoFocus
                    />
                  </div>

                  {/* 数据库密码验证 */}
                  <div className="pt-2 border-t border-slate-100">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Shield className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <span className="text-xs font-medium text-amber-700">数据库密码验证</span>
                    </div>
                    <input
                      type="password"
                      value={deleteDbPassword}
                      onChange={(e) => { setDeleteDbPassword(e.target.value); setDeleteError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDelete(); }}
                      className="h-10 w-full rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-amber-100 focus:border-amber-400"
                      placeholder="输入数据库密码"
                      autoComplete="off"
                    />
                    <div className="mt-1 text-[10px] text-slate-400">删除账簿需要验证数据库密码</div>
                  </div>

                  {deleteError && (
                    <div className="text-sm text-red-600">{deleteError}</div>
                  )}

                  <div className="pt-2 text-xs text-slate-400">
                    将删除该账簿下的所有账户、交易记录、持仓数据、分类、用户等，删除后无法恢复。
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setDeletingId(null); setDeleteConfirmName(""); setDeleteDbPassword(""); setDeleteError(""); }}
                      disabled={deleting}
                      className="flex-1 h-10 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting || deleteConfirmName.trim() !== displayName || !deleteDbPassword.trim()}
                      className="flex-1 h-10 rounded-md bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? "删除中…" : "确认删除"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </>
  );
}
