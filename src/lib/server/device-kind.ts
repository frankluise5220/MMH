import { cookies, headers } from "next/headers";
import { cache } from "react";

import { DEVICE_KIND_COOKIE, detectDeviceKind, normalizeDeviceKind, type DeviceKind } from "@/lib/device-kind";

export type { DeviceKind };

/**
 * 当前请求的设备形态。RSC 与 route handler 都可以调用；`cache()` 让同一次
 * 请求里 RootLayout 和 (sidebar)/layout 只读一遍请求头。
 *
 * cookie 覆盖优先于请求头：某些场景（iPad 的「请求桌面网站」、桌面浏览器的
 * UA 伪装）UA 会撒谎，此时用户显式选择应当胜出。
 */
export const getDeviceKind = cache(async (): Promise<DeviceKind> => {
  const cookieStore = await cookies();
  const override = normalizeDeviceKind(cookieStore.get(DEVICE_KIND_COOKIE)?.value);
  if (override) return override;
  return detectDeviceKind(await headers());
});
