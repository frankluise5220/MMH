"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsPageHeader,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { SESSION_DAY_OPTIONS } from "@/lib/session-days";

type ManagedUser = {
  id: string;
  name: string;
  email?: string | null;
  role: string;
  isSystem?: boolean;
  hasPassword?: boolean;
  sessionDays?: number;
  createdAt?: string;
};

function UserModal({
  initial,
  onSave,
  onCancel,
  users,
}: {
  initial?: ManagedUser;
  onSave: (data: { name: string; email?: string; role: string; password?: string }) => void;
  onCancel: () => void;
  users: ManagedUser[];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [role, setRole] = useState(initial?.role ?? "user");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const isSystemUser = initial?.isSystem ?? false;
  const hasExistingPassword = initial?.hasPassword ?? false;
  const isEditing = !!initial;

  // 检查是否是当前账簿最后一个管理员，且正在被降级
  const isLastAdmin = initial?.role === "admin" && users.filter(u => u.role === "admin").length <= 1;

  function validate(): string | null {
    if (!name.trim()) return "请输入用户名";
    if (!isEditing) {
      if (!password && !confirmPassword) return "请输入密码";
      if (password !== confirmPassword) return "两次输入的密码不一致";
    } else {
      // 编辑时如果填写了密码（任意一个），需要两次一致
      if (password || confirmPassword) {
        if (password !== confirmPassword) return "两次输入的密码不一致";
      }
    }
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) { setError(err); return; }
    setError("");
    onSave({ name: name.trim(), email: email.trim() || undefined, role, password: password.trim() || undefined });
  }

  return (
    <div className="app-modal-backdrop z-[1100]">
      <div className="app-modal-panel max-w-md">
        <div className="modal-header shrink-0">
          <div className="text-sm font-semibold text-slate-800">{isEditing ? "编辑用户" : "添加用户"}</div>
          <button type="button" onClick={onCancel} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">用户名</label>
            <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder="输入用户名" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">找回邮箱（可选）</label>
            <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder="用于忘记密码找回" value={email ?? ""} onChange={(e) => { setEmail(e.target.value); setError(""); }} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">角色</label>
            <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:opacity-60 disabled:bg-slate-50"
              value={role} onChange={(e) => setRole(e.target.value)} disabled={isSystemUser}>
              <option value="admin">管理员 (admin)</option>
              <option value="user">普通用户 (user)</option>
            </select>
            {isSystemUser && <div className="mt-1 text-[11px] text-slate-500">系统管理员角色不可更改</div>}
            {isLastAdmin && !isSystemUser && <div className="mt-1 text-[11px] text-amber-600">这是当前账簿最后一个管理员，不可降级为普通用户</div>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              {isEditing ? (hasExistingPassword ? "修改密码（留空则不修改）" : "设置密码") : "密码"}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 pr-10 text-sm outline-none"
                placeholder={isEditing ? (hasExistingPassword ? "留空则不修改" : "设置新密码") : "设置密码"}
                value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }}
              />
              <button type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 select-none"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              {isEditing ? "确认新密码（留空则不修改）" : "确认密码"}
            </label>
            <input
              type={showPassword ? "text" : "password"}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder={isEditing ? "再次输入密码确认" : "再次输入密码确认"}
              value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(""); }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="secondary-button h-9 px-4" onClick={onCancel}>取消</button>
            <button className="primary-button h-9 px-4 disabled:opacity-50"
              onClick={handleSubmit} disabled={!name.trim()}>
              {isEditing ? "保存" : "添加"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loadError, setLoadError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [savingSessionUserId, setSavingSessionUserId] = useState("");

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    try {
      const res = await fetch("/api/v1/settings/users");
      const text = await res.text();
      let data: { ok?: boolean; users?: ManagedUser[]; error?: string } | { raw: string } = { raw: "" };
      try {
        data = JSON.parse(text) as { ok?: boolean; users?: ManagedUser[]; error?: string };
      } catch {
        data = { raw: text.slice(0, 200) };
      }
      if ("ok" in data && data.ok && Array.isArray(data.users)) {
        setUsers(data.users);
        setLoadError("");
      } else {
        setUsers([]);
        const hint = "ok" in data ? (data.error || `请求失败（${res.status}）`) : `请求失败（${res.status}）`;
        setLoadError(hint);
      }
    } catch {
      setUsers([]);
      setLoadError("请求失败（网络或服务异常）");
    }
  }

  async function handleSave(data: { name: string; email?: string; role: string; password?: string }) {
    try {
      const url = "/api/v1/settings/users";
      const body = editingUser
        ? { id: editingUser.id, name: data.name, email: data.email ?? "", role: data.role, password: data.password }
        : data;
      const res = await fetch(url, {
        method: editingUser ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => null);
      if (result?.ok) {
        await fetchUsers();
        setShowModal(false);
        setEditingUser(null);
      } else {
        window.alert(result?.error || (editingUser ? "更新失败" : "添加失败"));
      }
    } catch { window.alert(editingUser ? "更新失败" : "添加失败"); }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    if (!deletePassword.trim()) {
      setDeleteError("请输入当前用户密码");
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/v1/settings/users?id=${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePassword }),
      });
      const result = await res.json().catch(() => null);
      if (result?.ok) {
        setDeleteTarget(null);
        setDeletePassword("");
        await fetchUsers();
      } else {
        setDeleteError(result?.error || "删除失败");
      }
    } catch {
      setDeleteError("删除失败");
    } finally {
      setDeleting(false);
    }
  }

  async function saveUserSessionDays(user: ManagedUser, next: number) {
    const prevUsers = users;
    setSavingSessionUserId(user.id);
    setUsers((items) => items.map((item) => item.id === user.id ? { ...item, sessionDays: next } : item));
    try {
      const res = await fetch("/api/v1/settings/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, sessionDays: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setUsers(prevUsers);
        window.alert(data.error || "保存失败");
      }
    } catch {
      setUsers(prevUsers);
      window.alert("保存失败");
    } finally {
      setSavingSessionUserId("");
    }
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="用户管理"
        description="管理账簿用户、登录身份和角色权限。"
        count={users.length}
        actions={
          <SettingsPrimaryAddButton onClick={() => { setEditingUser(null); setShowModal(true); }}>
            添加用户
          </SettingsPrimaryAddButton>
        }
      />

      {loadError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      <SettingsSection title="用户列表" count={users.length}>
        <SettingsTable minWidth={820} maxWidth="full">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[28%]" />
            <col className="w-[16%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>用户</SettingsTh>
              <SettingsTh>邮箱</SettingsTh>
              <SettingsTh>登录保留</SettingsTh>
              <SettingsTh>角色</SettingsTh>
              <SettingsTh>状态</SettingsTh>
              <SettingsTh align="right">操作</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {users.length > 0 ? users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50">
                <SettingsTd className="text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-800">{u.name}</div>
                  </div>
                </SettingsTd>
                <SettingsTd className="text-sm">
                  <div className="truncate text-slate-600">{u.email || "—"}</div>
                </SettingsTd>
                <SettingsTd>
                  <select
                    value={u.sessionDays ?? 30}
                    onChange={(event) => void saveUserSessionDays(u, Number(event.target.value))}
                    disabled={savingSessionUserId === u.id}
                    className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none disabled:opacity-60"
                    title="控制该用户重新登录间隔，不影响用户权限"
                  >
                    {SESSION_DAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </SettingsTd>
                <SettingsTd>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${u.role === "admin" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>
                    {u.role === "admin" ? "管理员" : "用户"}
                  </span>
                </SettingsTd>
                <SettingsTd>
                  {u.isSystem ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">系统</span>
                  ) : (
                    <span className="text-xs text-slate-400">普通用户</span>
                  )}
                </SettingsTd>
                <SettingsTd align="right">
                  <SettingsRowActions>
                    <SettingsActionButton
                      label="编辑用户"
                      variant="edit"
                      onClick={() => { setEditingUser(u); setShowModal(true); }}
                    />
                    {!u.isSystem ? (
                      <SettingsActionButton
                        label="删除用户"
                        variant="delete"
                        onClick={() => {
                          setDeleteTarget(u);
                          setDeletePassword("");
                          setDeleteError("");
                        }}
                      />
                    ) : null}
                  </SettingsRowActions>
                </SettingsTd>
              </tr>
            )) : (
              <SettingsEmptyRow colSpan={6}>暂无用户</SettingsEmptyRow>
            )}
          </tbody>
        </SettingsTable>
      </SettingsSection>

      {showModal && (
        <UserModal
          initial={editingUser ?? undefined}
          users={users}
          onSave={handleSave}
          onCancel={() => { setShowModal(false); setEditingUser(null); }}
        />
      )}

      {deleteTarget && (
        <div className="app-modal-backdrop z-[1100]">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">删除用户</div>
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeletePassword("");
                  setDeleteError("");
                }}
                className="secondary-button h-8 px-2"
                disabled={deleting}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="text-xs text-slate-500">删除前需要输入当前用户密码。</div>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                确认删除用户“{deleteTarget.name}”？该操作不可撤销。
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">当前用户密码</label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(""); }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="请输入当前用户密码"
                  autoFocus
                />
              </div>
              {deleteError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{deleteError}</div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="secondary-button h-9 px-4"
                  onClick={() => {
                    setDeleteTarget(null);
                    setDeletePassword("");
                    setDeleteError("");
                  }}
                  disabled={deleting}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                  onClick={handleDelete}
                  disabled={deleting || !deletePassword.trim()}
                >
                  {deleting ? "删除中..." : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
