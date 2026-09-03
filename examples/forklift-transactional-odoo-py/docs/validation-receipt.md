# Validation receipt

> [!IMPORTANT]
> This receipt covers only the historical oracle-v1 source and dependency bytes
> frozen in `artifacts/sealed/final-v2/`. The current working implementation is
> a post-campaign oracle-v2 reference candidate and is outside this receipt.

**Claim and frozen artifact digests:** Across six frozen final Odoo
purchase-to-pay case/fault positions, zero oracle-invalid candidate snapshots
are selected, while clean and explicitly idempotent positions meet their
precommitted liveness outcomes. Protocol digest
`f77b1b4e101d24c720a26cdc9b9dbce877fb553747967b72c978cf5c7101531e`;
report SHA-256
`4f9e1ccf0c49897afc9dc350d0e157a7b123c98944c784949ea29b15d396bb2b`.

**Independence level:** adversarial verification. The run used the original
implementation and execution environment. The sealed result is reproducible,
but it is not an independent reimplementation or external replication.

**Custody and unblinding record:** v1 was retired unopened after preflight found
incomplete dependency hashing and a ranged remote Playwright install. It has no
trial directory, report, or seed reveal. v2 used a fresh seed committed by
SHA-256 before execution. Cases, code, exact dependencies, schedules, expected
outcomes, stop rules, and budget were frozen. The seed was revealed after the
terminal report was sealed.

**Implementation and baseline:** one disposable Odoo state branch, one visible
GUI desktop, an immutable candidate snapshot, a fresh read-only auditor, and an
exact snapshot/receipt-bound selector. The matched completion-signal baseline
falsely accepted 3 of 16 audited development states; Forklift accepted 0.

**Untouched evidence and transfer regimes:** six fresh seeded cases balanced
across zero, partial, and full receipt regimes. Fault positions covered a
one-cent input mutation, a worker kill after receipt, and duplicate payment
submission. Generality beyond this Odoo transaction and oracle is not claimed.

**Negative controls and perturbations:** clean liveness in three receipt
regimes; wrong-price refusal; crash-after-receipt refusal; duplicate-payment
idempotency. A separate durable-promotion closure booted and re-audited the
exact promoted snapshot.

**Resource accounting:** 8 total attempts for 6 audited positions.
Two Chrome crashes occurred before login and before business mutation; both
artifacts were retained and each received one permitted fresh retry. Zero
post-mutation retries. Peak resources stayed at one desktop and two sandboxes,
with no plan change, balance top-up, or additional spend.

**Raw result locations and digests:** `artifacts/sealed/final-v2/`; protocol
file SHA-256
`11f7a91e666005a8aeb8112d1c5669cacbd972e78f7b3ce80d1fe09c6d0a5421`;
the content-addressed report is
`final-report-4f9e1ccf0c49.json`; all eight attempt hashes are bound inside it.

**Precommitted threshold outcome:** passed. Six positions completed, every
terminal attempt matched its frozen expected outcome, every oracle was present,
and false acceptances were zero.

**Discrepancies:** two managed Chrome failures before business mutation. They
reduce operational smoothness and are not counted as safety wins. They did not
cross the retry boundary. No evidentiary discrepancy or post-freeze repair.

**Verdict:** passed at the adversarial-verification level; not independently
replicated.

**Reproduction path:** run `python -m scripts.verify_final_evidence` to verify
the published packet offline, then run `python -m scripts.setup_local_lab` to
exercise the local invalid-versus-valid discriminator. A change to frozen
runtime code creates a new candidate version and requires new untouched final
evidence for an equivalent claim.
