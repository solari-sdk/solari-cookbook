# Draft launch post

I built ProcureLens: a small procurement reconciliation tool that connects internal JSON records to a supplier product page and produces evidence cards for discrepancies.

Solari Browser captures product facts; Solari Sandbox runs deterministic SKU matching and exact decimal comparisons. Reports preserve the relevant raw facts, normalized values, observation time and matching explanation. Unknown values stay unknown, and duplicate identities require review.

The first version supports one public Adafruit product page per run. An offline synthetic demo shows multi-row reconciliation and before/after price changes. Receipt verification replays the calculation; it is not source attestation.

Try `npm ci` and `npm run demo` on the fork's feat/procure-lens branch. Feedback on procurement evidence and failure cases is welcome. This is an early tool, not a substitute for checking purchasing terms or confirming stock.
