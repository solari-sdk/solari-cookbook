"""A recorded, screenshotted browser run can still deliver the wrong page."""

import argparse
import asyncio
import os

from solari_browser import Solari


async def main(task: str) -> None:
    path, expected = {
        "homepage": ("/", "Example Domain"),
        "pricing": ("/pricing", "Pricing"),
    }[task]
    async with Solari(api_key=os.environ["SOLARI_API_KEY"]) as solari:
        browser = await solari.launch(recording=True)
        try:
            page = await browser.new_page()
            response = await page.goto(f"https://example.com{path}")
            title = await page.title()
            heading = await page.locator("h1").inner_text(timeout=5000)
            await page.screenshot(path="screenshot.png", full_page=True)
            # Let rrweb flush; recording is evidence of execution, not success.
            await asyncio.sleep(2)
            print(f"session: {browser.id}")
            print(f"HTTP: {response.status if response else 'no response'}")
            print(f"delivered: title={title!r}, h1={heading!r}; screenshot saved")
            # A missing /pricing can render the homepage without goto raising.
            # Check the task's expected result, not just navigation or artifacts.
            #
            # example.com happens to answer 404 here, so the status gives it away
            # too. Plenty of sites return 200 on a missing page — a soft 404, an
            # SPA that renders its shell, a login wall wearing the site's chrome.
            # The content check is the one that survives all three.
            if (title.strip(), heading.strip()) != (expected, expected):
                raise AssertionError(f"wrong page: expected title and h1 {expected!r}")
            print("PASS: delivered page matches the task")
        finally:
            # Release the recorded session even when the content check fails.
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", nargs="?", choices=("pricing", "homepage"), default="pricing")
    asyncio.run(main(parser.parse_args().task))
