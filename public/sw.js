const SW_VERSION = "mmh-pwa-v1";
const SHELL_CACHE = `${SW_VERSION}-shell`;
const SHELL_ASSETS = [
  "/",
  "/overview",
  "/branding/mmh-logo-mark.svg",
  "/branding/mmh-logo-mark.preview.png",
];

const isApiRequest = (url) => url.pathname.startsWith("/api/");
const isNextAsset = (url) => url.pathname.startsWith("/_next/");
const isStaticShellAsset = (url) =>
  SHELL_ASSETS.includes(url.pathname) ||
  url.pathname.startsWith("/branding/");

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
    return cached || caches.match("/overview") || Response.error();
  }
}
