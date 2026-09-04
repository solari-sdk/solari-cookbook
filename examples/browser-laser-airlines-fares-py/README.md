# Reliable airline fare discovery (Python)

Discover available fare families for one public airline route and date with a managed Solari cloud browser. The implementation uses the Laser Airlines booking flow as a concrete example, but the browser-and-parser pattern applies to other carriers with JavaScript-heavy booking sites.

## The problem

Travelers often need to compare fares across fragmented, JavaScript-heavy booking sites. Conventional server-hosted scrapers can be unreliable, resource-heavy, and difficult to debug when booking flows change.

## Why Solari

Flight aggregators need prices from the carrier's public booking flow, not unverified fare sites or opaque third-party agencies that may show stale or misleading prices. Laser's fares are produced only after its JavaScript booking application loads airport suggestions, operates a custom calendar, submits the search, and renders a separate results page. Fetching the entry-page HTML alone is not enough.

The original production approach ran Chrome inside the scraper's Docker environment. Its incident history included 581 recorded iframe-load failures with no successes in the observed window, KIU session-error pages, upstream 403 responses with Cloudflare challenge markers, and later 429 responses during search submission. Moving the interaction to Solari changed the execution and debugging boundary:

| Observed problem | How Solari helps |
| --- | --- |
| The booking iframe did not reliably initialize in the local container. | Solari runs the real browser remotely in a managed environment instead of making the aggregator operate and maintain Chrome alongside its application workers. The same CCS → PMV flow later reached priced results through a Solari session. |
| KIU sometimes returned an empty shell, 403, or session-error page instead of inventory. | [Stealth mode](https://docs.getsolari.com/stealth) makes the browser look less obviously automated to common bot defenses. The example waits for and checks both the entry and booking-configuration responses before interacting, then verifies the final results URL, so a rejected session is not incorrectly returned as “no flights.” The repository proves the successful cloud-browser outcome, but it does not isolate stealth as the sole reason it succeeded. |
| A browser timeout did not explain whether the airport dropdown, calendar, submit action, or results navigation failed. | Optional session recording provides a replay of the actual UI flow. Response monitoring and stage-specific waits further identify where execution stopped. |
| Local browser runs consumed worker CPU, memory, and long-lived session capacity. | The browser workload is isolated from the application server. This example opens one bounded session for one route/date search and always releases it in a `finally` block. |
| Browser interaction failures and HTML selector changes looked similar. | Solari completes the live interaction and returns frozen rendered HTML. A separate static parser extracts fares, keeping transport failures distinct from results-page structure changes. |

This example enables `captcha=True`, so Solari's [managed CAPTCHA solver](https://docs.getsolari.com/captcha) is available if a supported challenge appears. There is no evidence that the validated Laser run displayed or solved a CAPTCHA, so CAPTCHA solving is a precaution—not a demonstrated step in this flow.

Solari does not eliminate airline rate limits, guarantee inventory, or bypass access rules. Low-frequency serial searches, explicit 429 handling, and responsible request pacing are still required.

## Production insight

The broader production application successfully used this approach for CCS → PMV, retrieving Economy Light, Economy Basic, Economy Plus, and Business Class fares directly from the public booking flow. The key value is not generic scraping; it is dependable price discovery for a real underserved travel market.

Browser interaction stays in [`main.py`](main.py). The rendered HTML is frozen with `page.content()` and passed to the separate static parser in [`parse.py`](parse.py), making results-page selector changes easier to isolate.

## Responsible use

- Query only public booking flows.
- Keep requests low-frequency and serial.
- Respect airline terms, availability, and rate limits.
- Do not use the example to collect credentials, evade access controls, or perform bulk extraction.

## Setup and run

```bash
cd examples/browser-laser-airlines-fares-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...  # https://console.getsolari.com
python main.py --origin CCS --destination PMV --departure-date 2026-09-21 --recording
```

The CCS → PMV command above was validated against the public booking flow on August 31, 2026. Omit `--recording` unless you need a replay for debugging.

The program exits with a concise error when the API key is missing, the date is past or unavailable, the carrier reports no flights, Solari or the upstream site blocks the session, or the expected results-page selectors no longer match. It never prints the API key.

## Sample output

```json
[
  {
    "airline": "Laser Airlines",
    "flight_number": "QL-904",
    "departure_airport": "CCS",
    "arrival_airport": "PMV",
    "departure_datetime": "2026-09-21T15:30:00",
    "arrival_datetime": "2026-09-21T16:20:00",
    "fare_class": "ECONOMY-LIGHT",
    "price_usd": 50.0,
    "booking_url": "https://booking.laserairlines.com/flightresults/"
  }
]
```
