# Forklift construction dossier

Status: **development contract frozen before implementation**

## Consequential objective

Make one difficult GUI business transaction safe under worker mistakes,
timeouts, and crashes. The observable output is not "the worker clicked the
right buttons". It is a promoted Odoo/PostgreSQL state that exactly satisfies
the hidden case's purchase-to-pay contract.

The product objective is broader but separable: make this transactional wrapper
usable by other GUI-agent builders without consulting its author. Competition
success therefore requires both the safety result and at least one credible
external reuse signal; technical spectacle alone is insufficient evidence of
need.

## Frozen acceptance claim

Across the precommitted hidden cases and injected-fault schedules, the count of
invalid states promoted as valid is zero. Liveness is secondary: refusing to
promote is allowed; promoting an invalid state is not.

This is a bounded claim. It covers only state inside the snapshotted Solari VM
and only invariants encoded in the frozen oracle. External emails, bank rails,
and third-party APIs are excluded and must remain staged rather than executed.

## Input and output contract

Each hidden input specifies a case id, supplier, product/SKU, ordered quantity,
received quantity, unit price, currency, tax rule, vendor bill reference,
payment journal, and payment terms. Values include awkward but legal cases such
as partial receipts, decimal prices, tax rounding, repeated references, and
zero-receipt bills that must not be paid.

The only accepted output is the identifier of a retained branch plus a
machine-readable receipt containing:

- the exact input digest;
- branch, canonical-snapshot, and sealed candidate-snapshot identifiers;
- fault schedule and worker action log digests;
- oracle version and complete invariant verdicts; and
- an unambiguous `ACCEPT` decision.

No receipt or an incomplete receipt means `REJECT`.

## Strongest equal-resource baseline

The baseline gets the same GUI worker, time budget, input, and fault. It runs
directly on one Odoo instance, may retry after an error, and judges success from
the worker's own report or the final screen. It has no pre-action snapshot, no
isolated candidate branches, and no independent semantic database oracle.

## Complete mechanism

```text
canonical sandbox root snapshot
        |
        +--> one candidate state sandbox <--signed preview-- disposable GUI desktop
                         |
                         +--> immutable snapshot --> fresh auditor sandbox
                                                        |
                                             read-only business oracle
                                                        |
                                              exact pass + lineage?
                                             yes /              \ no
                            promote exact snapshot bytes       destroy
```

The orchestrator freezes a clean canonical state snapshot, creates isolated
candidate sandboxes from it, assigns deterministic fault schedules, and uses a
separate disposable visible desktop to run the same GUI transaction against
each signed preview. The fault injector may kill the worker, kill the browser,
pause execution, duplicate an action, corrupt a field before submission, or
interrupt between visible milestones. It may not modify the oracle.

The oracle is read-only and does not trust the worker's screen, narration, or
exit code. To prevent a check-then-change race, it never queries the live worker
branch. Forklift first seals that branch into an immutable candidate snapshot,
forks a fresh auditor from those exact bytes, and queries the auditor's Odoo
database. The promoter verifies that the candidate snapshot descends from the
canonical snapshot and that the receipt binds that exact snapshot. Exactly one
eligible snapshot is registered as a durable Solari template; every other
branch is destroyed. If none is eligible, no state is promoted.

## Oracle invariants (version 1)

For the hidden `case_id` and vendor reference:

1. exactly one purchase order exists with the expected vendor, currency, lines,
   quantities, prices, and tax identities;
2. exactly one completed incoming picking belongs to it, with done quantity
   equal to the case's received quantity and no unintended completed moves;
3. exactly one posted vendor bill is linked to it, has the required external
   reference, bills no more than received quantity, and has the independently
   recomputed untaxed, tax, and total amounts;
4. every posted journal entry is balanced, the payable residual has the
   expected sign and value, and tax lines use the expected accounts;
5. the expected payment exists exactly once if and only if payment is allowed,
   is posted for the exact amount and currency, and reconciles the intended
   payable—never another vendor or bill;
6. no extra purchase order, picking, bill, payment, or posted journal entry was
   created for the case id; and
7. an append-only action receipt is complete and binds the input, snapshot,
   candidate, fault schedule, and oracle result.

An exception, missing relation, duplicate, unexpected state, or numeric value
outside the frozen currency-rounding rule is a rejection, never an unknown pass.

Version 1 corrects a deliberately preserved developmental failure: bill IDs
and payment IDs come from independent PostgreSQL/Odoo sequences and may have
the same number. Bill journal evidence is therefore bound by the actual
`account.move` ID, not by a polymorphic source ID that could collide with an
`account.payment` ID. A regression test freezes this boundary.

## Discriminating predictions

- Under a kill immediately after receipt validation, the baseline can leave a
  persistent stock change without a completed payable workflow. Forklift must
  promote nothing invalid.
- Under a duplicated payment click, the baseline can create a duplicate or
  ambiguous payment. Forklift's oracle must reject that branch.
- Under a wrong quantity typed just before posting, a visually plausible result
  may survive. Forklift must reject it from database semantics.
- With at least one fault-free candidate and sufficient time, Forklift should
  preserve useful throughput rather than achieving safety only by rejecting all
  work.

## Stop and revise conditions

Revise the candidate rather than adding presentation layers if any of these
occurs during development:

- the independent oracle cannot distinguish a seeded invalid state from a valid
  one;
- a fault can escape the Solari VM boundary;
- the worker or injector can alter oracle code or frozen inputs;
- no clean candidate can complete representative cases within the resource
  budget; or
- a simpler single-snapshot protocol provides the same safety and liveness.

Before claiming product-market fit, also require a stranger-success test: a
fresh user following only the public README can run the crash comparison and
interpret its receipt. Repository views, likes, or friendly comments do not
count as adoption by themselves.
