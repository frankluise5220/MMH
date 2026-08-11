"use client";

import { useEffect, useState, type FormEvent } from "react";
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
import { fetchSettingsTags, getCachedSettingsTags, notifySettingsDataChanged, setSettingsTags } from "@/lib/client/settingsCache";

type Tag = {
  id: string;
  name: string;
  color: string | null;
};

const COLORS = [
  "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#22C55E",
  "#14B8A6", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899",
  "#64748B", "#0EA5E9",
];

export default function SettingsTagsClient({
  initialTags,
  initialLoaded = false,
}: {
  initialTags: Tag[];
  initialLoaded?: boolean;
}) {
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [editing, setEditing] = useState<Tag | null>(null);

  useEffect(() => {
    if (initialLoaded) {
      setSettingsTags(initialTags);
      return;
    }
    const cached = getCachedSettingsTags();
    if (cached) {
      setTags(cached);
      return;
    }
    fetchTags();
  }, [initialLoaded, initialTags]);

  async function fetchTags() {
    const next = await fetchSettingsTags().catch(() => null);
    if (next) setTags(next);
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/v1/tags?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      setTags(prev => {
        const next = prev.filter(t => t.id !== id);
        setSettingsTags(next);
        return next;
      });
      void notifySettingsDataChanged({ scope: "tags", reason: "tag:delete", prefetch: true });
    }
    else window.alert(data.error || "删除失败");
  }

  async function handleSaveTag(input: { id?: string; name: string; color: string }) {
    const res = await fetch("/api/v1/tags", {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; tag?: Tag } | null;
    if (!res.ok || !data?.ok || !data.tag) {
      throw new Error(data?.error || "保存失败");
    }
    setTags((prev) => {
      const next = input.id
        ? prev.map((tag) => (tag.id === input.id ? data.tag! : tag))
        : [...prev, data.tag!];
      setSettingsTags(next);
      return next;
    });
    void notifySettingsDataChanged({ scope: "tags", reason: input.id ? "tag:update" : "tag:create", prefetch: true });
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="标签管理"
        description="维护流水和业务记录可复用的标签，系统自动添加的标签也会在这里显示和编辑。"
        count={tags.length}
        actions={<SettingsPrimaryAddButton onClick={() => setEditing({ id: "", name: "", color: COLORS[6] })}>新增标签</SettingsPrimaryAddButton>}
      />

      <SettingsSection title="标签列表" count={tags.length}>
        <SettingsTable minWidth={640}>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>标签</SettingsTh>
              <SettingsTh>颜色</SettingsTh>
              <SettingsTh align="right">操作</SettingsTh>
            </tr>
          </thead>
          <tbody className="text-sm">
            {tags.length ? tags.map((tag) => (
              <tr key={tag.id} className="hover:bg-slate-50">
                <SettingsTd className="text-sm font-medium text-slate-800">{tag.name}</SettingsTd>
                <SettingsTd>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: tag.color || "#64748B" }} />
                    <span className="font-mono text-[11px] text-slate-500">{tag.color || "#64748B"}</span>
                  </div>
                </SettingsTd>
                <SettingsTd align="right">
                  <SettingsRowActions>
                    <SettingsActionButton
                      label="编辑标签"
                      variant="edit"
                      onClick={() => setEditing(tag)}
                    />
                    <SettingsActionButton
                      label="删除标签"
                      variant="delete"
                      onClick={() => handleDelete(tag.id)}
                    />
                  </SettingsRowActions>
                </SettingsTd>
              </tr>
            )) : (
              <SettingsEmptyRow colSpan={3}>暂无标签</SettingsEmptyRow>
            )}
          </tbody>
        </SettingsTable>
      </SettingsSection>

      {editing ? (
        <TagEditModal
          tag={editing.id ? editing : undefined}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            await handleSaveTag(input);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TagEditModal({
  tag,
  onCancel,
  onSave,
}: {
  tag?: Tag;
  onCancel: () => void;
  onSave: (input: { id?: string; name: string; color: string }) => Promise<void>;
}) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color || COLORS[6]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave({ id: tag?.id, name: name.trim(), color });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-modal-backdrop z-[1100]">
      <div className="app-modal-panel max-w-md">
        <div className="modal-header shrink-0">
          <div className="text-sm font-semibold text-slate-800">{tag ? "编辑标签" : "新增标签"}</div>
          <button type="button" onClick={onCancel} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form className="space-y-4 p-4" onSubmit={submit}>
          {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div> : null}
          <label className="block space-y-1">
            <span className="form-label">名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              className="form-input"
              placeholder="输入标签名称"
            />
          </label>
          <div className="space-y-2">
            <div className="form-label">颜色</div>
            <div className="grid grid-cols-6 gap-2">
              {COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setColor(item)}
                  className={`h-8 rounded-md border-2 transition ${color === item ? "border-slate-900" : "border-transparent hover:border-slate-300"}`}
                  style={{ backgroundColor: item }}
                  title={item}
                />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" onClick={onCancel} className="secondary-button h-9 px-4">取消</button>
            <button type="submit" disabled={saving || !name.trim()} className="primary-button h-9 px-4 disabled:opacity-50">
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
