import "./globals.css";
import Script from "next/script";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { ModalDragController } from "@/components/ModalDragController";
import { PwaServiceWorkerRegistration } from "@/components/PwaServiceWorkerRegistration";
import { ClientLogCollector } from "@/components/ClientLogCollector";
import { I18nProvider } from "@/components/I18nProvider";
import { DeviceKindProvider } from "@/components/DeviceKindProvider";
import PreferencesSync from "@/components/PreferencesSync";
import { getDeviceKind } from "@/lib/server/device-kind";
import { DISPLAY_LANGUAGE_COOKIE } from "@/lib/server/i18n";
import type { DisplayLanguage } from "@/lib/client/appPreferences";
import { MMH_BASE_PATH, withBasePath } from "@/lib/base-path";

export const metadata: Metadata = {
  applicationName: "MoneyMoneyHome",
  title: "MoneyMoneyHome",
  description: "Local-first family finance system",
  manifest: "/manifest.webmanifest",
  icons: {
    // Next.js applies basePath to `manifest` but NOT to `metadata.icons`, so
    // every icon URL has to be prefixed by hand on the fnOS gateway build.
    icon: [
      { url: withBasePath("/favicon.ico") },
      { url: withBasePath("/branding/mmh-logo-pwa-192.png"), sizes: "192x192", type: "image/png" },
      { url: withBasePath("/branding/mmh-logo-pwa-512.png"), sizes: "512x512", type: "image/png" },
    ],
    shortcut: withBasePath("/favicon.ico"),
    apple: withBasePath("/apple-touch-icon.png"),
  },
  appleWebApp: {
    capable: true,
    title: "MoneyMoneyHome",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 锁定缩放：iOS Safari 在输入框聚焦弹出软键盘时会自动放大页面（input focus zoom），
  // 导致界面整体放大、不便滑动。记账高频输入场景下禁用手动缩放是合理取舍。
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // 软键盘弹出时重排内容（而非覆盖在内容上），避免输入框被键盘挡住。
  interactiveWidget: "resizes-content",
  themeColor: "#f4f7fb",
  colorScheme: "light",
};

/**
 * fnOS gateway builds only. Next rewrites redirect(), <Link>, the router and
 * /_next assets for basePath, but it cannot rewrite a URL the app hands to the
 * browser by hand. Measured on the 5.149 device: /app/mmh/api/* answers,
 * /api/* is 404, and a bare `/regular-invest?create=1` lands on the gateway
 * root, which routes nothing to MMH and answers with fnOS's own "here is no
 * page installed" placeholder.
 *
 * Hand-written exits are covered in three layers, and all three are required:
 *
 *  1. The call site uses `withBasePath()` (`src/lib/base-path.ts`) and is right
 *     on its own. The guard script rejects new bare-root exits.
 *  2. THIS shim rewrites every browser-level exit before app code runs, so a
 *     forgotten call site still works instead of dropping the prefix. It covers
 *     fetch / XMLHttpRequest (requests), history.pushState/replaceState,
 *     location.assign/replace, window.open and raw `<a href>` activations
 *     (navigations, including target="_blank" and modifier clicks).
 *  3. `scripts/check-fnos-gateway-guards.cjs` extracts this script and these
 *     behaviours from the real sources, so a regression fails packaging.
 *
 * Only origin-absolute paths are rewritten; external URLs, "//host",
 * "data:"/"blob:" and already-prefixed paths are left alone. Empty (no script
 * emitted at all) on Docker / Synology / Android, where MMH_BASE_PATH is "".
 */
const gatewayPrefixScript = MMH_BASE_PATH
  ? `
(() => {
  const BASE = ${JSON.stringify(MMH_BASE_PATH)};
  const rewrite = (input) => {
    if (typeof input !== "string") return input;
    // charCodeAt(0) === 47 is "/"; a leading "//" is protocol-relative (external).
    if (input.charCodeAt(0) !== 47 || input.charCodeAt(1) === 47) return input;
    // Decide "already prefixed" on the PATH only. Next collapses a basePath'd
    // root route to the BARE prefix plus its query ("/?view=allcash" ->
    // "/app/mmh?view=allcash"), so a raw startsWith(BASE + "/") test misses
    // that form and prepends the prefix a second time
    // ("/app/mmh/app/mmh?view=allcash"), 404ing every root-route request --
    // including the router's own RSC fetches, measured on 5.149 in v0.1.71.
    const cut = input.search(/[?#]/);
    const pathOnly = cut === -1 ? input : input.slice(0, cut);
    if (pathOnly === BASE || pathOnly.startsWith(BASE + "/")) return input;
    return BASE + input;
  };
  const rewriteUrl = (url) => {
    const path = url.pathname + url.search;
    const fixed = rewrite(path);
    if (fixed === path) return url;
    return new URL(url.origin + fixed);
  };
  // fetch/XHR/history/location/window.open all accept a string or a URL object.
  const rewriteTarget = (target) =>
    typeof URL !== "undefined" && target instanceof URL ? rewriteUrl(target) : rewrite(target);
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      let target = input;
      try {
        if (typeof input === "string") {
          target = rewrite(input);
        } else if (typeof URL !== "undefined" && input instanceof URL) {
          target = rewriteUrl(input);
        } else if (typeof Request !== "undefined" && input instanceof Request) {
          const url = rewriteUrl(new URL(input.url));
          if (url.href !== input.url) target = new Request(url, input);
        }
      } catch (error) {
        target = input;
      }
      return originalFetch.call(this, target, init);
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const args = Array.prototype.slice.call(arguments);
    try {
      args[1] = rewrite(url);
    } catch (error) {
      args[1] = url;
    }
    return originalOpen.apply(this, args);
  };
  // Hand-written history/location navigations. Next prefixes its own
  // router.push/replace, but not a bare replaceState(..., "/?view=x") or
  // location.assign("/x") -- and those are exactly what silently drop the
  // prefix from the address bar, which breaks reload, bookmark and share.
  const shimHistory = window.history;
  const patchHistory = (name) => {
    const original = shimHistory[name];
    if (typeof original !== "function") return;
    shimHistory[name] = function (state, title, url) {
      const args = Array.prototype.slice.call(arguments);
      if (args.length > 2) args[2] = rewriteTarget(args[2]);
      return original.apply(this, args);
    };
  };
  if (shimHistory) {
    try {
      patchHistory("pushState");
      patchHistory("replaceState");
    } catch (error) {}
  }
  const shimLocation = window.location;
  const patchLocation = (name) => {
    const original = shimLocation[name];
    if (typeof original !== "function") return;
    const patched = function (url) {
      const args = Array.prototype.slice.call(arguments);
      args[0] = rewriteTarget(args[0]);
      return original.apply(this, args);
    };
    try {
      shimLocation[name] = patched;
      // A silent no-op assignment (non-writable in some engines) must not pass
      // for a successful patch.
      if (shimLocation[name] === patched) return;
    } catch (error) {}
    // Location members are unforgeable own properties; fall back to the
    // prototype only when the instance itself refuses the assignment.
    const proto = window.Location && window.Location.prototype;
    if (proto) {
      try {
        proto[name] = patched;
      } catch (innerError) {}
    }
  };
  if (shimLocation) {
    try {
      patchLocation("assign");
      patchLocation("replace");
    } catch (error) {}
  }
  const originalOpenWindow = window.open;
  if (typeof originalOpenWindow === "function") {
    window.open = function (url) {
      const args = Array.prototype.slice.call(arguments);
      if (args.length > 0) args[0] = rewriteTarget(args[0]);
      return originalOpenWindow.apply(this, args);
    };
  }
  // A raw <a href="/..."> (including target="_blank", e.g. an attachment
  // download) never passes through Next's router, so the browser resolves it
  // against the gateway origin. An anchor that already carries the prefix --
  // every next/link -- is left untouched, so SPA navigation keeps working.
  const shimDocument = window.document;
  const activateAnchor = (event) => {
    try {
      if (!event || event.defaultPrevented) return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const anchor = target.closest("a[href]");
      if (!anchor) return;
      const raw = anchor.getAttribute("href");
      if (typeof raw !== "string") return;
      const fixed = rewrite(raw);
      if (fixed === raw) return;
      if (typeof anchor.hasAttribute === "function" && anchor.hasAttribute("download")) {
        // Nothing to intercept here: point the default download at the fixed URL.
        anchor.setAttribute("href", fixed);
        return;
      }
      event.preventDefault();
      const opensNewTab =
        anchor.target === "_blank" ||
        event.type === "auxclick" ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button === 1;
      if (opensNewTab && typeof window.open === "function") {
        window.open(fixed, "_blank", "noopener,noreferrer");
        return;
      }
      window.location.href = fixed;
    } catch (error) {}
  };
  if (shimDocument && typeof shimDocument.addEventListener === "function") {
    shimDocument.addEventListener("click", activateAnchor, true);
    shimDocument.addEventListener("auxclick", activateAnchor, true);
  }
})();
`
  : "";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const store = await cookies();
  const raw = store.get(DISPLAY_LANGUAGE_COOKIE)?.value;
  const displayLanguage: DisplayLanguage = raw === "en-US" || raw === "ja-JP" ? raw : "zh-CN";
  // 设备形态在服务端一次定好：子树里的客户端组件据此选 UI 树，形如
  // `<html data-device="mobile">` 也让纯 CSS 场景能跟着切。
  const deviceKind = await getDeviceKind();

  return (
    <html lang={displayLanguage} data-device={deviceKind} suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="antialiased h-screen overflow-x-hidden overflow-y-hidden"
      >
        {gatewayPrefixScript ? (
          <Script
            id="gateway-prefix"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{ __html: gatewayPrefixScript }}
          />
        ) : null}
        <DeviceKindProvider value={deviceKind}>
          <I18nProvider initialLanguage={displayLanguage}>{children}</I18nProvider>
        </DeviceKindProvider>
        <PreferencesSync />
        <ModalDragController />
        <PwaServiceWorkerRegistration />
        <ClientLogCollector />
        <Script
          id="performance-measure-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                try {
                  const persist = (key, value) => {
                    if (value === null || value === undefined) return;
                    document.cookie = key + "=" + encodeURIComponent(value) + "; path=/; max-age=31536000; samesite=lax";
                  };
                  // 只补「纯设备状态」的 cookie：它们的 cookie 仅由用户操作时写入
                  // （appPreferences.setXxx），cookie 被清后没有别的写者会补回来。
                  persist("sidebar_collapsed", localStorage.getItem("sidebar_collapsed"));
                  persist("sidebar_owner_filter", localStorage.getItem("sidebar_owner_filter"));
                  persist("mmh_ai_panel_collapsed", localStorage.getItem("mmh_ai_panel_collapsed"));
                  // sidebar_group_by / sidebar_hide_zero / sidebar_hide_initial_data 不在这里补：
                  // 它们的 cookie 由 PreferencesSync 每次加载用数据库值覆盖，这段写完就被盖掉，
                  // 既不改变本次渲染（SSR 已经出 HTML），也不会留到下一次请求。
                } catch (error) {}
                const perf = window.performance;
                if (!perf || typeof perf.measure !== "function" || perf.__mmhMeasureGuard) return;
                const originalMeasure = perf.measure.bind(perf);
                Object.defineProperty(perf, "__mmhMeasureGuard", { value: true });
                perf.measure = function(name, startOrOptions, endMark) {
                  try {
                    return originalMeasure(name, startOrOptions, endMark);
                  } catch (error) {
                    const message = error && typeof error.message === "string" ? error.message : "";
                    if (message.includes("negative time stamp")) {
                      return { name, entryType: "measure", startTime: 0, duration: 0 };
                    }
                    throw error;
                  }
                };
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}
