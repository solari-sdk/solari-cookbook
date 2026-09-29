import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hides Next's bottom-left dev badge so it does not sit over the hero.
  devIndicators: false,
  // patchright-core lazily requires optional native/CJS deps that a bundler
  // cannot statically resolve. Keep the browser SDK out of the server bundle.
  serverExternalPackages: ["@solarisdk/browser", "patchright-core"],
};

export default nextConfig;
