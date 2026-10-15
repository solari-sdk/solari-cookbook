"""
pipeline/browser_check.py — Step 3: check whether this is a known issue via
a real Solari Browser session.

Uses GitHub's public REST search API directly instead of scraping search
HTML (fragile CSS class guess, never confirmed against real markup).
Chrome renders raw JSON in a <pre> tag when navigating to a JSON endpoint —
parse that instead of guessing UI selectors.
"""

import json
import os
from dataclasses import dataclass, field
from urllib.parse import quote

USE_REAL_SOLARI = bool(os.environ.get("SOLARI_API_KEY"))

if USE_REAL_SOLARI:
    from solari_browser import Solari  # pip install solari-browser


@dataclass
class PriorArtResult:
    query_used: str
    known_issue: bool
    matches: list[str] = field(default_factory=list)


class FakeBrowserClient:
    def launch(self, **kwargs):
        print(f"[stub] would launch Solari browser with {kwargs}")
        return self

    def goto(self, url):
        print(f"[stub] would navigate to {url}")

    def get_results(self):
        return []

    def close(self):
        print("[stub] would close browser session")


async def check_prior_art(root_cause_summary: str) -> PriorArtResult:
    query = "stale event listener innerHTML replace submit button"

    if not USE_REAL_SOLARI:
        browser = FakeBrowserClient().launch()
        browser.goto("https://api.github.com/search/issues")
        matches = browser.get_results()
        browser.close()
        return PriorArtResult(query, len(matches) > 0, matches)

    api_url = f"https://api.github.com/search/issues?q={quote(query)}"
    matches: list[str] = []

    async with Solari(api_key=os.environ["SOLARI_API_KEY"]) as solari:
        async with await solari.launch() as browser:
            page = await browser.new_page()
            await page.goto(api_url, wait_until="networkidle")

            try:
                body_text = await page.locator("pre").inner_text()
            except Exception:
                body_text = await page.locator("body").inner_text()

            try:
                data = json.loads(body_text)
                matches = [item["title"] for item in data.get("items", [])[:5]]
            except (json.JSONDecodeError, KeyError) as e:
                print(f"[warn] couldn't parse GitHub API response as expected: {e}")
                print(f"[warn] raw body (first 300 chars): {body_text[:300]!r}")

    return PriorArtResult(
        query_used=query,
        known_issue=len(matches) > 0,
        matches=matches,
    )