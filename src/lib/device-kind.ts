/**
 * Device kind（手机 / 桌面）判定。
 *
 * 这里只回答一个问题：**这台设备是不是手机**，不回答「窗口有多宽」。页宽是
 * 布局几何（`md:` 断点管的东西），设备形态（渲染哪一套 UI 树、外壳用侧边栏
 * 还是底部导航）必须由设备决定 —— 否则桌面浏览器把窗口拖窄就变成「移动版」，
 * 而平板横屏仍然是移动设备却拿到桌面 UI。
 *
 * 判定优先级（逐条都是「设备事实」，不是视口事实）：
 *   1. `sec-ch-ua-mobile: ?1` —— 浏览器自己声明的移动平台，最可靠。
 *   2. `sec-ch-ua-platform: "iOS" | "Android"` —— iPadOS 13+ 的 Safari 会把 UA
 *      伪装成 Macintosh，只有平台位能认出它是 iPad；Android 平板不上报
 *      "Mobile"，但仍然是触屏设备。
 *   3. UA 正则兜底 —— 老浏览器、代理、以及不发 Client Hints 的客户端。
 *
 * 这个文件不 import `next/headers`，客户端组件可以安全地只取类型；服务端的
 * `getDeviceKind()` 在 `src/lib/server/device-kind.ts`。
 */

export type DeviceKind = "mobile" | "desktop";

/** 手动覆盖设备形态的 cookie；留空表示按请求头自动判定。 */
export const DEVICE_KIND_COOKIE = "mmh_device_kind";

/** 带 "Mobile" 之外的 iPad/iPod 也要算进来（iPad 老版本 UA 带 iPad 字样）。 */
const MOBILE_UA_PATTERN =
  /iPhone|iPod|iPad|Android|Windows Phone|IEMobile|Opera Mini|BlackBerry|PlayBook|Silk|Kindle/i;

/** Android 平板不带 "Mobile"，但仍是 Android，所以上面没有要求 Mobile 后缀。 */
const DESKTOP_ONLY_UA_PATTERN = /Windows NT|Macintosh|X11|CrOS|Linux x86_64/i;

export function normalizeDeviceKind(value: string | null | undefined): DeviceKind | null {
  if (value === "mobile" || value === "desktop") return value;
  return null;
}

export function detectDeviceKind(requestHeaders: Headers): DeviceKind {
  const clientHintMobile = requestHeaders.get("sec-ch-ua-mobile");
  if (clientHintMobile === "?1") return "mobile";

  const clientHintPlatform = (requestHeaders.get("sec-ch-ua-platform") ?? "")
    .replace(/"/g, "")
    .trim()
    .toLowerCase();
  // iPadOS 13+ / Android 平板：UA 可能是桌面形态，平台位才是真相。
  if (clientHintPlatform === "ios" || clientHintPlatform === "android") return "mobile";

  const userAgent = requestHeaders.get("user-agent") ?? "";
  if (MOBILE_UA_PATTERN.test(userAgent)) return "mobile";
  if (DESKTOP_ONLY_UA_PATTERN.test(userAgent)) return "desktop";
  // 认不出来的客户端（爬虫、curl、未知 UA）按桌面渲染：桌面树是功能最全的那套。
  return "desktop";
}
