"use client";

import { useState, useEffect } from "react";

type ManagedUser = {
  id: string;
  name: string;
  role: string;
  isSystem?: boolean;
  hasPassword?: boolean;
  createdAt?: string;
};

function UserModal({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ManagedUser;
  onSave: (data: { name: string; role: string; password?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "user");
  const [password, setPassword] = useState("");
  const isSystemUser = initial?.isSystem ?? false;
  const hasExistingPassword = initial?.hasPassword ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">{initial ? "编辑用户" : "添加用户"}</div>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">用户名</label>
            <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder="输入用户名" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">角色</label>
            <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:opacity-60 disabled:bg-slate-50"
              value={role} onChange={(e) => setRole(e.target.value)} disabled={isSystemUser}>
              <option value="admin">管理员 (admin)</option>
              <option value="user">普通用户 (user)</option>
            </select>
            {isSystemUser && <div className="mt-1 text-[11px] text-slate-500">系统管理员角色不可更改</div>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              {initial ? (hasExistingPassword ? "修改密码（留空则不修改）" : "设置密码") : "密码"}
            </label>
            <input type="password" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder={initial ? (hasExistingPassword ? "留空则不修改" : "设置密码") : "设置密码"}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={onCancel}>取消</button>
            <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
              onClick={() => { if (name.trim()) onSave({ name: name.trim(), role, password: password.trim() || undefined }); }} disabled={!name.trim()}>
              {initial ? "保存" : "添加"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);

  useEffect(() => { fetchUsers(); }, []);

  async function fetchUsers() {
    try {
      const res = await fetch("/api/v1/settings/users");
      const data = await res.json();
      if (data.ok && Array.isArray(data.users)) setUsers(data.users);
    } catch { /* ignore */ }
  }

  async function handleSave(data: { name: string; role: string; password?: string }) {
    try {
      const url = "/api/v1/settings/users";
      const body = editingUser
        ? { id: editingUser.id, name: data.name, role: data.role, password: data.password }
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

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/v1/settings/users?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await res.json();
      if (result.ok) await fetchUsers();
      else window.alert(result.error || "删除失败");
    } catch { window.alert("删除失败"); }
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

      {users.length > 0 ? (
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <div className="divide-y divide-slate-100">
            {users.map((u) => (
              <div key={u.id} className="px-3 py-2 flex items-center gap-2">
                <span className="text-sm text-slate-800 flex-1 truncate">{u.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${u.role === "admin" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>
                  {u.role === "admin" ? "管理员" : "用户"}
                </span>
                {u.isSystem && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 shrink-0">系统</span>}
                <button className="text-xs text-slate-400 hover:text-blue-600 shrink-0" onClick={() => { setEditingUser(u); setShowModal(true); }}>编辑</button>
                {!u.isSystem && <button className="text-xs text-slate-400 hover:text-red-500 shrink-0" onClick={() => handleDelete(u.id)}>删除</button>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md bg-white">
          <span>暂无用户</span>
        </div>
      )}

      {showModal && (
        <UserModal
          initial={editingUser ?? undefined}
          onSave={handleSave}
          onCancel={() => { setShowModal(false); setEditingUser(null); }}
        />
      )}
    </div>
  );
}
