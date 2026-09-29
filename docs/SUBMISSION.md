# ProcureLens review guide

Procurement staff often compare internal price and availability assumptions against supplier pages manually. ProcureLens produces a bounded reconciliation with inspectable evidence and explicit uncertainty.

Start with `npm ci && npm run demo`, then open the printed report.html. Review processor.py for deterministic decisions, acquisition.ts for source corroboration, solari.ts for remote lifecycle, and workflow.ts for replay and failure states. Tests run without paid resources.

Solari Browser isolates supplier page execution; Solari Sandbox provides fresh managed processing. Local replay shows that the comparison algorithm itself is portable. The value is an explicit acquisition-to-processing workflow with cleanup and evidence, not a claim that reconciliation mathematically requires cloud compute.

V1 is one Adafruit product page plus a synthetic multi-row demonstration. It is not a complete ERP connector, supplier catalog crawler or production procurement platform. No customer traction, revenue or savings claims are made.

This is a fork-only product attempt on feat/procure-lens. Existing cookbook examples, license and attribution are preserved. No upstream pull request is intended. Live validation status is recorded in VALIDATION.md; committed fixtures never represent live runs.
