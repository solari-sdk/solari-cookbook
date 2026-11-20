/**
 * YouTube video insights — read a video's metadata, top comments and related videos, then compute engagement and keywords.
 *
 * The watch page ships its own metadata as `ytInitialPlayerResponse` (title,
 * channel, exact view count, full description, publish date), so that part is
 * read from the page's data instead of scraping text or expanding the "...more"
 * box. Likes, comments and related videos only exist in the rendered page, so
 * they come from the DOM; comments load lazily and need a scroll to appear.
 * Everything after that is arithmetic, no model needed.
 *
 *   npm start -- "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 */
import { Solari } from "@solarisdk/browser"

const URL_ARG = process.argv[2] ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

/** "1.2K" -> 1200, "3,401" -> 3401, "" -> 0 */
function parseNumber(s: string) {
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i)
  if (!m) return 0
  return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase() as "K" | "M" | "B"] ?? 1))
}

const STOP = new Set("the a an and or but of to in on for with is are was were be this that it its at by from as you your i my we our they he she so not just all have has had do did can will what when how who why if about more than out up get".split(" "))
function extractKeywords(texts: string[], n = 10) {
  const counts = new Map<string, number>()
  for (const w of texts.join(" ").toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []) if (!STOP.has(w) && !/^\d+$/.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, c]) => `${w} (${c})`)
}

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const browser = await solari.launch()
try {
  const page = await browser.newPage()
  await page.goto(URL_ARG, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.locator("video").first().waitFor({ state: "attached", timeout: 30_000 })
  await page.evaluate(() => document.querySelectorAll("video").forEach((v) => v.pause()))

  type PlayerResponse = {
    videoDetails?: { title: string; author: string; viewCount: string; lengthSeconds: string; shortDescription: string; keywords?: string[] }
    microformat?: { playerMicroformatRenderer?: { publishDate?: string; category?: string } }
  }
  // YouTube no longer exposes ytInitialPlayerResponse as a window global, so read it from the watch
  // page's own HTML. The global is still tried first in case it comes back.
  const meta = await page.evaluate(async (): Promise<PlayerResponse | undefined> => {
    const global = (window as unknown as { ytInitialPlayerResponse?: PlayerResponse }).ytInitialPlayerResponse
    if (global) return global
    const html = await (await fetch(location.href)).text()
    const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var|<\/script>)/s)
    return m ? JSON.parse(m[1]) : undefined
  })
  const d = meta?.videoDetails
  if (!d) throw new Error("no video metadata on the page (not a watch URL, or YouTube changed its page)")
  const likeLabel = (await page.locator("like-button-view-model button").first().getAttribute("aria-label", { timeout: 10_000 }).catch(() => null)) ?? ""

  // Comments render only once their section scrolls into view.
  await page.locator("#comments").scrollIntoViewIfNeeded()
  await page.locator("ytd-comment-thread-renderer").first().waitFor({ timeout: 20_000 }).catch(() => {})
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 3000)
    await page.waitForTimeout(1500)
  }
  const comments = await page.$$eval("ytd-comment-thread-renderer", (els) =>
    els.slice(0, 40).map((el) => ({
      author: (el.querySelector("#author-text") as HTMLElement | null)?.innerText.trim() ?? "",
      text: (el.querySelector("#content-text") as HTMLElement | null)?.innerText.trim() ?? "",
      likes: (el.querySelector("#vote-count-middle") as HTMLElement | null)?.innerText.trim() ?? "",
      when: (el.querySelector("#published-time-text") as HTMLElement | null)?.innerText.trim() ?? "",
    })),
  )
  const related = await page.$$eval("#secondary a[href*='/watch?v=']", (as) =>
    as.map((a) => ({ title: (a as HTMLElement).innerText.trim().split("\n")[0], url: (a as HTMLAnchorElement).href.split("&")[0] })).filter((r) => r.title.length > 3),
  )
  const relatedUnique = related.filter((r, i) => related.findIndex((x) => x.url === r.url) === i).slice(0, 10)

  const views = Number(d.viewCount)
  const likes = parseNumber(likeLabel.match(/[\d,.]+[KMB]?/i)?.[0] ?? "")
  const topComment = [...comments].sort((a, b) => parseNumber(b.likes) - parseNumber(a.likes))[0]
  const result = {
    title: d.title,
    channel: d.author,
    published: meta.microformat?.playerMicroformatRenderer?.publishDate ?? "",
    category: meta.microformat?.playerMicroformatRenderer?.category ?? "",
    durationSeconds: Number(d.lengthSeconds),
    views,
    likes,
    description: d.shortDescription,
    tags: d.keywords ?? [],
    comments,
    related: relatedUnique,
    insights: {
      likesPerThousandViews: views ? +((likes / views) * 1000).toFixed(2) : 0,
      commentsRead: comments.length,
      topComment: topComment ? `${topComment.author}: ${topComment.text.slice(0, 160)} (${topComment.likes || 0} likes)` : "",
      titleAndDescriptionKeywords: extractKeywords([d.title, d.shortDescription]),
      commentKeywords: extractKeywords(comments.map((c) => c.text)),
    },
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
