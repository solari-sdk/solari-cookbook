/**
 * The demo's promise is precise: with the bugs on, exactly `free` and
 * `eu-consent-rejected` fail; with them off, nothing does. This pins that over
 * real HTTP (no browser) so a change to the site or the classes cannot quietly
 * turn the demo into "found something else" -- which the CLI treats as exit 1.
 */
import { describe, expect, it } from "vitest"
import { serve, type DemoSite } from "../demo-site/serve.js"
import { CLASSES } from "../src/classes.js"
import { judge } from "../src/check.js"

const testids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!)

async function render(site: DemoSite, cookies: { name: string; value: string }[]) {
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ")
  const res = await fetch(site.url, { headers: { cookie } })
  expect(res.status).toBe(200)
  return testids(await res.text())
}

async function failing(site: DemoSite) {
  const out: string[] = []
  for (const cls of CLASSES) if (judge(cls, await render(site, cls.cookies)).length) out.push(cls.name)
  return out
}

describe("demo site", () => {
  it("with the planted bugs, exactly anon, free and eu-consent-rejected fail", async () => {
    const site = await serve(0, { leakExportToFree: true, trackerBeforeConsent: true })
    try {
      expect(await failing(site)).toEqual(["anon", "free", "eu-consent-rejected"])
    } finally {
      await site.close()
    }
  })

  it("with the bugs fixed, every class passes", async () => {
    const site = await serve(0, { leakExportToFree: false, trackerBeforeConsent: false })
    try {
      expect(await failing(site)).toEqual([])
    } finally {
      await site.close()
    }
  })

  it("treats an unknown tier as anon and serves the tracker as a real script", async () => {
    const site = await serve(0, { leakExportToFree: false, trackerBeforeConsent: false })
    try {
      expect(await render(site, [{ name: "tier", value: "root" }])).toContain("signin")
      const t = await fetch(new URL("/t.js", site.url))
      expect(t.status).toBe(200)
      expect(t.headers.get("content-type")).toBe("application/javascript")
    } finally {
      await site.close()
    }
  })
})
