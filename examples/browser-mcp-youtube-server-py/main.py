"""YouTube MCP server — stdio MCP tools for a video's description and a channel's latest uploads.

`get_video_description` loads a watch page and reads the player data the page
was rendered from (title, channel, views, publish date and the full
description), so there's no "...more" button to click. `get_channel_videos`
opens a channel's Videos tab, scrolls until enough cards have rendered, and
reads title, link, views and age from each. Both run in a real browser
because the page builds itself with JavaScript; a plain HTTP fetch gets a
shell with none of this in the DOM.

stdout is the MCP channel, so this server logs to stderr only.
"""

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from mcp.server.mcpserver import MCPServer
from pydantic import BaseModel
from solari_browser import Solari


class Video(BaseModel):
    title: str
    link: str
    views: str
    published: str


solari = Solari(api_key=os.environ["SOLARI_API_KEY"])
server = MCPServer("youtube", instructions="Read YouTube video descriptions and channel upload lists.")

# Channel cards have two markups in circulation; each selector lists both.
CARDS_JS = """() => [...document.querySelectorAll('ytd-rich-item-renderer')].map(card => {
  const a = card.querySelector('a#video-title-link, a.yt-lockup-metadata-view-model__title');
  const meta = [...card.querySelectorAll('#metadata-line span, .yt-content-metadata-view-model__metadata-text')]
    .map(s => s.textContent.trim()).filter(t => t);
  return { title: a?.textContent?.trim() ?? '', link: a?.href ?? '', views: meta.at(-2) ?? '', published: meta.at(-1) ?? '' };
}).filter(v => v.title && v.link)"""


@asynccontextmanager
async def open_page(url: str) -> AsyncIterator[Any]:
    """Yield a page at url in a fresh session; close() also releases the session."""
    browser = await solari.launch()
    print(f"session {browser.id} -> {url}", file=sys.stderr)
    try:
        page = await browser.new_page()
        await page.goto(url, wait_until="domcontentloaded")
        yield page
    finally:
        await browser.close()


@server.tool()
async def get_video_description(url: str) -> str:
    """Return a YouTube video's title, channel, views, publish date and full description.

    Args:
        url: A youtube.com/watch?v=... or youtu.be/... link.
    """
    async with open_page(url) as page:
        info: dict[str, Any] | None = await page.evaluate(
            """() => {
              const r = window.ytInitialPlayerResponse;
              const d = r?.videoDetails;
              return d ? { title: d.title, channel: d.author, views: d.viewCount,
                           published: r.microformat?.playerMicroformatRenderer?.publishDate ?? '',
                           description: d.shortDescription } : null;
            }"""
        )
    if not info:
        return f"No video data found at {url}. Check that it is a public video link."
    return json.dumps(info, ensure_ascii=False)


@server.tool()
async def get_channel_videos(channel: str, limit: int = 10) -> str:
    """List a YouTube channel's most recent uploads as JSON (title, link, views, published).

    Args:
        channel: A channel handle like "@NASA" or a channel URL.
        limit: How many videos to return, 1 to 50.
    """
    base = channel if channel.startswith("http") else f"https://www.youtube.com/{channel if channel.startswith('@') else '@' + channel}"
    limit = max(1, min(limit, 50))
    async with open_page(base.rstrip("/").removesuffix("/videos") + "/videos") as page:
        await page.wait_for_selector("ytd-rich-item-renderer", timeout=20_000)
        cards: list[dict[str, str]] = await page.evaluate(CARDS_JS)
        # The grid renders about 30 cards, then more as you scroll.
        for _ in range(5):
            if len(cards) >= limit:
                break
            await page.mouse.wheel(0, 4000)
            await page.wait_for_timeout(1500)
            cards = await page.evaluate(CARDS_JS)
    videos = [Video(**c) for c in cards[:limit]]
    return json.dumps([v.model_dump() for v in videos], ensure_ascii=False)


async def main() -> None:
    try:
        await server.run_stdio_async()
    finally:
        await solari.close()


if __name__ == "__main__":
    asyncio.run(main())
