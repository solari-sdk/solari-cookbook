"""Browser on the desktop: detect, launch, maximise, navigate with typed-URL verification + fallback.

No DOM, no Playwright. The browser is just another window the agent looks at. That is deliberate:
it is the capability under test.

Failure modes this file absorbs (all observed on the 'default' template, SDK 0.2.0):
- desktop.open(binary, [url]) drops the URL argument -> about:blank. So launch() only makes a window.
- The window opens small and floating; we maximise it so the brain sees the whole page.
- A typed URL can arrive corrupted in the omnibox; Chrome then Google-searches the garbage and
  Google captchas the datacenter IP. So we read back the omnibox via clipboard BEFORE pressing Enter.
- Chrome's inline autocomplete rewrites what you typed (adds a trailing '/', may change case), so the
  read-back is compared normalised, not byte-for-byte.
- If typing is unreliable twice, fall back to exec(binary, [url]). Observed: on this template the
  fallback is silent (no DISPLAY for exec'd GUI processes) - kept as a last resort, not relied upon.
- Chrome shows a permanent 'unsupported flag --no-sandbox' infobar. Harmless; the brain is told so.
- Chrome renderer crashes ('Aw, Snap!' code 5) under memory pressure; navigate()'s retry reloads.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import quote_plus

from .actuator import Actuator
from .brain import Brain
from .perception import Observation
from .session import log

CANDIDATES = ["google-chrome", "chromium", "chromium-browser", "firefox", "firefox-esr"]


def _launch_args(binary: str, w: int, h: int) -> list[str]:
    """Best-effort sizing flags. The launcher may drop them (it drops URLs); harmless if so."""
    if binary.startswith("firefox"):
        return ["-width", str(w), "-height", str(h)]
    return [f"--window-size={w},{h}", "--window-position=0,0", "--no-first-run", "--no-default-browser-check"]


def ddg_url(query: str) -> str:
    """DuckDuckGo search. Chosen over Google because it does not captcha datacenter IPs on the
    first request; that is an anti-bot failure mode we sidestep rather than fight.
    quote_plus: quotes and spaces must be encoded or Chrome rewrites the URL and our read-back fails."""
    return "https://duckduckgo.com/?q=" + quote_plus(query)


def _norm(u: str) -> str:
    u = u.strip().lower().rstrip("/")
    for prefix in ("https://", "http://"):
        if u.startswith(prefix):
            u = u[len(prefix):]
    return u[4:] if u.startswith("www.") else u


def url_matches(typed: str, shown: str) -> bool:
    """True if what the omnibox shows is the URL we typed, modulo Chrome's cosmetic rewrites."""
    a, b = _norm(typed), _norm(shown)
    return bool(a) and (a == b or b.startswith(a + "/") or b.startswith(a + "?"))


async def detect_browser(desktop) -> str:
    r = await desktop.exec("which", args=CANDIDATES)
    found = [line.strip().rsplit("/", 1)[-1] for line in r.stdout.splitlines() if line.strip()]
    if not found:
        raise RuntimeError(f"no browser in VM; tried {CANDIDATES}. stderr={r.stderr!r}")
    log(f"browsers in VM: {found} -> using {found[0]}")
    return found[0]


@dataclass
class Browser:
    desktop: object
    act: Actuator
    brain: Brain
    binary: str = ""

    async def launch(self, url: str) -> Observation:
        self.binary = await detect_browser(self.desktop)
        pid = await self.desktop.open(self.binary, _launch_args(self.binary, self.act.width, self.act.height))
        log(f"launched {self.binary} pid={pid}")
        await asyncio.sleep(3.0)  # cold start; settle detection alone can mis-fire on the splash frame
        await self.act.wait_settled(timeout_s=20)
        await self.act.maximize_active()
        return await self.navigate(url)

    async def current_url(self) -> str:
        """Read the omnibox via clipboard. Model-free ground truth for 'where are we'."""
        await self.act.key("ctrl+l")
        await asyncio.sleep(0.4)
        url = (await self.act.read_focused_text()).strip()
        await self.act.key("Escape")
        await asyncio.sleep(0.2)
        return url

    async def _type_url_verified(self, url: str, tries: int = 2) -> bool:
        """Focus omnibox, type, read back via clipboard. True iff the omnibox holds our URL."""
        for t in range(tries):
            await self.act.key("ctrl+l")
            await asyncio.sleep(0.6)  # focus must land before the first keystroke
            await self.act.type(url)
            await asyncio.sleep(0.4)
            got = (await self.act.read_focused_text()).strip()
            if url_matches(url, got):
                return True
            log(f"omnibox mismatch (try {t + 1}): wanted {url!r} got {got!r}")
            await self.act.key("Escape")
            await asyncio.sleep(0.3)
        return False

    async def _open_via_exec(self, url: str) -> None:
        """Last resort: hand the URL to the running browser process over IPC."""
        log(f"fallback: exec {self.binary} {url}")
        try:
            await self.desktop.exec(self.binary, args=[url], timeout_ms=8000)
        except Exception as e:  # noqa: BLE001 - the launcher may outlive the timeout; the tab may still open
            log(f"exec returned {type(e).__name__}: {e} (continuing; checking screen)")

    async def navigate(self, url: str, *, attempts: int = 3) -> Observation:
        for i in range(attempts):
            if await self._type_url_verified(url):
                await self.act.key("Return")
            else:
                await self._open_via_exec(url)
            obs = await self.act.wait_settled(timeout_s=20)
            ok, evidence = await self.brain.judge(
                obs,
                f"Two conditions must BOTH hold. (1) The browser address bar shows {url} or an obvious redirect "
                f"of it (same site). (2) That page is loaded and readable: not blank, not a browser error page, "
                "not still loading, not a captcha wall. Cookie banners, popups, or a browser infobar about an "
                "unsupported command-line flag still count as loaded. If the address bar shows a different page "
                "or a previous search, answer false.",
            )
            log(f"navigate {url}: loaded={ok} | {evidence}")
            if ok:
                return obs
            await asyncio.sleep(2.0 * (i + 1))
        raise RuntimeError(f"navigate({url}) failed after {attempts} attempts")