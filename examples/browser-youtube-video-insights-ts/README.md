# YouTube video insights (TypeScript)

Open a YouTube video, pause it, and print JSON with its title, channel, publish date, category, duration, exact views, likes, full description, tags, up to 40 top comments (author, text, likes, when), up to 10 related videos, and computed insights: likes per thousand views, the most-liked comment, and the top keywords in the title and description and in the comments.

The watch page ships its own metadata as `ytInitialPlayerResponse`, so title, channel, exact view count, full description and publish date are read from that object. There's no need to scrape text or click the "...more" box. Likes, comments and related videos exist only in the rendered page, so they come from the DOM. Comments load lazily, so the script scrolls to the comments section first. The insights are plain arithmetic (`parseNumber` for counts like "1.2K", a stop-word filter for keywords), so no model is involved.

## Run

```bash
cd examples/browser-youtube-video-insights-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

Source: [`index.ts`](index.ts)
