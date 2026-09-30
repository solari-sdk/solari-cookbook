import { Solari } from "@solarisdk/browser";
import { chromium, type Page } from "playwright";

export async function openBrowser(headers: Record<string, string>) {
  const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
  const session = await solari.sessions.create();
  const release = () => solari.sessions.releaseAndWait(session.id);
  const browser = await chromium.connectOverCDP(session.cdpEndpoint).catch(async (e) => {
    await release();
    throw e;
  });
  const page = await (await browser.newContext({ extraHTTPHeaders: headers })).newPage();
  return {
    page,
    navigate: (url: string) => page.goto(url, { waitUntil: "domcontentloaded" }),
    // mode "ai" is what adds the [ref=eN] handles that ref2loc resolves.
    tree: () => page.locator("body").ariaSnapshot({ mode: "ai" }),
    click: (ref: string) => ref2loc(page, ref).click(),
    center: async (ref: string) => {
      const b = await ref2loc(page, ref).boundingBox();
      return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    },
    screenshot: () => page.screenshot(),
    rasterize: async (svg: string, width: number, height: number) => {
      const p = await page.context().newPage();
      await p.setViewportSize({ width, height });
      await p.setContent(`<body style="margin:0">${svg}</body>`);
      const png = await p.screenshot({ omitBackground: true });
      await p.close();
      return png;
    },
    close: async () => {
      try {
        await browser.close();
      } finally {
        await release(); // even if close throws, or the session bills until it times out
      }
    },
  };
}

const ref2loc = (page: Page, ref: string) =>
  page.locator(`aria-ref=${ref.replace(/^\[?ref=|\]$/g, "")}`);
