import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "patchright-core", "@solarisdk/browser", "@solarisdk/sdk"],
}

export default nextConfig
