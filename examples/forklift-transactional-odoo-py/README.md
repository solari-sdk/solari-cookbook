# Forklift: transactional computer use for Odoo

Forklift adds a transaction-like acceptance boundary to stateful GUI
automation. A visible browser worker performs a real purchase-to-pay workflow
in Odoo on a disposable state branch. Forklift then freezes that branch, audits
the exact frozen state from a fresh sandbox, and promotes it only when every
business invariant passes. Failed or uncertain work never replaces the clean
canonical state.

The example demonstrates four reusable ideas:

- isolate GUI work from the canonical state;
- treat the worker's completion signal as untrusted;
- validate business semantics from an immutable snapshot; and
- bind promotion to the exact snapshot that was audited.

The Odoo scenario checks a purchase order, stock receipt, vendor bill, tax,
payable balance, and payment as one logical outcome. It intentionally includes
partial receipts, duplicate actions, wrong values, timeouts, and worker crashes.

> [!IMPORTANT]
> Forklift's rollback boundary is the snapshotted VM. It does not undo effects
> that have already escaped that boundary, such as bank transfers, emails, or
> calls to third-party services. Keep those effects staged until after a state
> has been accepted, or protect them with a separate commit protocol.

## Try the local crash challenge

Prerequisites:

- Python 3.11 or newer
- Docker with the Compose plugin

From this directory, run:

```bash
python -m pip install -r requirements.txt
python -m scripts.setup_local_lab
```

No Solari account or API key is required. The first Odoo initialization can
take several minutes. A successful run ends with one incomplete database
rejected, one balanced database accepted, and `RESULT: PASS`.

The setup is fail-closed: it reuses an already-correct lab, but refuses to
overwrite an ambiguous or non-clean canonical database.

Open <http://localhost:8069> to inspect the local Odoo instance. The lab login
is `admin` / `admin`; these synthetic credentials are intentionally non-secret
and must not be reused outside this contained environment.

To rerun only the interrupted-versus-valid comparison:

```bash
python -m scripts.compare_live_states
```

To stop the local services:

```bash
docker compose down
```

## How acceptance works

```text
clean snapshot
      |
      v
disposable Odoo branch <-- visible GUI worker
      |
      v
immutable candidate snapshot --> fresh read-only auditor
      |
      +-- all invariants + lineage + receipt pass --> durable template
      |
      `-- missing, invalid, or uncertain evidence ---> no promotion
```

The auditor never inspects the worker's still-changing VM. It starts from the
candidate snapshot and queries PostgreSQL read-only. The selector requires the
expected case digest, fault-schedule digest, action-log digest, oracle version,
canonical lineage, and a receipt bound to the candidate snapshot. This ordering
prevents a check-then-change race: the snapshot inspected is the snapshot
eligible for promotion.

The current oracle requires, as applicable:

1. exactly one purchase order with the expected supplier, product, quantities,
   price, currency, and taxes;
2. the correct completed receipt and no unintended stock moves;
3. exactly one correctly linked and posted vendor bill;
4. balanced journal entries, expected tax lines, and the correct payable;
5. exactly one correctly reconciled payment when payment is allowed; and
6. a complete execution receipt with exact input, fault, lineage, and snapshot
   bindings.

Any missing relation, duplicate object, wrong value, oracle error, or incomplete
receipt is a rejection.

## Verify the published evidence

The frozen final campaign completed all six held-out positions with **zero
invalid states accepted**. Four valid states were accepted, two invalid states
were refused, and all eight attempts were retained. The two extra attempts were
Chrome failures before login and before any business mutation; no
post-mutation attempt was retried.

The evidence verifier works offline and does not require a Solari key:

```bash
python -m scripts.verify_final_evidence
```

Run the unit test suite with:

```bash
python -m unittest discover -v
```

It recomputes the case generation, protocol and report digests, frozen source
and dependency hashes, attempt hashes, retry rules, and acceptance outcomes.
The published result is adversarial verification from the original
implementation environment, not an independent replication.

For the result matrix and a short guided review, see
[final-results.md](docs/final-results.md) and
[evidence-walkthrough.md](docs/evidence-walkthrough.md).

## Run against Solari

The repository includes the orchestration, adapter, remote worker, audit, and
evidence-generation code used for the live campaign. To run new Solari trials,
copy `.env.example` to `.env`, supply your own `SOLARI_API_KEY`, and rebuild the
canonical Odoo runtime and database artifacts with the scripts in `scripts/`.

> [!WARNING]
> Live campaign scripts create Solari sandboxes, desktops, snapshots, and
> templates and can consume billable account resources. Review their CPU,
> memory, disk, and timeout settings before running them, and confirm cleanup in
> the Solari console after an interrupted run.

> [!NOTE]
> The live-campaign adapter targets the pinned Solari Python SDK 0.2.0. It
> isolates a small compatibility layer that uses the SDK's private `_hooks` and
> `_request` members because the required desktop-from-snapshot and promotion
> operations were not exposed by the typed client in that version. Treat the
> live path as a version-pinned reference implementation and review
> `forklift/solari_adapter.py` when upgrading the SDK. The local lab and offline
> evidence verifier do not use these private paths.

The committed evidence intentionally excludes temporary signed URLs, local
credentials, and bulky development artifacts. Raw receipts retain Solari
resource IDs because they are part of the snapshot-lineage bindings; no API
keys or signed preview/control URLs are included. These omissions do not affect
offline verification of the published result.

## Adapt the pattern

The Odoo implementation is an example, not a universal transaction layer. To
adapt it to another workflow:

- replace `forklift/gui_worker.py` with the visible-computer task;
- model the expected outcome in `forklift/domain.py`;
- replace `forklift/odoo_sql.py` and `forklift/oracle.py` with read-only,
  domain-specific checks;
- keep the snapshot-lineage and receipt checks in `forklift/promotion.py`; and
- add both valid controls and realistic fault cases before relying on the gate.

If the workflow can trigger external effects, design their commit boundary
explicitly rather than assuming a VM snapshot can reverse them.

## Documentation

- [Architecture](docs/architecture.md)
- [Design rationale](docs/design-rationale.md)
- [Validation protocol](docs/validation-protocol.md)
- [Final results](docs/final-results.md)
- [Development results](docs/development-results.md)
- [Evidence walkthrough](docs/evidence-walkthrough.md)
- [Validation receipt](docs/validation-receipt.md)
- [Observed failure mode](docs/failure-mode.md)

The example is covered by the repository's MIT license.
