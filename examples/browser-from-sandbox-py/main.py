"""Browser from a sandbox — code running inside a sandbox drives a Solari cloud browser.

The usual reason: the code is untrusted (an agent wrote it, a user uploaded
it), so it has to run in a sandbox, but it also needs a real browser. Rather
than install Chromium in the VM, the sandboxed code launches a Solari browser
over the network, exactly as it would from your laptop. The VM stays small
and boots fast, and the browser gets stealth, proxies and recording if you
ask for them.

The host only creates the VM, hands it the key and collects stdout. Every
browser call happens inside the sandbox.
"""

import asyncio
import os
import sys

from solari_sandbox import SandboxClient

BASE_URL = "https://api.getsolari.com"
TARGET = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"

# Runs inside the sandbox. It reads the key from the env we inject below.
BROWSE = """
import asyncio, os, sys
from solari_browser import Solari

async def main(url):
    async with Solari(api_key=os.environ["SOLARI_API_KEY"]) as solari:
        # A hard cap on the browser session, in case this code hangs.
        browser = await solari.launch(session_timeout_ms=5 * 60_000)
        try:
            page = await browser.new_page()
            await page.goto(url)
            print("session:", browser.id)
            print("title  :", await page.title())
        finally:
            await browser.close()

asyncio.run(main(sys.argv[1]))
"""


async def main() -> None:
    api_key = os.environ["SOLARI_API_KEY"]
    async with SandboxClient(api_key=api_key, base_url=BASE_URL) as client:
        sandbox = await client.create(
            template="base",
            # Rolling IDLE window: it resets on every use, it is not a hard deadline.
            idle_timeout_ms=10 * 60_000,
            # Anything running in the sandbox can read this key. Use a separate
            # key you can revoke if the code there isn't yours.
            envs={"SOLARI_API_KEY": api_key},
        )
        print("sandbox:", sandbox.sandboxId)
        try:
            await sandbox.connect()
            await sandbox.files.write("/tmp/browse.py", BROWSE)

            # --target installs into a plain folder, which works even where the
            # system Python refuses pip installs (PEP 668).
            install = await sandbox.commands.run(
                "python3",
                args=["-m", "pip", "install", "-q", "--target", "/tmp/pylib", "solari-browser>=0.5.0"],
            )
            if install.exitCode != 0:
                raise RuntimeError(f"pip install failed:\n{install.stderr[-2000:]}")

            run = await sandbox.commands.run(
                "python3",
                args=["/tmp/browse.py", TARGET],
                env={"PYTHONPATH": "/tmp/pylib"},
            )
            print(run.stdout, end="")
            if run.exitCode != 0:
                raise RuntimeError(f"browse.py exited {run.exitCode}:\n{run.stderr[-2000:]}")
        finally:
            # kill() destroys the VM; close() alone would leave it running until
            # the idle timeout.
            await sandbox.kill()


if __name__ == "__main__":
    asyncio.run(main())
