"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

/**
 * 统一的删除按钮组件
 *
 * 支持自定义确认消息、API路径和删除后的回调
 */
export function DeleteButton({
  resourceId,
  resourceName,
  displayName,
  deleteApiPath,
  confirmMessage,
  onSuccess,
  onError,
  buttonText = "删除",
  buttonClassName = "text-xs text-red-500 hover:text-red-700 disabled:opacity-40",
  showIcon = false,
}: {
  resourceId: string;
  resourceName?: string;
  displayName?: string;
  deleteApiPath: string;
  confirmMessage?: string;
  onSuccess?: () => void;
  onError?: (error: string) => void;
  buttonText?: string;
  buttonClassName?: string;
  showIcon?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const handleDelete = async () => {
    const message = confirmMessage || `确认删除"${displayName || resourceName || resourceId}"吗？`;
    const ok = window.confirm(message);
    if (!ok) return;

    setBusy(true);
    try {
      const res = await fetch(deleteApiPath, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: resourceId }),
      });
      const data = await res.json();

      if (data.ok) {
        window.dispatchEvent(new Event("mmh:fund:refresh"));

        onSuccess?.();
      } else {
        const error = data.error ?? "删除失败";
        if (onError) {
          onError(error);
        } else {
          window.alert(error);
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : "删除失败";
      if (onError) {
        onError(error);
      } else {
        window.alert(error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      className={buttonClassName}
      type="button"
    >
      {showIcon && <Trash2 className="w-3.5 h-3.5 inline mr-1" />}
      {buttonText}
    </button>
  );
}
