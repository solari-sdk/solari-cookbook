# Forklift: transactional computer use for Odoo

Forklift makes a dangerous GUI workflow behave like a database transaction.
It performs a real purchase-to-pay operation in Odoo, deliberately crashes or
misleads the GUI worker, and only promotes a branch whose final database state
passes an independent business oracle. A failed or uncertain branch is simply
not accepted.

It is packaged as a reusable safety harness, not a one-off competition demo.
Any GUI-agent builder should be able to replace the worker and business oracle,
run the same crash challenge, and receive a self-verifying acceptance receipt.
The Odoo workflow is the first concrete product wedge because stock, payable,
tax, and payment can visibly disagree after a partial failure.

The first target transaction is deliberately unforgiving:

1. create a purchase order with the exact supplier, product, quantities, price,
   tax, and reference supplied by a hidden test case;
2. receive only the quantity that actually arrived;
3. create and post the matching vendor bill;
4. register exactly one payment for exactly the amount due; and
5. leave stock, payable, tax, and payment ledgers mutually consistent.

The safety claim is narrow and testable: for the frozen case distribution,
fault schedule, oracle, and Solari VM boundary, Forklift must accept zero
invalid final states. It does **not** claim to undo effects outside the VM such
as a real bank transfer or email.

## Local lab

The Docker lab is for fast development before the pruned Odoo/PostgreSQL runtime
is placed on a Solari sandbox root snapshot. A separate disposable Solari
desktop drives its signed web preview. The complete reproducible crash
challenge is one command (the first Odoo initialization can take several
minutes):

```bash
python -m pip install -r requirements.txt
python -m scripts.setup_local_lab
```

It needs Python 3.11+ and Docker Desktop, but no Solari account or API key. A
successful run ends with one broken live Odoo database rejected, one balanced
database accepted, and `RESULT: PASS`.

The setup is fail-closed: it reuses an already-correct lab, but refuses to
overwrite an ambiguous or non-clean canonical database.

The lower-level manual setup is:

```bash
docker compose up -d db
docker compose run --rm web odoo -d forklift -i purchase,stock,account \
  --without-demo --stop-after-init
docker compose up -d web
```

Open <http://localhost:8069>. The synthetic lab credentials are intentionally
non-secret and must never be reused outside this contained test environment.

To rerun only the developmental interrupted-versus-valid discriminator:

```bash
python -m scripts.compare_live_states
```

It exits successfully only when the real interrupted Odoo state is rejected
and the independently constructed complete state is accepted. These are
development fixtures, not sealed competition results.

## Acceptance rule

Forklift accepts a branch only when every required invariant is proven by a
read-only PostgreSQL query and the execution receipt is complete. A crash,
timeout, ambiguous screen, missing receipt, duplicate object, wrong value, or
oracle error all mean `REJECT`. If every branch is rejected, the canonical
snapshot remains the answer and no broken state is promoted.

The oracle never inspects a still-changing worker VM. Forklift first seals the
state sandbox as an immutable snapshot, starts a fresh auditor sandbox from that exact
snapshot, and runs the read-only oracle there. The promoter verifies the
snapshot lineage and receipt bindings, then turns only the selected snapshot
into a durable Solari template. This removes the usual check-then-change race:
the bytes judged are the bytes promoted.

## Sealed Solari result

The frozen final campaign passed: **6/6 audited hidden positions completed, 0
invalid states were accepted, and all 8 attempts were preserved**. The extra
two attempts were Chrome crashes before login and before any business mutation;
they were retained and retried under the precommitted policy. No post-mutation
attempt was retried.

Three clean cases proved Forklift does not win by rejecting everything. A
one-cent wrong-price case and a worker killed after receipt were both refused
from restored database evidence. A duplicated payment submission finished with
exactly one valid reconciled payment and was accepted.

Verify the sealed evidence offline:

```bash
python -m scripts.verify_final_evidence
```

See [final-results.md](docs/final-results.md) for the matrix and hashes, and
[judge-demo.md](docs/judge-demo.md) for the three-minute proof. This is sealed
adversarial verification in the builder's workspace, not independent
replication.

## Developmental Solari result

The current machine-recomputed campaign contains 16 audited real-GUI trials:
8 invalid outcomes were safely refused, 8 valid outcomes were selectable, and
0 invalid outcomes were selected. It includes a digest-frozen six-case
developmental held-out plan spanning zero, partial, and full receipts. Four
attempts without an audit verdict are labeled inconclusive and excluded rather
than counted as safe.

This development campaign justified the frozen final run but is not mixed into
its score. External replication and stranger use remain separate product-fit
gates.
See [development-results.md](docs/development-results.md) for the exact matrix.

The public packet intentionally excludes bulky developmental scratch assets,
temporary signed URLs, and local custody files. Re-running live Solari trials
therefore requires rebuilding the canonical runtime/database artifacts and
supplying your own `SOLARI_API_KEY`. The sealed final score does not require a
key and is fully checked by `python -m scripts.verify_final_evidence`.

## Product-fit proof

The technical gate is zero false acceptance. The product gate is external
reuse: a stranger can clone the repository, run the local before/after crash
challenge with one command, understand why a branch was rejected, and adapt the
oracle without talking to the author. Public validation will report completed
external runs, forks/adaptations, issue reports, and reproducible receipts. It
will not substitute social-media impressions for product use.
