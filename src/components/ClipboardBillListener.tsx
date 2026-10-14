"use client";

import { useEffect, useRef } from "react";

import { addClipboardDraft, isAutoDraftEnabled } from "@/lib/client/clipboard-drafts";

/**
 * 剪贴板账单监听：web 端「自动记账」的捕获入口。
 *
 * 时机：标签页回到前台（visibilitychange → visible）时试读一次剪贴板。这样用户从
 * 支付 App 复制账单、切回 MMH 时，就会自动捕获；在 MMH 内部复制/粘贴不会误触发。
 *
 * 隐私：只在本地用正则预判（parseClipboardBill），命中才写 localStorage 草稿，确认后才
 * 走 AI 入账。总开关在 localStorage（默认开），关掉后完全不再读剪贴板。
 */

const CLIPBOARD_GUARD_MS = 1500; // 连续回到前台的最小间隔，避免抖动
const CLIPBOARD_COOLDOWN_MS = 30_000; // 同一条剪贴板内容的冷却期（用户确认/忽略后不再重复弹）

export function ClipboardBillListener() {
  const lastReadAt = useRef(0);
  const lastContent = useRef<string>("");

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!isAutoDraftEnabled()) return;
      const now = Date.now();
      if (now - lastReadAt.current < CLIPBOARD_GUARD_MS) return;
      lastReadAt.current = now;

      // 只在支持 Clipboard API + 授权读取时尝试；失败静默（无权限不打扰）。
      const read = async () => {
        try {
          if (!navigator.clipboard?.readText) return;
          const text = await navigator.clipboard.readText();
          if (!text || text === lastContent.current) return;
          const added = addClipboardDraft(text);
          if (added) {
            // 记录本次内容，30s 内不再对同一内容重复捕获。
            lastContent.current = text;
            window.setTimeout(() => {
              if (lastContent.current === text) lastContent.current = "";
            }, CLIPBOARD_COOLDOWN_MS);
          }
        } catch {
          // 剪贴板读取被拒绝或不可用 —— 静默跳过，不打扰用户。
        }
      };
      void read();
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return null;
}
