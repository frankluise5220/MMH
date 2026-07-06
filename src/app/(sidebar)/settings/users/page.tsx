"use client";

import { useState, useEffect } from "react";
import {
  getAiPanelEnabledPreference,
  getSessionDaysPreference,
  setAiPanelEnabledPreference,
  setSessionDaysPreference,
} from "@/lib/client/appPreferences";

type ManagedUser = {
  id: string;
  name: string;
  email?: string | null;
  role: string;
  isSystem?: boolean;
  hasPassword?: boolean;
  createdAt?: string;
};

const SESSION_DAY_OPTIONS = [
  { value: 1, label: "1 天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 180, label: "180 天" },
  { value: 365, label: "365 天" },
];

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">{isEditing ? "编辑用户" : "添加用户"}</div>
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
            <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={onCancel}>取消</button>
            <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
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
  const [sessionDays, setSessionDays] = useState(30);
  const [aiPanelEnabled, setAiPanelEnabled] = useState(true);
  const [savingSession, setSavingSession] = useState(false);
  const [savingAiPanel, setSavingAiPanel] = useState(false);

  useEffect(() => {
    fetchUsers();
    setSessionDays(getSessionDaysPreference());
    setAiPanelEnabled(getAiPanelEnabledPreference());
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
      setDeleteError("请输入当前管理员密码");
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

  async function saveSessionDays(next: number) {
    const prev = sessionDays;
    setSessionDays(next);
    setSessionDaysPreference(next);
    setSavingSession(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionDays: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSessionDays(prev);
        setSessionDaysPreference(prev);
      }
    } catch {
      setSessionDays(prev);
      setSessionDaysPreference(prev);
    } finally {
      setSavingSession(false);
    }
  }

  async function saveAiPanelEnabled(next: boolean) {
    const prev = aiPanelEnabled;
    setAiPanelEnabled(next);
    setAiPanelEnabledPreference(next);
    setSavingAiPanel(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiPanelEnabled: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAiPanelEnabled(prev);
        setAiPanelEnabledPreference(prev);
      }
    } catch {
      setAiPanelEnabled(prev);
      setAiPanelEnabledPreference(prev);
    } finally {
      setSavingAiPanel(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">用户管理</h2>
          <p className="mt-1 text-xs text-slate-500">管理系统用户，设置角色权限。</p>
        </div>
        <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
          onClick={() => { setEditingUser(null); setShowModal(true); }}>
          + 添加用户
        </button>
      </div>

      {loadError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      {users.length > 0 ? (
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <div className="divide-y divide-slate-100">
            {users.map((u) => (
              <div key={u.id} className="px-3 py-2 flex items-center gap-2">
                <span className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">{u.name}</div>
                  {u.email && <div className="text-[11px] text-slate-400 truncate">{u.email}</div>}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${u.role === "admin" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>
                  {u.role === "admin" ? "管理员" : "用户"}
                </span>
                {u.isSystem && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 shrink-0">系统</span>}
                <button className="text-xs text-slate-400 hover:text-blue-600 shrink-0" onClick={() => { setEditingUser(u); setShowModal(true); }}>编辑</button>
                {!u.isSystem && (
                  <button
                    className="text-xs text-slate-400 hover:text-red-500 shrink-0"
                    onClick={() => {
                      setDeleteTarget(u);
                      setDeletePassword("");
                      setDeleteError("");
                    }}
                  >
                    删除
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md bg-white">
          <span>暂无用户</span>
        </div>
      )}

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">登录</div>
            <div className="mt-1 text-xs text-slate-500">控制当前设备重新打开后是否需要重新登录。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid gap-2 sm:max-w-xs">
            <label className="form-label">登录保留时长</label>
            <select
              value={sessionDays}
              onChange={(e) => saveSessionDays(Number(e.target.value))}
              disabled={savingSession}
              className="form-input"
            >
              {SESSION_DAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/login"
              className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
            >
              重新登录
            </a>
          </div>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">对话</div>
            <div className="mt-1 text-xs text-slate-500">控制右侧记账助手是否显示。</div>
          </div>
        </div>
        <div className="p-4">
          <label className="flex items-center justify-between rounded-[10px] border border-slate-200 bg-white px-3 py-3">
            <div>
              <div className="text-sm font-medium text-slate-800">启用记账助手</div>
              <div className="mt-1 text-xs text-slate-500">关闭后不显示右侧 AI 对话面板。</div>
            </div>
            <input
              type="checkbox"
              checked={aiPanelEnabled}
              disabled={savingAiPanel}
              onChange={(e) => saveAiPanelEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </label>
        </div>
      </section>

      {showModal && (
        <UserModal
          initial={editingUser ?? undefined}
          users={users}
          onSave={handleSave}
          onCancel={() => { setShowModal(false); setEditingUser(null); }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
              <div className="text-sm font-semibold text-slate-800">删除用户</div>
              <div className="mt-1 text-xs text-slate-500">删除前需要输入当前管理员密码。</div>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                确认删除用户“{deleteTarget.name}”？该操作不可撤销。
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">当前管理员密码</label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(""); }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="请输入当前管理员密码"
                  autoFocus
                />
              </div>
              {deleteError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{deleteError}</div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
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
