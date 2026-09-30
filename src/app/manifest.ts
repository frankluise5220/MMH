import type { MetadataRoute } from "next";
import { withBasePath } from "@/lib/base-path";

// Next.js prefixes the <link rel="manifest"> href for basePath, but NOT the URLs
// inside the manifest body (verified on a probe build: the body still returned
// id "/" and start_url "/overview" under basePath "/app/mmh"). Every URL here
// has to be prefixed by hand, or the fnOS PWA installs pointing at the fnOS
// origin root instead of the app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: withBasePath("/"),
    name: "MoneyMoneyHome",
    short_name: "MMH",
    description: "Local-first family finance system",
    lang: "zh-CN",
    start_url: withBasePath("/overview"),
    scope: withBasePath("/"),
    display: "standalone",
    display_override: ["standalone", "fullscreen", "minimal-ui"],
    background_color: "#f4f7fb",
    theme_color: "#f4f7fb",
    orientation: "portrait",
    categories: ["finance", "productivity"],
    icons: [
      {
        src: withBasePath("/branding/mmh-logo-pwa-192.png"),
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: withBasePath("/branding/mmh-logo-pwa-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: withBasePath("/branding/mmh-logo-pwa-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "概览",
        short_name: "概览",
        url: withBasePath("/overview"),
        icons: [
          {
            src: withBasePath("/branding/mmh-logo-pwa-192.png"),
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "记一笔",
        short_name: "记一笔",
        url: withBasePath("/?quickEntry=1"),
        icons: [
          {
            src: withBasePath("/branding/mmh-logo-pwa-192.png"),
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
  };
}
