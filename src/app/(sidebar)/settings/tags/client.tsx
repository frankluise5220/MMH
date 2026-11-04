"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsMobileList,
  SettingsMobileRow,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { fetchSettingsTags, getCachedSettingsTags, notifySettingsDataChanged, setSettingsTags } from "@/lib/client/settingsCache";
import { BasicDataImportExportActions, BasicDataSubmenuHeader } from "@/components/settings/BasicDataImportExport";
import { useI18n } from "@/lib/i18n";
import { TAG_COLORS } from "@/lib/tag-colors";

type Tag = {
  id: string;
  name: string;
  color: string | null;
};

export default function SettingsTagsClient({
  initialTags,
  initialLoaded = false,
}: {
  initialTags: Tag[];
  initialLoaded?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
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
    else window.alert(data.error || t("settings.tags.deleteFailed"));
  }

  async function handleSaveTag(input: { id?: string; name: string; color: string }) {
    const res = await fetch("/api/v1/tags", {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; tag?: Tag } | null;
    if (!res.ok || !data?.ok || !data.tag) {
      throw new Error(data?.error || t("settings.tags.saveFailed"));
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

  // 桌面是双击行、手机是单击卡片：同一条跳转只在函数里写一次。
  function openTagDetail(tag: Tag) {
    const params = new URLSearchParams({ view: "detail", tagId: tag.id, detailAll: "1" });
    router.push(`/?${params.toString()}`);
  }

  // 整册基础资料的模板导出/导入（2026-11-04 用户要求）：紧挨「新增」左侧，tooltip 说明作用域。
  // 标签页标题栏没有分类筛选，两个按钮 + 新增约 300px，内容列 ≥ 352px 就能放下。
  const importExportActions = (
    <BasicDataImportExportActions
      className="hidden @min-[22rem]:flex"
      onImported={() => {
        router.refresh();
        void fetchTags();
      }}
    />
  );

  return (
    // 桌面撑满视口剩余高度，卡片才好把「长表格」收进内滚（滚动条落在表格里而不是卡片外）；
    // 手机不加 `h-full`，正文是卡片列表，仍按内容自然长高、由页面滚动。
    <div className="flex min-h-0 flex-col gap-4 desktop:h-full">
      {/* FT 页签条与卡片同一个 relative 容器、中间不留 gap（见 BasicDataSubmenuHeader 注释）。 */}
      <div className="relative desktop:flex desktop:min-h-0 desktop:flex-1 desktop:flex-col">
        {/* 页签条只放四个页签（不再挂工具栏），导出/导入已移到卡片标题栏「新增」左侧。 */}
        <BasicDataSubmenuHeader />
        {/* 卡片标题栏也取卡片底色（`.panel-header` 自带 `bg-surface-muted/90`，会在卡片顶部
            插进一条近白横带，把「页签 → 卡片」的连续底色切断）；底色一路连续到标题栏下边框为止。 */}
        <div className="@container relative z-20 desktop:flex desktop:min-h-0 desktop:flex-1 desktop:flex-col [&>section]:rounded-xl [&>section]:border-slate-300 [&>section]:bg-[var(--ft-card-bg)] [&>section>.panel-header]:bg-[var(--ft-card-bg)]">
      <SettingsSection
        title={t("settings.tags.listTitle")}
        count={tags.length}
        actions={<>{importExportActions}<SettingsPrimaryAddButton onClick={() => setEditing({ id: "", name: "", color: TAG_COLORS[6] })}>{t("settings.tags.add")}</SettingsPrimaryAddButton></>}
        mobileActions={<SettingsPrimaryAddButton onClick={() => setEditing({ id: "", name: "", color: TAG_COLORS[6] })}>{t("settings.tags.add")}</SettingsPrimaryAddButton>}
        fillHeight
      >
        <SettingsMobileList>
          {tags.length ? tags.map((tag) => (
            <SettingsMobileRow
              key={tag.id}
              onPress={() => openTagDetail(tag)}
              title={tag.name}
              meta={(
                <>
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: tag.color || "#64748B" }} />
                  <span className="font-mono text-[11px] text-slate-500">{tag.color || "#64748B"}</span>
                  <span className="text-slate-300">·</span>
                  <span>{t("settings.tags.tapForRecords")}</span>
                </>
              )}
              actions={(
                <>
                  <SettingsActionButton
                    label={t("settings.tags.edit")}
                    variant="edit"
                    onClick={() => setEditing(tag)}
                  />
                  <SettingsActionButton
                    label={t("settings.tags.delete")}
                    variant="delete"
                    onClick={() => void handleDelete(tag.id)}
                  />
                </>
              )}
            />
          )) : (
            <div className="px-4 py-10 text-center text-sm text-slate-400">{t("settings.tags.empty")}</div>
          )}
        </SettingsMobileList>

        {/* 桌面表格层：卡片里的可伸缩体，滚动交给 `SettingsTable` 的内层 */}
        <div className="hidden desktop:flex desktop:min-h-0 desktop:flex-1 desktop:flex-col">
        <SettingsTable minWidth={640} fillHeight>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>{t("settings.tags.tag")}</SettingsTh>
              <SettingsTh>{t("settings.tags.color")}</SettingsTh>
              <SettingsTh align="right">{t("settings.tags.actions")}</SettingsTh>
            </tr>
          </thead>
          <tbody className="text-sm">
            {tags.length ? tags.map((tag) => (
              <tr
                key={tag.id}
                className="cursor-pointer hover:bg-slate-50"
                onDoubleClick={() => openTagDetail(tag)}
              >
                <SettingsTd className="text-sm font-medium text-slate-800">{tag.name}</SettingsTd>
                <SettingsTd>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: tag.color || "#64748B" }} />
                    <span className="font-mono text-[11px] text-slate-500">{tag.color || "#64748B"}</span>
                  </div>
                </SettingsTd>
                <SettingsTd align="right" onDoubleClick={(event) => event.stopPropagation()}>
                  <SettingsRowActions>
                    <SettingsActionButton
                      label={t("settings.tags.edit")}
                      variant="edit"
                      onClick={() => setEditing(tag)}
                    />
                    <SettingsActionButton
                      label={t("settings.tags.delete")}
                      variant="delete"
                      onClick={() => handleDelete(tag.id)}
                    />
                  </SettingsRowActions>
                </SettingsTd>
              </tr>
            )) : (
              <SettingsEmptyRow colSpan={3}>{t("settings.tags.empty")}</SettingsEmptyRow>
            )}
          </tbody>
        </SettingsTable>
        </div>
      </SettingsSection>
        </div>
      </div>

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
  const { t } = useI18n();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color || TAG_COLORS[6]);
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
      setError(err instanceof Error ? err.message : t("settings.tags.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalLayer className="app-modal-backdrop">
      <div className="app-modal-panel max-w-md">
        <div className="modal-header shrink-0">
          <div className="text-sm font-semibold text-slate-800">{tag ? t("settings.tags.edit") : t("settings.tags.add")}</div>
          <button type="button" onClick={onCancel} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form className="space-y-4 p-4" onSubmit={submit}>
          {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div> : null}
          <label className="block space-y-1">
            <span className="form-label">{t("settings.tags.name")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              className="form-input"
              placeholder={t("settings.tags.namePlaceholder")}
            />
          </label>
          <div className="space-y-2">
            <div className="form-label">{t("settings.tags.color")}</div>
            <div className="grid grid-cols-6 gap-2">
              {TAG_COLORS.map((item) => (
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
            <button type="button" onClick={onCancel} className="secondary-button h-9 px-4">{t("common.cancel")}</button>
            <button type="submit" disabled={saving || !name.trim()} className="primary-button h-9 px-4 disabled:opacity-50">
              {saving ? t("settings.tags.saving") : t("common.save")}
            </button>
          </div>
        </form>
      </div>
    </ModalLayer>
  );
}
