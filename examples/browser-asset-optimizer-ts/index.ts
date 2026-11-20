/**
 * Asset optimizer — capture a page's images and web fonts in a cloud browser, recompress them, and report the savings.
 *
 * The assets come from the browser's own network traffic, not from parsing
 * HTML, so you get what the page really loads: srcset picks, CSS background
 * images, lazy images (the page is scrolled to trigger them) and fonts pulled
 * in by stylesheets. Each response body is read straight from the browser.
 *
 * Images become AVIF at quality 50 with sharp. Fonts are subset to the
 * characters the page actually displays and saved as WOFF2, which is usually
 * where the biggest savings hide. If an optimized file comes out larger, the
 * original is kept and the report says so.
 *
 *   npm start -- https://www.scrapingcourse.com/ecommerce/
 */
import { Solari } from "@solarisdk/browser"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import sharp from "sharp"
import subsetFont from "subset-font"

const TARGET = process.argv[2] ?? "https://www.scrapingcourse.com/ecommerce/"
const OUT = join("optimized", new URL(TARGET).hostname)

type Asset = { url: string; kind: "image" | "font"; type: string; body: Buffer }
const assets = new Map<string, Asset>()
let pageText = ""

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const browser = await solari.launch()
try {
  const page = await browser.newPage()
  const pending: Promise<void>[] = []
  page.on("response", (res) => {
    const kind = res.request().resourceType()
    const type = res.headers()["content-type"] ?? ""
    if ((kind !== "image" && kind !== "font") || !res.ok() || type.includes("svg") || assets.has(res.url())) return
    // Read the body right away: it can be evicted from the browser's cache once the page moves on.
    pending.push(
      res.body().then(
        (body) => void assets.set(res.url(), { url: res.url(), kind, type, body }),
        () => {},
      ),
    )
  })
  await page.goto(TARGET, { waitUntil: "load" })
  // Scroll in steps so lazy-loaded images below the fold are requested too.
  for (let y = 0; y < (await page.evaluate(() => document.body.scrollHeight)) && y < 20_000; y += 800) {
    await page.mouse.wheel(0, 800)
    await page.waitForTimeout(250)
  }
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
  await Promise.all(pending)
  pageText = await page.evaluate(() => document.body.innerText)
} finally {
  await browser.close()
}

// Every character the page shows, plus ASCII so headings added later still render, plus the Private
// Use Area: icon fonts draw their glyphs from CSS ::before content, which never appears in innerText,
// so without it subsetting would strip every icon and leave an empty font.
const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("")
const privateUse = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, i) => String.fromCharCode(0xe000 + i)).join("")
const glyphs = [...new Set(pageText + ascii + privateUse)].join("")

await mkdir(join(OUT, "images"), { recursive: true })
await mkdir(join(OUT, "fonts"), { recursive: true })
const report = []
let n = 0
for (const a of assets.values()) {
  const stem = `${String(++n).padStart(3, "0")}-${basename(new URL(a.url).pathname, extname(new URL(a.url).pathname)).replace(/[^\w.-]/g, "_").slice(0, 60) || "asset"}`
  let optimized: Buffer
  let ext: string
  try {
    if (a.kind === "image") {
      optimized = await sharp(a.body).avif({ quality: 50 }).toBuffer()
      ext = ".avif"
    } else {
      optimized = await subsetFont(a.body, glyphs, { targetFormat: "woff2" })
      ext = ".woff2"
    }
  } catch (err) {
    report.push({ url: a.url, kind: a.kind, originalBytes: a.body.length, error: String(err).split("\n")[0] })
    continue
  }
  const kept = optimized.length < a.body.length ? "optimized" : "original"
  const file = join(OUT, `${a.kind}s`, stem + (kept === "optimized" ? ext : extname(new URL(a.url).pathname) || ".bin"))
  await writeFile(file, kept === "optimized" ? optimized : a.body)
  const bytes = Math.min(optimized.length, a.body.length)
  report.push({ url: a.url, kind: a.kind, file, kept, originalBytes: a.body.length, bytes, savedPct: Math.round((1 - bytes / a.body.length) * 100) })
  console.log(`${a.kind.padEnd(5)} ${(a.body.length / 1024).toFixed(0).padStart(6)} KB -> ${(bytes / 1024).toFixed(0).padStart(6)} KB  ${kept.padEnd(9)} ${a.url.slice(0, 90)}`)
}

const before = report.reduce((s, r) => s + r.originalBytes, 0)
const after = report.reduce((s, r) => s + ("bytes" in r ? (r.bytes ?? 0) : r.originalBytes), 0)
await writeFile(join(OUT, "report.json"), JSON.stringify({ page: TARGET, before, after, assets: report }, null, 2))
console.log(`\n${report.length} assets: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB (${Math.round((1 - after / Math.max(before, 1)) * 100)}% smaller)`)
console.log(`files and report.json in ${OUT}/`)
