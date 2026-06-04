import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.5.199", "192.168.2.199", "127.0.0.1"],
  async redirects() {
    return [
      {
        source: "/settings/fund-api",
        destination: "/settings/ai",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
