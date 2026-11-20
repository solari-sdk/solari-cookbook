"""Wikipedia MCP server — stdio MCP tools that search Wikipedia and return articles as JSON.

`search_wikipedia` runs the site's full-text search and returns title, snippet
and URL per hit. `get_article` opens an article and returns its title, lead
summary, body text and URL. Wikipedia's markup is stable enough that plain
selectors do the extraction, so no model is involved and the output is exactly
what the page says. Pydantic models define the JSON a client gets back.

stdout is the MCP channel, so this server logs to stderr only.
"""

import asyncio
import json
import os
import re
import sys
from typing import Any
from urllib.parse import quote, quote_plus

from mcp.server.mcpserver import MCPServer
from pydantic import BaseModel
from solari_browser import Solari

WIKI = "https://en.wikipedia.org"
MAX_CONTENT = 20_000
CITATION = re.compile(r"\[(\d+|[a-z]|citation needed|note \d+)\]")


def clean(paragraphs: list[str]) -> str:
    """Join paragraphs and drop the [1]-style citation markers."""
    return CITATION.sub("", "\n\n".join(paragraphs))


class SearchResult(BaseModel):
    title: str
    snippet: str
    url: str


class WikipediaArticle(BaseModel):
    title: str
    summary: str
    content: str
    url: str


solari = Solari(api_key=os.environ["SOLARI_API_KEY"])
server = MCPServer("wikipedia", instructions="Search Wikipedia and read articles as structured JSON.")


async def on_page(url: str, script: str) -> Any:
    """Open url in a fresh session, run one extraction script, release the session."""
    browser = await solari.launch()
    print(f"session {browser.id} -> {url}", file=sys.stderr)
    try:
        page = await browser.new_page()
        await page.goto(url, wait_until="domcontentloaded")
        return await page.evaluate(script)
    finally:
        await browser.close()


@server.tool()
async def search_wikipedia(query: str, limit: int = 5) -> str:
    """Search English Wikipedia and return matching articles as JSON (title, snippet, url).

    Args:
        query: Search terms.
        limit: Maximum number of results, 1 to 20.
    """
    url = f"{WIKI}/w/index.php?search={quote_plus(query)}&fulltext=1&ns0=1"
    hits: list[dict[str, str]] = await on_page(
        url,
        """() => [...document.querySelectorAll('.mw-search-result')].map(r => ({
              title: r.querySelector('.mw-search-result-heading a')?.textContent?.trim() ?? '',
              snippet: r.querySelector('.searchresult')?.textContent?.trim() ?? '',
              url: r.querySelector('.mw-search-result-heading a')?.href ?? '',
            })).filter(r => r.title)""",
    )
    results = [SearchResult(**h) for h in hits[: max(1, min(limit, 20))]]
    return json.dumps([r.model_dump() for r in results], ensure_ascii=False)


@server.tool()
async def get_article(title: str) -> str:
    """Fetch one Wikipedia article as JSON (title, summary, content, url).

    Args:
        title: Article title (e.g. "Ada Lovelace") or a full en.wikipedia.org URL.
    """
    url = title if title.startswith("http") else f"{WIKI}/wiki/{quote(title.replace(' ', '_'))}"
    data: dict[str, Any] = await on_page(
        url,
        """() => {
          const body = document.querySelector('#mw-content-text .mw-parser-output');
          const lead = [], all = [];
          let inLead = true;
          for (const el of body ? body.children : []) {
            // Section headings are h2 elements, wrapped in div.mw-heading on current skins.
            if (el.matches('h2, div.mw-heading2')) inLead = false;
            if (el.tagName === 'P' && el.textContent.trim()) {
              all.push(el.textContent.trim());
              if (inLead) lead.push(el.textContent.trim());
            }
          }
          return { title: document.querySelector('#firstHeading')?.textContent?.trim() ?? '',
                   lead, all, url: location.href };
        }""",
    )
    if not data["title"] or not data["all"]:
        return f"No article found at {url}. Try search_wikipedia first."

    article = WikipediaArticle(
        title=data["title"],
        summary=clean(data["lead"]),
        content=clean(data["all"])[:MAX_CONTENT],
        url=data["url"],
    )
    return article.model_dump_json()


async def main() -> None:
    try:
        await server.run_stdio_async()
    finally:
        await solari.close()


if __name__ == "__main__":
    asyncio.run(main())
