"""Pricing scraper — extract tiered SaaS pricing from a live page to CSV.

A realistic competitive-intelligence workflow in Solari's cloud browser:
load a pricing page, wait for the plan cards to render, extract names,
prices, descriptions, and feature lists, then write a structured CSV.

The target and selectors default to https://getsolari.com/pricing but are
overridable via environment variables so the same script can point at any
SaaS pricing page.
"""

import asyncio
import csv
import os

from solari_browser import Solari

DEFAULT_TARGET = "https://getsolari.com/pricing"

SELECTORS = {
    "card": os.getenv("PRICING_CARD_SELECTOR", ".solari-pricing-plan"),
    "name": os.getenv("PRICING_NAME_SELECTOR", ".solari-pricing-plan-name"),
    "price_value": os.getenv("PRICING_PRICE_SELECTOR", ".solari-pricing-price-value"),
    "price_suffix": os.getenv("PRICING_SUFFIX_SELECTOR", ".solari-pricing-price-suffix"),
    "description": os.getenv("PRICING_DESC_SELECTOR", ".solari-pricing-description"),
    "features": os.getenv(
        "PRICING_FEATURES_SELECTOR",
        ".solari-pricing-feature-list li span:last-child",
    ),
}


async def extract_plan(card) -> dict:
    name = await card.locator(SELECTORS["name"]).first.inner_text()
    price = await card.locator(SELECTORS["price_value"]).first.inner_text()
    suffix = await card.locator(SELECTORS["price_suffix"]).first.inner_text()
    description = await card.locator(SELECTORS["description"]).first.inner_text()
    features = await card.locator(SELECTORS["features"]).all_inner_texts()

    return {
        "plan": name.strip(),
        "price": f"{price.strip()} {suffix.strip()}".strip(),
        "description": description.strip(),
        "features": " | ".join(f.strip() for f in features),
    }


async def extract_plans(page) -> list[dict]:
    target = os.getenv("TARGET_URL", DEFAULT_TARGET)
    await page.goto(target)

    # Wait for the pricing grid before querying, so the script is stable on
    # real sites where cards render after the initial load.
    await page.locator(SELECTORS["card"]).first.wait_for(timeout=15000)

    cards = await page.locator(SELECTORS["card"]).all()
    plans = [await extract_plan(card) for card in cards]
    return plans


async def main() -> None:
    solari = Solari(api_key=os.environ["SOLARI_API_KEY"])
    browser = await solari.launch()
    try:
        page = await browser.new_page()
        plans = await extract_plans(page)

        output_file = os.getenv("OUTPUT_FILE", "pricing.csv")
        with open(output_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["plan", "price", "description", "features"],
            )
            writer.writeheader()
            writer.writerows(plans)

        print(f"wrote {len(plans)} plans to {output_file}")
        for plan in plans:
            print(f"  - {plan['plan']}: {plan['price']}")
    finally:
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
