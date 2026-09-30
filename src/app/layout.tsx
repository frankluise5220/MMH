import "./globals.css";
import Script from "next/script";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { ModalDragController } from "@/components/ModalDragController";
import { PwaServiceWorkerRegistration } from "@/components/PwaServiceWorkerRegistration";
import { ClientLogCollector } from "@/components/ClientLogCollector";
import { I18nProvider } from "@/components/I18nProvider";
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
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#f4f7fb",
  colorScheme: "light",
};

/**
 * fnOS gateway builds only. Next rewrites redirect(), <Link>, the router and
 * /_next assets for basePath, but it cannot rewrite a hand-written
 * `fetch("/api/...")` -- and the browser resolves that against the fnOS origin
 * (http://nas:5666/api/...), where the gateway routes nothing to MMH. Measured
 * on the 5.149 device: /app/mmh/api/* answers, /api/* is 404.
 *
 * So install one request-recording-level shim, before any app code runs:
 * origin-absolute paths get the prefix; external URLs, "//host" and
 * already-prefixed paths are left alone. Empty (no script emitted at all) on
 * Docker / Synology / Android, where MMH_BASE_PATH is "".
 */
const gatewayRequestPrefixScript = MMH_BASE_PATH
  ? `
(() => {
  const BASE = ${JSON.stringify(MMH_BASE_PATH)};
  const rewrite = (input) => {
    if (typeof input !== "string") return input;
    // charCodeAt(0) === 47 is "/"; a leading "//" is protocol-relative (external).
    if (input.charCodeAt(0) !== 47 || input.charCodeAt(1) === 47) return input;
    if (input === BASE || input.startsWith(BASE + "/")) return input;
    return BASE + input;
  };
  const rewriteUrl = (url) => {
    const path = url.pathname + url.search;
    const fixed = rewrite(path);
    if (fixed === path) return url;
    return new URL(url.origin + fixed);
  };
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

  return (
    <html lang={displayLanguage} suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="antialiased h-screen overflow-x-hidden overflow-y-hidden"
      >
        {gatewayRequestPrefixScript ? (
          <Script
            id="gateway-request-prefix"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{ __html: gatewayRequestPrefixScript }}
          />
        ) : null}
        <I18nProvider initialLanguage={displayLanguage}>{children}</I18nProvider>
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
                  persist("sidebar_collapsed", localStorage.getItem("sidebar_collapsed"));
                  persist("sidebar_group_by", localStorage.getItem("sidebar_group_by"));
                  persist("sidebar_hide_zero", localStorage.getItem("sidebar_hide_zero"));
                  persist("sidebar_hide_initial_data", localStorage.getItem("sidebar_hide_initial_data"));
                  persist("sidebar_owner_filter", localStorage.getItem("sidebar_owner_filter"));
                  persist("mmh_ai_panel_collapsed", localStorage.getItem("mmh_ai_panel_collapsed"));
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
