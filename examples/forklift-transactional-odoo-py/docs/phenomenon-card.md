# Frozen phenomenon card: persistent partial purchase-to-pay state

Observed: 2026-09-01
System: official `odoo:19.0` image (`19.0-20260817`) with PostgreSQL 15
Evidence class: developmental reality anchor, not final evidence

## Reproducible observation

Through Odoo's real web GUI, a worker:

1. created PO `P00001` for synthetic case `FORKLIFT-CASE-017`;
2. ordered 10 units of `BEARING-6204` at $12.35 with the configured 7.5% tax;
3. confirmed the PO;
4. validated receipt `WH/IN/00001` for only 6 units;
5. created backorder `WH/IN/00002` for the remaining 4; and
6. was intentionally terminated before billing or payment.

The independent database inspection after GUI termination showed:

```text
purchase order: P00001, state=purchase, ordered=10, received=6, invoiced=0
done picking:   WH/IN/00001, moved=6, Vendors -> WH/Stock
backorder:      WH/IN/00002, state=assigned, remaining demand=4
internal stock: WH/Stock = 6
vendor bills:   0
payments:       0
```

## Why it matters

Closing or crashing the GUI worker does not roll back previously committed GUI
actions. The partially completed business workflow persists and is visible to
downstream users and automation. A worker exit code, final screenshot, or
self-reported success cannot establish that the requested purchase-to-pay
transaction finished correctly.

This observed state is **unfinished**, not internally corrupt: Odoo legitimately
supports partial receipts and backorders. The consequential failure occurs if an
agent or orchestrator accepts it as the completed requested result. Separate
wrong-quantity, wrong-vendor, overbilling, and duplicate-payment faults generate
actually invalid results; the same semantic oracle must reject both unfinished
and invalid outcomes.

## Residual signature

A persistent case-scoped combination of:

- at least one committed stock move;
- no correctly posted and reconciled vendor bill/payment; and
- a worker that is absent, failed, timed out, or claiming completion.

## Alternative explanations ruled out

- **Only the browser cache changed:** false; PostgreSQL contains the PO,
  pickings, moves, and stock quants after the tab was closed.
- **The whole receipt was accidentally completed:** false; the done move is 6
  and a separate assigned backorder has demand 4.
- **Billing happened invisibly:** false; the case-scoped vendor-bill count and
  payment count are both zero.
- **A custom toy app produced the effect:** false; the run used the official
  Odoo 19 container and native Purchase, Inventory, and Accounting modules.

## Evidence caveat and next check

The first database was initialized with Odoo's changed boolean syntax for
`--without-demo`; it contains unrelated demo records. Every observation above is
scoped to unique case id `FORKLIFT-CASE-017`, PO `P00001`, and product id 1, so
the phenomenon is not explained by those records. The canonical Solari image
must nevertheless be rebuilt cleanly with `--without-demo` before final tests.

The next discriminating experiment compares this direct-mutation baseline with
the same workflow in disposable snapshot branches, including wrong quantity and
duplicate-payment faults. Forklift advances only if it produces zero invalid
promotions while still completing clean controls.
