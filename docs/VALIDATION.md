# Validation status

Offline: 26 Node tests, 9 Python processor tests, TypeScript typecheck, build and simulation demo pass. The demo reports SIMULATION REVIEW_REQUIRED; the before/after fixture demonstrates 129 to 139 (+7.75%). Tests cover successful matching, ambiguity, unknown fields, malformed evidence, output replay, cancellation, provider failures and cleanup uncertainty.

One deliberate real Solari attempt was made on 2026-09-09 using the supported Adafruit product 385 URL and explicitly synthetic internal input. Outcome: SOLARI FAILED_ACQUISITION. Browser release was confirmed; sandbox was not started. The failure receipt passes integrity verification. No second attempt was made, and no live receipt or provider identifiers are committed.

Successful live browser-to-sandbox end-to-end validation remains pending. The safe failure category does not identify the precise navigation/extraction cause. Offline mocked provider tests prove application behavior at the boundary, not compatibility with every current supplier page or successful live processing. Do not present this result as a successful real Solari reconciliation.

Hostile review identified and fixed live currency corroboration (this adapter requires USD) and missing comparison-bundle replay verification. Product review keeps the scope explicit: a one-page prototype with synthetic multi-row examples, human-reviewed discrepancies and no catalog-wide absence claims. Simplicity review retained one fixed standard-library processor and static reports; no framework, database or LLM was added.
