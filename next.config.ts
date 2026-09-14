import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

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

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    proxyClientMaxBodySize: "128mb",
  },
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
