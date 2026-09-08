# Browser + Sandbox Pricing Reporter

A real web-data-extraction pipeline: the browser collects a SaaS pricing page, the sandbox parses it, and the host receives the results as CSV and JSON.

## What it shows

This is the missing bridge between the browser and sandbox quickstarts. It uses:

- `solari-browser` to load the page and capture the rendered HTML.
- `solari-sandbox` to run a tiny `parser.py` in an isolated micro-VM.
- Standard-library `html.parser` to extract plan names, prices, descriptions, and feature lists.

## Run

```bash
pip install -r requirements.txt
cp .env.example .env
# edit .env with your SOLARI_API_KEY
python main.py
```

The default target is `https://getsolari.com/pricing`. You can point it at any pricing page by setting `TARGET_URL` and the `*_CLASS` env vars.

## Output

- `pricing.csv` — one row per plan with columns `plan`, `price`, `description`, `features`.
- `pricing.json` — the same data as JSON with `features` as an array.

## Test the parser offline

The parser is exercised with a local fixture so you can validate it without a Solari API key:

```bash
python -m unittest tests.test_parser
```

## Notes

- `browser.close()` also releases the Solari session, which frees the browser concurrency slot.
- `sandbox.kill()` destroys the VM, which frees the sandbox slot.
- The default class selectors match `https://getsolari.com/pricing` at the time this example was written; override them in `.env` if the DOM changes.
