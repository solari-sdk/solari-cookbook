import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "@solarisdk/browser",
    "@solarisdk/sandbox",
    "patchright-core",
    "@resvg/resvg-js",
  ],
};

export default nextConfig;
