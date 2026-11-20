# Asset optimizer (TypeScript)

Capture the images and web fonts a page loads, recompress them, and see how much smaller they could be. A Solari cloud browser opens the page and scrolls it in steps so lazy images are requested too, and every image and font response body is read straight from the browser's network traffic. That catches what HTML parsing misses: the `srcset` candidate the browser picked, CSS background images, and fonts pulled in by stylesheets.

Images are converted to AVIF at quality 50 with `sharp`. Fonts are subset with `subset-font` to the characters the page actually shows (plus printable ASCII and the Private Use Area, so icon fonts keep their icons) and saved as WOFF2, which is often the biggest win. If an optimized file is larger than the original, the original is kept. SVGs are skipped because they're already vector, and video isn't handled. Files go to `optimized/<host>/images` and `optimized/<host>/fonts`, with a `report.json` giving bytes before and after for every asset. Nothing is uploaded anywhere: the optimizing runs locally on bytes the browser downloaded.

## Run

```bash
cd examples/browser-asset-optimizer-ts
npm install                          # @solarisdk/browser, sharp, subset-font
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- https://www.scrapingcourse.com/ecommerce/
```

Source: [`index.ts`](index.ts)
