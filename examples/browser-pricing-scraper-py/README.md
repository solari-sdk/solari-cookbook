# Browser pricing scraper (Python)

Scrape a live SaaS pricing page and export tiered plans to CSV.

This is a common competitive-intelligence workflow: point a cloud browser at a
pricing page, wait for the plan cards to render, extract names, prices,
descriptions, and feature lists, then write a structured `pricing.csv`.

The target URL and CSS selectors are configurable via environment variables, so
you can reuse the script for any pricing page.

## Run

```bash
cd examples/browser-pricing-scraper-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py
```

## What it does

1. Loads `https://getsolari.com/pricing` (or `TARGET_URL`).
2. Waits for the pricing grid to render.
3. Extracts each plan's name, price, description, and bullet features.
4. Writes `pricing.csv`.

## Customize

Copy `.env.example` to `.env` and adjust the selectors for the pricing page you
want to scrape.

Source: [`main.py`](main.py)
