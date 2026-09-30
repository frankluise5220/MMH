const SW_VERSION = "mmh-pwa-v9";

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

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("mmh-pwa-") && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
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
