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
  // 镜像里不装 sharp：它的预编译包同时带 glibc 与 musl 两套 libvips，单个
  // libvips-cpp.so 有 16.6 MB，压成镜像层仍有 7.4 MB，越过国内镜像站的安全
  // 单层（实测 8.75 MB 的 blob 会卡在 Download complete 不落盘），而镜像层数
  // 又已经顶着 overlay2 的上限，没有腾挪空间。项目里只有 logo 和赞助二维码
  // 用到 next/image，都是固定尺寸的小图、本来就 unoptimized，图片优化器对它们
  // 没有收益。关掉后镜像少 33 MB，sharp 整个依赖也不再需要。
  images: { unoptimized: true },
  // pdf-parse 是 ESM + CJS 双发布，内部还 require @napi-rs/canvas 的原生二进制。
  // 一旦被 webpack 打进 server chunk，加载时就会抛
  // "Object.defineProperty called on non-object"（2026-11-16 dev 实测），
  // 表现为邮件里的 PDF 附件一条文字都抽不出来。交给 Node 运行时 require。
  serverExternalPackages: ["pdf-parse"],
  // smb3-client is ESM-only and loaded through a native dynamic import in
  // src/lib/server/backup-target.ts (a plain import() is rewritten to require()
  // in CommonJS server chunks). Webpack cannot trace it, so copy the package
  // into the standalone output explicitly.
  outputFileTracingIncludes: {
    "/api/v1/settings/backup/auto": ["./node_modules/smb3-client/**/*"],
    // pdf-parse 被 serverExternalPackages 排除出打包后，只能靠 nft 把它和 pdfjs 的
    // worker 复制进 standalone；否则打包产物里 require("pdf-parse") 直接失败，
    // PDF 附件又会变成「抽不出文字」。两个用到它的路由都要列出来。
    // 注意：`@napi-rs/canvas` 复制进来只有 JS，平台二进制（canvas-linux-x64-gnu）
    // 是运行时动态 require 的，nft 追不到，而它解压后 31MB 会顶爆镜像单层预算——
    // 缺 DOMMatrix 由 src/lib/mail/pdf-canvas-shim.ts 在 JS 侧补齐，不要指望这里。
    "/api/v1/email/imap/fetch": [
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
    ],
    "/api/v1/statement/parse-pdf": [
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
    ],
  },
  // 左下角的 dev 浮标（圆形 N）会压在移动端弹窗底部按钮上，实测遮住「保存」文字。
  // 它只在 dev 出现，生产构建不受影响。
  devIndicators: false,
  // 允许并行跑第二个 dev 实例（例如「开发库 7777 + 生产库 7778」同时开着）。
  // 两个 next dev 若共用 .next，webpack 缓存与产物会互相覆盖，表现为随机
  // 编译错误或页面返回别的环境的数据。npm run dev:prod 会注入
  // NEXT_DIST_DIR=.next-prod，各用各的目录；默认仍是 .next，不影响构建与打包。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
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
