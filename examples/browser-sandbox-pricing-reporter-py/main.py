"""Pricing reporter — collect a pricing page in a Solari browser,
parse it in a Solari sandbox, and write CSV/JSON on the host.

This demonstrates a real web-data-extraction pipeline across two Solari
primitives: cloud browser and headless sandbox.
"""

import asyncio
import os

from solari_browser import Solari
from solari_sandbox import SandboxClient

BASE_URL = "https://api.getsolari.com"
DEFAULT_TARGET = "https://getsolari.com/pricing"
PARSER_SCRIPT = os.path.join(os.path.dirname(__file__), "parser.py")


async def main() -> None:
    api_key = os.environ["SOLARI_API_KEY"]
    target_url = os.environ.get("TARGET_URL", DEFAULT_TARGET)

    card_class = os.environ.get("CARD_CLASS", "solari-pricing-plan")
    name_class = os.environ.get("NAME_CLASS", "solari-pricing-plan-name")
    price_class = os.environ.get("PRICE_CLASS", "solari-pricing-price-value")
    suffix_class = os.environ.get("SUFFIX_CLASS", "solari-pricing-price-suffix")
    description_class = os.environ.get("DESCRIPTION_CLASS", "solari-pricing-description")
    features_class = os.environ.get("FEATURES_CLASS", "solari-pricing-feature")

    async with Solari(api_key=api_key) as solari:
        browser = await solari.launch()
        try:
            page = await browser.new_page()
            await page.goto(target_url)
            await page.wait_for_load_state("networkidle")

            print("title:", await page.title())
            html = await page.content()
        finally:
            # close() also releases the session, which frees the concurrency slot.
            await browser.close()

    async with SandboxClient(api_key=api_key, base_url=BASE_URL) as client:
        sandbox = await client.create(template="base")
        await sandbox.connect()
        try:
            with open(PARSER_SCRIPT, "r", encoding="utf-8") as f:
                parser_code = f.read()

            await sandbox.files.upload("/tmp/parser.py", parser_code)
            await sandbox.files.upload("/tmp/pricing.html", html)

            await sandbox.env(
                {
                    "CARD_CLASS": card_class,
                    "NAME_CLASS": name_class,
                    "PRICE_CLASS": price_class,
                    "SUFFIX_CLASS": suffix_class,
                    "DESCRIPTION_CLASS": description_class,
                    "FEATURES_CLASS": features_class,
                    "PRICING_HTML_PATH": "/tmp/pricing.html",
                    "PRICING_CSV_PATH": "/tmp/pricing.csv",
                    "PRICING_JSON_PATH": "/tmp/pricing.json",
                }
            )

            result = await sandbox.commands.run(
                "python3", args=["/tmp/parser.py"], timeout_ms=120_000
            )
            if result.exitCode != 0:
                print("parser failed:", result.stderr)
                return

            print(result.stdout.strip())

            csv_bytes = await sandbox.files.download("/tmp/pricing.csv")
            json_bytes = await sandbox.files.download("/tmp/pricing.json")

            csv_path = os.environ.get("OUTPUT_CSV", "pricing.csv")
            json_path = os.environ.get("OUTPUT_JSON", "pricing.json")

            with open(csv_path, "wb") as f:
                f.write(csv_bytes)
            with open(json_path, "wb") as f:
                f.write(json_bytes)

            print(f"wrote {csv_path} and {json_path}")
        finally:
            # kill() destroys the VM and frees the sandbox slot.
            await sandbox.kill()


if __name__ == "__main__":
    asyncio.run(main())
