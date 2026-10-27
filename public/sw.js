const SW_VERSION = "mmh-pwa-v10";

// fnOS unified gateway: the app is served under /app/mmh and this worker is
// registered with that exact scope, so self.registration.scope is the single
// source of truth for the prefix -- "https://host/app/mmh/" -> "/app/mmh", and
// "https://host/" -> "" on Docker / Synology / Android. Deriving it here keeps
// this file byte-identical across channels (public/ is not processed by Next).
const BASE = (() => {
  try {
    return new URL(self.registration.scope).pathname.replace(/\/+$/, "");
  } catch (error) {
    return "";
  }
})();

const SHELL_CACHE = `${SW_VERSION}-shell`;
const SHELL_ASSETS = [
  `${BASE}/`,
  `${BASE}/overview`,
  `${BASE}/favicon.ico`,
  `${BASE}/apple-touch-icon.png`,
  `${BASE}/branding/mmh-logo-pageflip.png`,
  `${BASE}/branding/mmh-logo-pageflip.square.png`,
  `${BASE}/branding/mmh-logo-pageflip-192.png`,
  `${BASE}/branding/mmh-logo-pageflip-512.png`,
];

const isApiRequest = (url) => url.pathname.startsWith(`${BASE}/api/`);
const isNextAsset = (url) => url.pathname.startsWith(`${BASE}/_next/`);
const isStaticShellAsset = (url) =>
  SHELL_ASSETS.includes(url.pathname) ||
  url.pathname.startsWith(`${BASE}/branding/`);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

// `next dev` serves its manifests under /_next/static/development/; production
// builds never do (they live under /_next/static/<buildId>/). Probing it tells the
// worker which server it is talking to without baking the build mode into this
// file, so public/sw.js stays byte-identical across channels.
async function servedByDevServer() {
  try {
    // Keep activation fast: a hung probe must not hold the worker hostage.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${BASE}/_next/static/development/_buildManifest.js`, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;
    // Gateways and SPA fallbacks answer unknown paths with 200 + the app shell, so
    // status alone is not enough: require the actual dev manifest content. This is
    // what keeps the self-destruct from firing on a production deployment.
    const body = (await response.text()).trimStart();
    return body.startsWith("self.__BUILD_MANIFEST");
  } catch (error) {
    return false;
  }
}

async function dropShellCaches(keepCurrent) {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith("mmh-pwa-") && !(keepCurrent && key === SHELL_CACHE))
      .map((key) => caches.delete(key)),
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Self-destruct on a dev server. Dev never registers a worker, so one running
    // here was left behind by an earlier production build on the same origin. Its
    // fetch handler answers /_next/ cache-first, and dev chunk paths carry no
    // content hash, so it would keep serving pre-edit JS/CSS forever: the server
    // is fixed, the page is not -- and the app-side cleanup can never run, because
    // that cleanup ships in the very chunks being withheld. The worker script is
    // the one request the browser always revalidates, so the removal has to live
    // here. dropShellCaches() also throws away the poisoned entries.
    if (await servedByDevServer()) {
      await dropShellCaches(false);
      await self.registration.unregister();
      return;
    }

    await dropShellCaches(true);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || isApiRequest(url)) return;

  if (isNextAsset(url) || isStaticShellAsset(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    return cached || caches.match(`${BASE}/overview`) || Response.error();
  }
}
