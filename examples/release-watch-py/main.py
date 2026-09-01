"""Release Watch — a real launch packet from browser + sandbox + desktop.

Use case: you are about to ship (or compete with) a public page. You need
three artifacts in one run:

  1. Cloud browser  — what a real Chrome session sees (DOM, links, PNG).
  2. Sandbox        — isolated Python that scores the extract (no local deps).
  3. Desktop        — GUI proof: open the URL in the VM's Chrome, screenshot.

One ``SOLARI_API_KEY`` covers all three. Pass ``--skip-desktop`` if you only
want the headless path.

Gotchas encoded here (same ones the rest of this cookbook hits):

- Sandbox ``commands.run`` is argv, not a shell. Use ``sh -c`` for pipes.
- ``sandbox.kill()`` ends the VM; ``close()`` only drops the control channel.
- Desktop ``close()`` is local; ``client.destroy(session_id)`` ends the GUI.
- Click the *window*, not the screen centre, before you trust a GUI screenshot.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sys
from dataclasses import asdict, dataclass

from solari_browser import Solari
from solari_desktop import DesktopClient
from solari_sandbox import SandboxClient

API_BASE = "https://api.getsolari.com"

# Runs in the sandbox kernel. `page` is injected by the caller as JSON.
KERNEL_ANALYZE = r'''
import json, math, re
from collections import Counter
from urllib.parse import urlparse

text = page.get("text") or ""
words = re.findall(r"[A-Za-z0-9']+", text)
links = page.get("links") or []
hosts = [urlparse(h).netloc.lower() for h in links if urlparse(h).netloc]
minutes = max(1, math.ceil(len(words) / 220)) if words else 1
top_hosts = Counter(hosts).most_common(8)
brief = {
    "title": page.get("title"),
    "h1": page.get("h1"),
    "url": page.get("url"),
    "word_count": len(words),
    "reading_minutes": minutes,
    "link_count": len(links),
    "unique_hosts": len(set(hosts)),
    "top_hosts": top_hosts,
    "has_cta": bool(re.search(r"\b(get started|sign up|start|launch|quickstart)\b", text, re.I)),
    "browser_session": page.get("browser_session"),
}
lines = [
    f"# Release watch: {brief['title'] or '(untitled)'}",
    "",
    f"- URL: {brief['url']}",
    f"- H1: {brief['h1'] or '(none)'}",
    f"- Copy: {brief['word_count']} words (~{brief['reading_minutes']} min read)",
    f"- Links: {brief['link_count']} across {brief['unique_hosts']} hosts",
    f"- CTA-ish copy: {'yes' if brief['has_cta'] else 'no'}",
    "",
    "## Top outbound hosts",
]
if top_hosts:
    lines.extend(f"- {h} ({n})" for h, n in top_hosts)
else:
    lines.append("- (none extracted)")
lines += [
    "",
    "## Browser session",
    f"- id: {brief['browser_session']}",
    "",
    "Generated inside a Solari sandbox kernel from a stealth-browser extract.",
]
MARKDOWN = "\n".join(lines) + "\n"
JSON_OUT = json.dumps(brief)
print("___MD___")
print(MARKDOWN)
print("___JSON___")
print(JSON_OUT)
'''


@dataclass
class PageExtract:
    url: str
    title: str
    h1: str
    text: str
    links: list[str]
    browser_session: str


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build a Solari release-watch packet")
    p.add_argument(
        "url",
        nargs="?",
        default="https://docs.getsolari.com",
        help="Public page to inspect (default: Solari docs)",
    )
    p.add_argument(
        "--out",
        default="out",
        help="Directory for screenshots and the markdown brief",
    )
    p.add_argument(
        "--skip-desktop",
        action="store_true",
        help="Skip the Linux GUI proof (browser + sandbox only)",
    )
    p.add_argument(
        "--no-stealth",
        action="store_true",
        help="Disable stealth mode on the cloud browser",
    )
    return p.parse_args()


async def capture_page(url: str, stealth: bool) -> tuple[PageExtract, bytes]:
    solari = Solari(api_key=os.environ["SOLARI_API_KEY"])
    browser = await solari.launch(stealth=stealth)
    try:
        page = await browser.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1500)

        title = await page.title()
        h1 = ""
        if await page.locator("h1").count():
            h1 = (await page.locator("h1").first.inner_text()).strip()

        text = await page.evaluate(
            """() => {
              const root = document.querySelector('main, article, body');
              return (root && root.innerText || '').slice(0, 20000);
            }"""
        )
        links = await page.evaluate(
            """() => [...document.querySelectorAll('a[href]')]
                .map(a => a.href)
                .filter(h => h.startsWith('http'))
                .slice(0, 40)"""
        )
        png = await page.screenshot(full_page=False, type="png")
        extract = PageExtract(
            url=page.url,
            title=title,
            h1=h1,
            text=text or "",
            links=list(dict.fromkeys(links or [])),
            browser_session=str(browser.id),
        )
        return extract, png
    finally:
        await browser.close()


def _kernel_text(result) -> str:
    chunks: list[str] = []
    if getattr(result, "error", None):
        raise RuntimeError(f"sandbox kernel error: {result.error}")
    for item in result.results:
        text = getattr(item, "text", None)
        if text:
            chunks.append(text)
    return "\n".join(chunks)


async def analyze_in_sandbox(extract: PageExtract, out_dir: pathlib.Path) -> str:
    payload = json.dumps(asdict(extract))
    async with SandboxClient(
        api_key=os.environ["SOLARI_API_KEY"],
        base_url=API_BASE,
    ) as client:
        sandbox = await client.create(template="base", timeout_ms=5 * 60_000)
        print("sandbox:", sandbox.sandboxId)
        try:
            await sandbox.connect()
            ctx = await sandbox.create_code_context("python")
            boot = await sandbox.run_code(
                "import json\npage = json.loads(" + json.dumps(payload) + ")\n'loaded'",
                context_id=ctx,
            )
            print("kernel:", _kernel_text(boot).strip() or "ok")
            result = await sandbox.run_code(KERNEL_ANALYZE, context_id=ctx)
            raw = _kernel_text(result)
            if "___MD___" not in raw or "___JSON___" not in raw:
                raise RuntimeError(f"unexpected kernel output:\n{raw}")
            md = raw.split("___MD___", 1)[1].split("___JSON___", 1)[0].strip() + "\n"
            stats = raw.split("___JSON___", 1)[1].strip()
            (out_dir / "brief.md").write_text(md, encoding="utf-8")
            (out_dir / "brief.json").write_text(stats + "\n", encoding="utf-8")
            return md
        finally:
            await sandbox.kill()


async def desktop_proof(url: str, out_dir: pathlib.Path) -> None:
    async with DesktopClient(
        api_key=os.environ["SOLARI_API_KEY"],
        base_url=API_BASE,
    ) as client:
        desktop = await client.create(
            template="default",
            resolution="1280x720",
            timeout_ms=8 * 60_000,
        )
        print("desktop:", desktop.sessionId)
        print("watch  :", desktop.streamUrl)
        try:
            await desktop.connect()
            for _ in range(30):
                health = await desktop.health()
                if getattr(health, "ready", False):
                    break
                await asyncio.sleep(1)

            # default template ships Chrome — open() fails if the name is wrong.
            pid = await desktop.open("google-chrome")
            print("opened google-chrome, pid", pid)
            await asyncio.sleep(4)
            # Omnibox, not screen centre (see desktop-computer-use-py).
            await desktop.mouse.click(420, 72, humanize=True)
            await asyncio.sleep(0.4)
            await desktop.keyboard.type(url)
            await desktop.keyboard.type("\n")
            await asyncio.sleep(6)
            await desktop.mouse.click(400, 360, humanize=True)
            shot = await desktop.screenshot(format="png")
            path = out_dir / "desktop.png"
            path.write_bytes(shot)
            print(f"desktop screenshot: {path} ({len(shot)} bytes)")
        finally:
            await desktop.close()
            await client.destroy(desktop.sessionId)


async def main() -> int:
    args = parse_args()
    if not os.environ.get("SOLARI_API_KEY"):
        print("Set SOLARI_API_KEY (console.getsolari.com).", file=sys.stderr)
        return 2

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("== 1/3 cloud browser ==")
    extract, png = await capture_page(args.url, stealth=not args.no_stealth)
    (out_dir / "browser.png").write_bytes(png)
    (out_dir / "extract.json").write_text(
        json.dumps(asdict(extract), indent=2) + "\n", encoding="utf-8"
    )
    print("title :", extract.title)
    print("h1    :", extract.h1)
    print("links :", len(extract.links))
    print("shot  :", out_dir / "browser.png")

    print("== 2/3 sandbox analyzer ==")
    brief = await analyze_in_sandbox(extract, out_dir)
    print(brief)

    if args.skip_desktop:
        print("== 3/3 desktop skipped ==")
        return 0

    print("== 3/3 desktop proof ==")
    try:
        await desktop_proof(extract.url, out_dir)
    except Exception as exc:
        print(f"desktop step failed (browser+sandbox packet is still valid): {exc}", file=sys.stderr)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
