/**
 * TikTok video download — open a trending video from TikTok Explore, read its source URL, and save the file locally.
 *
 * The video element's source is a signed CDN link that only plays for the
 * browser that was handed it: it checks that browser's cookies, and a request
 * from your laptop's IP with no cookies tends to get a 403. So the download runs
 * inside the page with `fetch`, and the bytes come back to Node as base64. Only
 * save videos you have the right to keep.
 *
 *   npm start                                               # first video on Explore
 *   npm start -- https://www.tiktok.com/@user/video/123...  # a specific video
 */
import { mkdir, writeFile } from "node:fs/promises"
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

// TikTok shows a bot wall to plain datacenter browsers, so this needs stealth (paid plan).
const browser = await solari.launch({ stealth: true })
try {
  const page = await browser.newPage()
  let url = process.argv[2]
  if (!url) {
    await page.goto("https://www.tiktok.com/explore", { waitUntil: "domcontentloaded", timeout: 45_000 })
    const first = page.locator('a[href*="/video/"]').first()
    await first.waitFor({ timeout: 30_000 })
    url = (await first.getAttribute("href"))!
    url = new URL(url, "https://www.tiktok.com").href
  }
  console.log(`video: ${url}`)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })

  const video = page.locator("video").first()
  await video.waitFor({ state: "attached", timeout: 30_000 })
  // Pause so the player stops pulling segments while we fetch the whole file.
  let src = await video.evaluate((v) => {
    const el = v as HTMLVideoElement
    el.pause()
    return el.currentSrc || el.querySelector("source")?.src || ""
  })
  // TikTok now plays through a blob: (media source) URL, which cannot be fetched. The page's own
  // hydration data still carries the signed CDN link, so read it from there.
  if (!src || src.startsWith("blob:")) {
    src = await page.evaluate(() => {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")
      const data = el?.textContent ? JSON.parse(el.textContent) : undefined
      const v = data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct?.video
      return v?.playAddr || v?.downloadAddr || ""
    })
  }
  if (!src || src.startsWith("blob:")) throw new Error(`no direct source URL for the video (got "${src.slice(0, 40)}")`)

  const b64 = await page.evaluate(async (s) => {
    const res = await fetch(s, { credentials: "include" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }, src)

  const id = url.match(/\/video\/(\d+)/)?.[1] ?? String(Date.now())
  await mkdir("downloads", { recursive: true })
  const file = `downloads/${id}.mp4`
  const data = Buffer.from(b64, "base64")
  await writeFile(file, data)
  console.log(`saved ${file} (${(data.length / 1e6).toFixed(1)} MB)`)
} finally {
  await browser.close()
}
