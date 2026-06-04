"use client";

import { useRouter } from "next/navigation";

/**
 * 客户端刷新辅助函数
 * 添加100ms延迟等待服务端revalidate完成后再刷新
 */
export function useRefresh() {
  const router = useRouter();

  /**
   * 延迟刷新页面，确保服务端revalidate完成
   * @param delay 延迟时间（毫秒），默认100ms
   */
  async function refresh(delay = 100) {
    await new Promise(resolve => setTimeout(resolve, delay));
    router.refresh();
  }

  return refresh;
}