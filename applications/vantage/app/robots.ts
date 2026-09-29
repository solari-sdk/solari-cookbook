import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/brand";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Run-scoped pages hold someone else's research and live in memory for an
      // hour; there is nothing for a crawler to index there.
      disallow: ["/api/", "/report/", "/replay/"],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
