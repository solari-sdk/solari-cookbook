# TikTok video download (TypeScript)

Open the first trending video on TikTok Explore (or a video URL you pass), pause it, read the video element's source URL, and save the file to `downloads/<video-id>.mp4`.

The download runs inside the page, not in Node. The source is a signed CDN link tied to the browser that received it: it checks that browser's cookies, and a request from your machine with no cookies usually gets a 403. So the page `fetch`es the file with its own credentials and returns the bytes to Node as base64, and Node writes them to disk. If the player is streaming from a `blob:` URL, there is no direct file to fetch, and the script says so instead of saving a broken file.

TikTok shows a bot wall to plain datacenter browsers, so the session uses `stealth: true` (paid plan). Only download videos you have the right to keep.

## Run

```bash
cd examples/browser-tiktok-video-download-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
npm start -- https://www.tiktok.com/@user/video/1234567890
```

Source: [`index.ts`](index.ts)
