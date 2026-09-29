"""Thin async wrappers around two of the three Solari clients (browser and
sandbox — the desktop product is unused; see qa-agent/README.md for why).

Call patterns here are copied from the cookbook's own examples
(browser-quickstart-py, sandbox-code-interpreter-py) to avoid guessing at
lifecycle rules the README explicitly warns about: browser.close() releases
the session, sandbox needs kill() not close().
"""

from __future__ import annotations

import asyncio

from solari_browser import Solari
from solari_sandbox import SandboxClient

BASE_URL = "https://api.getsolari.com"


class SolariToolkit:
    def __init__(self, api_key: str):
        self.api_key = api_key

        self._solari = Solari(api_key=api_key)
        self._browser = None
        self._page = None

        self._sandbox_client: SandboxClient | None = None
        self._sandbox = None
        self._code_ctx = None

    # ---------------------------------------------------------- browser --
    # Playwright/patchright calls raise on things a real page throws at an
    # agent constantly - ambiguous selectors, timeouts, detached elements.
    # These are tool calls the model reacts to, so failures are reported
    # back as text (same shape sandbox_exec already uses) instead of
    # crashing the whole run - the model can retry with a better selector.
    async def browser_open(self, url: str) -> str:
        try:
            if self._browser is None:
                # recording=True so we have an rrweb replay as extra evidence
                # alongside whatever the agent captures manually.
                self._browser = await self._solari.launch(recording=True)
                self._page = await self._browser.new_page()
            await self._page.goto(url)
            title = await self._page.title()
            body_text = await self._page.locator("body").inner_text()
            return f"title: {title}\nsession: {self._browser.id}\n\n{body_text[:4000]}"
        except Exception as e:
            return f"ERROR: {e}"

    async def browser_fill(self, selector: str, text: str) -> str:
        try:
            await self._page.locator(selector).fill(text)
            return f"filled {selector!r}"
        except Exception as e:
            return f"ERROR: {e}"

    async def browser_click(self, selector: str) -> str:
        try:
            await self._page.locator(selector).click()
            await asyncio.sleep(1)
            body_text = await self._page.locator("body").inner_text()
            return body_text[:4000]
        except Exception as e:
            return f"ERROR: {e}"

    async def browser_session_id(self) -> str | None:
        return self._browser.id if self._browser else None

    # ---------------------------------------------------------- sandbox --
    async def _ensure_sandbox(self) -> None:
        if self._sandbox is not None:
            return
        self._sandbox_client = SandboxClient(api_key=self.api_key, base_url=BASE_URL)
        await self._sandbox_client.__aenter__()
        self._sandbox = await self._sandbox_client.create(
            template="base", timeout_ms=5 * 60_000
        )
        await self._sandbox.connect()
        # Reused across calls so imports/variables persist between the
        # agent's exploration steps, same as the code-interpreter example.
        self._code_ctx = await self._sandbox.create_code_context("python")

    async def sandbox_exec(self, code: str) -> str:
        await self._ensure_sandbox()
        result = await self._sandbox.run_code(code, context_id=self._code_ctx)
        if result.error:
            return f"ERROR: {result.error}"
        out = []
        for item in result.results:
            label = getattr(item, "type", "result")
            text = getattr(item, "text", None)
            if text:
                out.append(f"[{label}] {text}")
        return "\n".join(out) or "(no output)"

    # --------------------------------------------------------- teardown --
    async def close(self) -> None:
        if self._browser:
            await self._browser.close()
        if self._sandbox:
            await self._sandbox.kill()
        if self._sandbox_client:
            await self._sandbox_client.__aexit__(None, None, None)
