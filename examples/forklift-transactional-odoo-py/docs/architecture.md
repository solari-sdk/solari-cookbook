# Architecture

Forklift treats a GUI worker's output as a proposal, not as authoritative
business state. The observable result is the Odoo/PostgreSQL state that passes
the semantic audit and becomes durable—not the sequence of clicks or the
worker's success message.

## Scope

The implementation covers one purchase-to-pay workflow inside a snapshotted
Solari VM. It protects only the state represented by that snapshot and the
invariants encoded in oracle version 1. External email, banking, and third-party
API effects are outside the boundary and must remain staged or use a separate
commit protocol.

## Input and output contract

Each case specifies a case ID, supplier, SKU, ordered and received quantities,
unit price, currency, tax rule, vendor-bill reference, payment journal, and
payment terms. Cases include partial receipts, decimal prices, tax-rounding
edges, repeated-looking references, and zero-receipt orders that must not be
billed or paid.

An accepted output consists of a candidate snapshot ID and a machine-readable
receipt containing:

- the exact input digest;
- candidate and canonical snapshot identifiers;
- the snapshot's parent lineage;
- fault-schedule and worker-action-log digests;
- the oracle version and complete invariant verdict; and
- an unambiguous `ACCEPT` decision.

A missing or incomplete receipt means `REJECT`.

## State flow

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

The orchestrator starts an isolated candidate sandbox from a clean canonical
snapshot and uses a disposable visible desktop to operate Odoo through a signed
preview. The fault injector can kill the worker or browser, pause execution,
duplicate an action, alter a field before submission, or interrupt between
visible milestones. It cannot read or modify the oracle or expected case.

The oracle is read-only and does not trust the worker's screen, narration, or
exit code. To prevent a check-then-change race, it never queries the live worker
branch. Forklift first seals that branch into an immutable candidate snapshot,
forks a fresh auditor from those exact bytes, and queries the auditor's Odoo
database. The promoter verifies that the candidate snapshot descends from the
canonical snapshot and that the receipt binds that exact snapshot. Exactly one
eligible snapshot can be registered as a durable Solari template. If no
candidate is eligible, the canonical state remains unchanged.

## Oracle invariants (version 1)

For the case ID and vendor reference:

1. exactly one purchase order exists with the expected vendor, currency, lines,
   quantities, prices, and tax identities;
2. exactly one completed incoming picking belongs to it, with done quantity
   equal to the case's received quantity and no unintended completed moves;
3. exactly one posted vendor bill is linked to it, has the required external
   reference, bills no more than received quantity, and has the separately
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

Oracle version 1 also handles a subtle Odoo identity collision: bill IDs and
payment IDs come from independent sequences and can have the same numeric
value. Bill journal evidence is therefore joined through the actual
`account.move` ID rather than a polymorphic source ID. A regression test covers
this case.

## Fail-closed behavior

The following conditions all prevent promotion:

- the oracle cannot distinguish a known-invalid state from a valid one;
- the snapshot lineage or receipt binding does not match;
- the oracle, snapshot lookup, or auditor is unavailable;
- a required relation or action-log entry is missing;
- a duplicate or unexpected business object exists; or
- a numeric value is outside the configured currency-rounding rule.

The implementation does not report uncertainty as success. Refusing all
candidates is allowed; changing the canonical state without a complete valid
receipt is not.

## Extension points

`forklift/orchestrator.py` and `forklift/promotion.py` implement the generic
snapshot–audit–promote sequence. The Odoo-specific contract lives in
`forklift/domain.py`, `forklift/odoo_sql.py`, and `forklift/oracle.py`. A new
integration should replace the task and semantic checks while retaining the
immutable audit boundary and exact receipt bindings.
