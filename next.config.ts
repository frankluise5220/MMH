import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.5.199", "192.168.2.199", "127.0.0.1", "tempsmmh.floatingice.win"],
};

export default nextConfig;
