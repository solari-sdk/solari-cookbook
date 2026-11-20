"""Ordinary async Playwright tests. Only the `page` fixture knows about Solari."""

from typing import Any

# The SDK drives the browser with patchright, a Playwright fork with the same
# API. Its `expect` has to match the page's classes, so import it from there,
# not from `playwright`.
from patchright.async_api import expect


async def test_reads_a_page(page: Any) -> None:
    await page.goto("https://example.com")
    await expect(page).to_have_title("Example Domain")


async def test_search_returns_a_result(page: Any) -> None:
    await page.goto("https://en.wikipedia.org/wiki/Special:Search")
    await page.locator("input[name='search']").first.fill("Playwright")
    await page.keyboard.press("Enter")
    await expect(page.locator("h1#firstHeading")).to_contain_text("Playwright")
