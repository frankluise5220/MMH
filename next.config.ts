import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";
import { RESTORE_UPLOAD_LIMIT_CONFIG } from "./src/lib/backup-upload-limit";

function getLocalDevHostnames() {
  const hostnames = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== "IPv6") continue;
      hostnames.add(entry.address);
    }
  }
  return [...hostnames];
}

const allowedDevOrigins = [
  "localhost",
  "127.0.0.1",
  ...getLocalDevHostnames(),
  ...String(process.env.MMH_ALLOWED_DEV_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

// fnOS unified gateway: the gateway forwards /app/mmh/** to the app WITH the
// prefix intact, so the app has to serve its own routes under it. Only the fnOS
// package build sets MMH_BASE_PATH (see scripts/build-fnos-app.cjs); Docker,
// Synology and Android builds leave it empty and stay on the origin root.
// basePath is inlined at build time, so this cannot be changed at runtime.
const basePath = (process.env.MMH_BASE_PATH || "").trim().replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  ...(basePath ? { basePath } : {}),
  // Re-exported for the hand-written URLs Next cannot rewrite (fetch,
  // window.location, raw asset src, metadata.icons, PWA manifest body).
  env: { NEXT_PUBLIC_MMH_BASE_PATH: basePath },
  // Type-checking runs in the `next build` step and needs >2GB heap. The 149
  // fnOS build host has only ~3.3GB RAM shared with the fnOS VM and services,
  // so the check OOMs there. Type correctness is verified on the dev machine
  // with `tsc --noEmit` before shipping; the fnOS host sets
  // MMH_SKIP_BUILD_TYPE_CHECK=1 to skip the in-build check and only produce
  // binaries. Never set this in CI/dev where the check is expected to run.
  typescript: {
    ignoreBuildErrors: process.env.MMH_SKIP_BUILD_TYPE_CHECK === "1",
  },
  experimental: {
    proxyClientMaxBodySize: RESTORE_UPLOAD_LIMIT_CONFIG,
  },
  // DO NOT add `outputFileTracingExcludes` here (removed 2026-10-04, v0.1.69).
  // Next matches those globs via picomatch `{ contains: true }` (see
  // next/dist/build/collect-build-traces.js -> makeIgnoreFn), i.e. UNANCHORED:
  // a root-level pattern like "./data/**" also strips every nested `data/`
  // (e.g. node_modules/caniuse-lite/data/**), and "./output/**" strips Next's
  // own `next/dist/build/output/**`. The standalone server then dies at boot
  // with `Cannot find module '../build/output/log'` in EVERY SPK/FPK/Docker
  // image. Verified there is nothing to exclude anyway: nft never traces the
  // root `data/` or `.codex-logs/` dirs (no such entries in any *.nft.json, and
  // the shipped app.tgz carries no developer data). Guard packaging with a
  // build-time assertion in scripts/build-*-package.cjs instead.
  allowedDevOrigins,
  webpack(config, { dev }) {
    if (dev) {
      const existingIgnored = config.watchOptions?.ignored;
      const ignored = (Array.isArray(existingIgnored)
        ? existingIgnored
        : existingIgnored
          ? [existingIgnored]
          : []
      ).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          ...ignored,
          "**/node_modules/**",
          "**/.next/**",
          "**/.codex-logs/**",
          "**/.gradle-home/**",
          "**/.workbuddy-ai/**",
          "**/release-artifacts/**",
          "**/android/app/build/**",
          "**/.playwright-cli/**",
          "**/output/**",
          "**/tmp/**",
        ],
      };
    }

    return config;
  },
  async headers() {
    const headers = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];

    if (process.env.MMH_ENABLE_HSTS === "1") {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      });
    }

    return [
      {
        source: "/:path*",
        headers,
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
