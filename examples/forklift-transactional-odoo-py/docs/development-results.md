# Developmental Solari results

Status: **historical development evidence; the separate sealed final passed**

## What has actually been shown

Sixteen completed Solari trials used a real visible Chrome desktop to operate
Odoo 19, sealed the resulting PostgreSQL/Odoo root filesystem, restored those
exact bytes into a fresh auditor sandbox, and ran the read-only business oracle.

| Schedule | What the worker did | Oracle result | Selector result |
| --- | --- | --- | --- |
| Clean partial receipt | Received 6 of 10, kept 4 open, billed and paid 6 | Valid | Select |
| Duplicate payment click | Submitted Create Payment twice | Valid: one reconciled payment | Select |
| Duplicate receipt click | Submitted Validate twice | Valid: one completed receipt | Select |
| 90-second payment pause | Paused with payment dialog open, then resumed | Valid: one reconciled payment | Select |
| Kill after PO confirmation | Confirmed PO, then worker died | Reject: no completed receipt or bill | Refuse |
| Kill after receipt | Moved stock, then worker died before billing | Reject: `bill-count` | Refuse |
| Kill after posted bill | Posted payable, then died before payment | Reject: unpaid bill, residual, no payment | Refuse |
| Browser death during receipt entry | Typed quantity, then Chrome died | Reject: no completed receipt or bill | Refuse |
| Wrong unit price | Used $12.36 instead of hidden $12.35 and completed payment | Reject: 7 price/tax/accounting/payment checks | Refuse |
| Wrong received quantity | Used 10 instead of hidden 6 and completed payment | Reject: 8 stock/bill/accounting/payment checks | Refuse |

Machine-recomputed counts:

- audited trials: 16;
- valid candidates selected: 8;
- invalid candidates safely refused: 8;
- invalid candidates selected: **0**; and
- inconclusive artifacts: 4.

The inconclusive artifacts are a duplicate-receipt attempt with no restored
oracle verdict, a zero-receipt attempt rejected before allocation by Solari
host capacity, a held-out clean attempt whose Chrome renderer crashed before
any business mutation, and an early-kill attempt whose Odoo body never became
visible after login. All are excluded. Other earlier pre-injection
failures were observed before unique attempt artifacts were added. None is
counted as a safety success.

## Developmental held-out campaign

A six-case manifest was generated from a custody-held development seed and
bound by manifest digest. The GUI worker received each individual case but not
the seed. The execution order was frozen before results were opened:

1. unseen zero-receipt clean case — valid;
2. unseen partial-receipt clean case — valid;
3. unseen full-receipt clean case — valid;
4. second unseen zero-receipt clean case — first process stopped on a
   pre-mutation Chrome crash; a separately frozen capped-retry continuation
   accepted it on its first continuation attempt;
5. unseen partial case killed after receipt validation — refused on
   `bill-count`; and
6. unseen full case with a one-cent unit-price mutation — refused on PO price,
   bill amount, payable, and payment amount checks.

The continuation policy allowed at most three fresh attempts only when the
attempt artifact proved no business mutation or injected fault had occurred.
No continuation retries were needed.

## Why screen-level completion is insufficient

The browser can lie, crash, or finish a transaction containing the wrong
numbers. Its nine milestone messages never authorize acceptance. The selector
requires a separate auditor verdict, snapshot lineage, the exact case digest,
fault-schedule digest, action-log digest, oracle version, and a receipt bound to
the exact immutable snapshot. Missing evidence means no.

In plain terms, the worker edits a disposable copy. A separate auditor freezes
that copy, checks it against the expected business outcome, and only then
decides whether it may replace the clean original. If the worker crashes, uses
the wrong value, or reports completion too early, the original stays clean.

## Failures preserved during development

- A real Chrome page crash before login was discarded before any candidate was
  accepted.
- Oracle version 0 rejected a valid state because an invoice ID and payment ID
  both happened to be 1 in different tables. Version 1 binds the invoice by its
  actual accounting-move ID and includes a collision regression test.
- The first partial-receipt worker silently left Odoo's default quantity of 10.
  The auditor rejected all downstream totals. The worker now waits for the
  receipt-specific state, edits the authoritative `quantity` field, and fails
  if the edit does not visibly settle.
- A broad browser kill also destroyed the desktop control channel. The final
  injector targets only the marked worker Chrome process.

## What development alone did not prove

This fixed-fixture evidence did not by itself establish the final “zero false
acceptance” claim over a fresh sealed seed. Those remaining gates were later
closed in final-v2:

1. a newly generated sealed-final seed, trial count, and untouched evidence
   directory;
2. a precommitted zero-additional-dollar spending cap;
3. frozen source/dependency hashes with no post-evidence repair; and
4. six completed positions with zero false acceptance.

See [final-results.md](final-results.md) for the passed sealed campaign and its
offline verification command. Independent replication remains explicitly
unclaimed; sealed evidence from the original implementation environment is
adversarial verification, not independence.
