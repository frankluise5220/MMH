"use client";

import { Share2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { withBasePath } from "@/lib/base-path";

const INSTALL_HINT_DISMISSED_KEY = "mmh_pwa_install_hint_dismissed";

// Built once through the single base-path exit, then reused for both jobs below
// (comparing an existing scope and registering ours). `""` on every channel
// served from the origin root, `/app/mmh` on the fnOS gateway build. Deriving
// it here instead of concatenating MMH_BASE_PATH by hand is what keeps this
// file on the same invariant as the rest of the app: a prefix can be added
// exactly once, so nothing ever has to "repair" one later.
const SW_SCOPE = withBasePath("/");
const SW_SCRIPT = withBasePath("/sw.js");
const SW_SCOPE_BASE = SW_SCOPE.replace(/\/+$/, "");
// Cache names created by public/sw.js are `${SW_VERSION}-shell`, and SW_VERSION
// is always `mmh-pwa-<n>`; sw.js itself drops every other `mmh-pwa-` key on
// activate. Dev cleanup uses the same prefix so storage never outlives the worker.
const SW_CACHE_PREFIX = "mmh-pwa-";

function isIosDevice() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isSafariBrowser() {
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/i.test(ua);
}

function isStandaloneMode() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

// A mounted client component can already be past `load` (slow hydration, restored
// tab, bfcache); a bare `load` listener would then never run. Both callers below
// must always execute exactly once.
function whenLoaded(run: () => void) {
  if (document.readyState === "complete") {
    run();
    return;
  }
  window.addEventListener("load", run, { once: true });
}

function hasDismissedInstallHint() {
  try {
    return window.localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberInstallHintDismissed() {
  try {
    window.localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, "1");
  } catch {}
}

export function PwaServiceWorkerRegistration() {
  const { t } = useI18n();
  const [showInstallHint, setShowInstallHint] = useState(false);
  const [isSafari, setIsSafari] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      // `next dev` never registers a worker, but an earlier production build on the
      // same origin may have left one behind. Its scope is "/" exactly like this
      // build's, so the production-only cleanup below (which keeps scope matches)
      // would never touch it. sw.js answers /_next/ cache-first, and dev chunk
      // paths are stable (no content hash), so that leftover worker keeps feeding
      // the browser pre-edit JS/CSS: the server is fixed, the page is not.
      // No worker is legitimate in dev, so drop them all and their shell caches.
      whenLoaded(() => {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
          .catch(() => undefined);

        if ("caches" in window) {
          caches
            .keys()
            .then((keys) =>
              Promise.all(
                keys.filter((key) => key.startsWith(SW_CACHE_PREFIX)).map((key) => caches.delete(key)),
              ),
            )
            .catch(() => undefined);
        }
      });
      return;
    }

    whenLoaded(() => {
      // Drop service workers left behind by a different deployment shape on the
      // same origin: an IP:port that used to serve the fnOS package registered
      // our worker with scope /app/mmh, and that registration survives the
      // switch to Docker. Its BASE stays "/app/mmh" forever, so it rewrites
      // every navigation to a path the new backend does not serve -> 404 after
      // login. Symmetric case included (gateway after Docker). Only registrations
      // whose scope matches this build's baked-in base path are kept.
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const registration of registrations) {
            try {
              const scopePath = new URL(registration.scope).pathname.replace(/\/+$/, "");
              if (scopePath !== SW_SCOPE_BASE) registration.unregister();
            } catch {
              // A malformed scope should never break registration below.
            }
          }
        })
        .catch(() => undefined);

      // On the fnOS gateway build the app lives under /app/mmh, so both the
      // script URL and its scope have to stay inside that prefix; sw.js derives
      // its own base from self.registration.scope. Empty on other channels, so
      // this stays exactly "/sw.js" + scope "/" there.
      navigator.serviceWorker.register(SW_SCRIPT, {
        scope: SW_SCOPE,
        updateViaCache: "none",
      }).catch((error) => {
        console.warn("MMH service worker registration failed:", error);
      });
    });
  }, []);

  useEffect(() => {
    if (!isIosDevice() || isStandaloneMode()) return;
    if (hasDismissedInstallHint()) return;
    setIsSafari(isSafariBrowser());
    setShowInstallHint(true);
  }, []);

  function dismissInstallHint() {
    rememberInstallHintDismissed();
    setShowInstallHint(false);
  }

  if (!showInstallHint) return null;

  return (
    <div className="fixed inset-x-3 bottom-[calc(5.75rem+env(safe-area-inset-bottom)+0.75rem)] z-[70] md:hidden">
      <div className="rounded-xl border border-slate-200 bg-white/95 p-3 text-slate-800 shadow-[0_16px_36px_rgba(15,23,42,0.18)] backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-700">
            <Share2 size={17} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{t("pwa.install.title")}</div>
            <div className="mt-1 text-xs leading-5 text-slate-600">
              {isSafari ? t("pwa.install.safariInstruction") : t("pwa.install.openSafariInstruction")}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissInstallHint}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
            aria-label={t("pwa.install.dismiss")}
          >
            <X size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
