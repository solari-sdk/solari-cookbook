# Security and public-data boundary

This repository is intentionally public and is limited to lawful public/open information plus generic engineering techniques. Do not add customer data, private source inventories, private personal information, credentials, FCI, CUI, classified information, leaked datasets, or proprietary logic from unrelated systems.

Public availability alone is not sufficient authorization to automate a source. Source adapters must document access mode, provenance, known terms/rate considerations, and failure behavior. Prefer official documented APIs and feeds. Media/news monitoring is explicitly outside project scope.

Credentials are configuration, never repository content. `SOLARI_API_KEY` is environment/user supplied. Static-mode evaluator key scaffolding keeps the value in browser memory by default and provides an explicit clear action. Portable-case import/export runs secret/session-pattern checks and never serializes the in-memory Solari key.

Source data and imported artifacts are untrusted. Render data as text, do not execute source JavaScript, keep a restrictive CSP, and place generated/untrusted parsing logic in Solari Sandbox rather than host or browser evaluation. Final public release still requires current-tree and Git-history secret scans and a privacy/proprietary-material review.
