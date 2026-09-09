"""Session recording — capture a run and download the replay.

Recording is OPT-IN PER SESSION (`recording=True` at create time). There is no
account-level switch: a session created without the flag records nothing, and
its replay endpoint will 404 forever.

The replay is rrweb NDJSON (gzipped) — a DOM-level recording, not a video, so
it stays small and you can diff or grep it.
"""

import asyncio
import os

from solari_browser import Solari
from solari_browser.errors import SolariError

# The poll window, in one place: the message printed on timeout is derived from
# these so it cannot drift from the loop that produced it.
POLL_ATTEMPTS = 10
POLL_INTERVAL_S = 3


async def main() -> None:
    solari = Solari(api_key=os.environ["SOLARI_API_KEY"])

    browser = await solari.launch(recording=True)
    session_id = browser.id
    try:
        page = await browser.new_page()
        await page.goto("https://example.com")
        await page.locator("h1").inner_text()
        # Give rrweb a moment to flush the events it batched.
        await asyncio.sleep(2)
    finally:
        await browser.close()

    # The upload happens asynchronously AFTER the session is released, so the
    # first poll usually 404s even on a perfectly good recording. Retry before
    # concluding there is no replay.
    for attempt in range(1, POLL_ATTEMPTS + 1):
        await asyncio.sleep(POLL_INTERVAL_S)
        try:
            blob = await solari.sessions.download_replay(session_id)
        except SolariError as err:
            if err.status == 404:
                print(f"  attempt {attempt}: not uploaded yet")
                continue
            raise
        # The object is stored gzipped, but the HTTP client honours
        # Content-Encoding and hands back decompressed bytes — so this is
        # already plain NDJSON. Don't gzip.decompress() it.
        events = blob.decode().splitlines()
        print(f"replay: {len(blob)} bytes, {len(events)} rrweb events")
        print("first event:", events[0][:90], "...")
        return

    # Do NOT send the reader to check `recording=True` here: this script sets it
    # at launch, so it can never be the cause. A 404 at this point means the
    # upload had not appeared inside the window above, which is a different
    # problem with a different fix.
    print(f"no replay after ~{POLL_ATTEMPTS * POLL_INTERVAL_S}s.")
    print("This script sets recording=True at launch, so the recording is not missing.")
    print(f"Retry the download later for session {session_id}.")


if __name__ == "__main__":
    asyncio.run(main())
