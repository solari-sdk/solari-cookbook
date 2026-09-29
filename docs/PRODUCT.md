# ProcureLens V1

ProcureLens detects discrepancies between supplier-side web data and internal purchasing records, with evidence for each mismatch.

## User and scope

A purchasing operations person checks a supplier's listed unit price and availability against an internal JSON purchasing list. Today they open product pages, copy values into a spreadsheet, resolve product identifiers, and explain exceptions to colleagues. V1 supports one public Adafruit product page per run, plus a synthetic multi-record fixture for offline demonstration. All missing-record findings are explicitly limited to the acquired page, never the entire supplier catalog.

The live source adapter is deliberately narrow: `https://www.adafruit.com/product/<numeric ID>`, schema.org Product/Offer data corroborated against the visible product heading, product ID, price and availability. No logins, carts, purchases, proxies, CAPTCHA solving or LLM extraction. Unsupported or conflicting source markup fails acquisition rather than producing a clean reconciliation. Public structured markup is a supplier claim, not an independently audited price or stock commitment.

## Workflow

1. Validate the internal JSON records and supported source URL locally (`plan`).
2. Create one Solari Browser; navigate once, collect bounded relevant Product/Offer fields and visible corroboration; release it.
3. Send validated internal and supplier rows to one fresh Solari Sandbox; retain capture provenance host-side. Run a fixed Python standard-library processor: normalize, match, compare. Release it.
4. Produce a JSON run record and escaped standalone HTML evidence cards. `verify` validates provenance/digests and reruns the fixed deterministic processor locally; it never revisits the supplier.
5. `compare` two verified acquisition snapshots from the same source and execution mode. Show price/availability/stock/lead-time changes with both observations. No mixed simulation/live comparison.

## Data and matching

JSON-only V1; no CSV dependency. Each row has `sku`, `name`, `price` (decimal string or null), `currency` (USD/EUR/GBP or null), `availability` (in_stock/out_of_stock/discontinued/preorder/backorder or null), `stock` (nonnegative integer or null), and `leadTimeDays` (nonnegative integer or null). Prices mean the listed single supplier item, before shipping/tax/quantity discounts; internal data must use the same basis. Stock counts are never inferred from availability. Absent supplier lead time or inventory quantity remains unknown.

Match exact SKU first, then Unicode NFKC/trim/case-normalized SKU. Do not strip punctuation, guess by name or use fuzzy matching. A duplicate normalized identity on either side is ambiguous and requires review. Every decision records row references, method and categorical confidence (exact/normalized/none), not an invented probability.

Use exact decimal arithmetic, no floating-point money rounding and no currency conversion. Missing requested values and currency disagreements are uncomparable, not equal. Compare only fields requested by non-null internal values; at least price or availability must be provided in an internal row. Names identify evidence but are not a price/stock comparison field.

## Results and trust

Per-field classes: MATCH, PRICE_DRIFT, STOCK_MISMATCH, LEAD_TIME_DRIFT, AVAILABILITY_MISMATCH, UNCOMPARABLE_FIELD. Record-level classes: MISSING_SUPPLIER_RECORD, MISSING_INTERNAL_RECORD, AMBIGUOUS_MATCH. Every card includes internal/supplier raw and normalized values, row identity, URL, observation time, normalization notes, matching method and explanation. MATCH means the compared supplied fields agree within this page scope; never claim a supplier-wide clean audit.

Any discrepancy or ambiguity produces REVIEW_REQUIRED. Only complete acquisition, consistent processor output and confirmed releases can produce COMPLETE. Acquisition failures, malformed output, deadlines, cancellation and uncertain cleanup cannot produce COMPLETE. Failure reports retain a safe error category, never provider raw errors, session IDs, control URLs or credentials.

SIMULATION runs the same trusted processor locally on labeled synthetic records. SOLARI selects the real provider path; a successful result requires both browser acquisition and sandbox processing. Failed runs explicitly record which stages did not start. Neither hashes nor successful replay authenticate a source or resist a malicious provider. No user, saving, demand, or traction claims without evidence.

## Boundaries and success

Self-contained example under `examples/procurelens`; preserve upstream examples, license, attribution and main cookbook purpose. Root npm scripts provide convenient checks. No unrelated service, database, dashboard framework, agent loop or arbitrary uploaded code.

Defaults: one page, up to 100 rows per side, 256 KiB internal input, 64 KiB source fragments; browser 45 seconds and sandbox 45 seconds with separate 10-second cleanup budgets. Sequential resources, no workflow retries. Exactly one deliberate live workflow after offline tests pass. No real run outputs are committed, even after success.

Acceptance: deterministic fixture shows match, price/availability/stock differences, missing and ambiguous rows; tests cover every failure boundary; run comparison explains before/after changes; evaluator can install, simulate, inspect, verify, and optionally run the supported supplier source. No production procurement decision or purchase is automated.
