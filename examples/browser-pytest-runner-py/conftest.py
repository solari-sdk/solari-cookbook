"""Pytest fixtures that run your browser tests on a Solari cloud browser.

`browser` is session-scoped: one Solari session serves the whole run, and it
is released when pytest finishes, even if tests fail. `page` gives each test
its own tab in that session and closes it afterwards. No Chromium is
installed or launched on this machine.

Each pytest-xdist worker is its own process with its own session scope, so
`pytest -n 4` opens four sessions, one per worker. Keep that under your
plan's concurrency limit.
"""

import os
from collections.abc import AsyncIterator
from typing import Any

import pytest_asyncio
from solari_browser import BrowserSession, Solari


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def browser() -> AsyncIterator[BrowserSession]:
    async with Solari(api_key=os.environ["SOLARI_API_KEY"]) as solari:
        session = await solari.launch()
        try:
            yield session
        finally:
            # close() also releases the session; skipping it would hold the
            # slot until the idle timeout.
            await session.close()


@pytest_asyncio.fixture(loop_scope="session")
async def page(browser: BrowserSession) -> AsyncIterator[Any]:
    # new_page() opens a tab in the session's primary context, so tests share
    # cookies and storage. Use browser.new_context() if a test needs isolation.
    tab = await browser.new_page()
    try:
        yield tab
    finally:
        await tab.close()
