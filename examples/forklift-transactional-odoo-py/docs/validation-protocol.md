# Validation protocol

> [!IMPORTANT]
> This protocol documents the historical oracle-v1 campaign preserved in
> `artifacts/sealed/final-v2/`. It does not cover the post-campaign oracle-v2
> implementation in the working repository.

This document is a readable summary of the validation design. The authoritative
machine-readable final protocol is
`artifacts/sealed/final-v2/protocol.json`; its digest and all result identities
are listed in [final-results.md](final-results.md).

## Question

When the same fallible GUI worker faces the same Odoo purchase-to-pay cases and
faults, does branch isolation plus a separate semantic oracle eliminate invalid
promotions without collapsing into "reject everything"?

## Units and outcomes

One trial is one held-out purchase case applied to one canonical snapshot. The
baseline mutates one copy directly. Forklift receives one disposable candidate
from the same snapshot and budget. A trial outcome is classified from database
evidence, never from the worker's status message:

- **valid promotion**: the promoted branch satisfies every frozen invariant;
- **false acceptance**: any promoted branch violates at least one invariant;
- **safe refusal**: nothing is promoted and the canonical snapshot is intact;
- **false refusal**: a fault-free trial had enough budget but no valid promotion;
- **boundary breach**: any effect escaped the contained VM boundary.

Each candidate is snapshotted before inspection. A separate auditor VM is
forked from that immutable candidate snapshot, and the oracle runs only there.
Promotion means registering the exact oracle-inspected snapshot as a durable
Solari template. A parent-lineage mismatch or candidate-snapshot/receipt
mismatch is a hard rejection.

## Case strata

The generator balances full receipts, partial receipts with an open backorder,
and zero receipts where billing/payment is forbidden. It crosses these with
whole and fractional quantities, decimal unit prices, currency rounding edges,
tax rates including zero and fractional percentages, and unique/repeated-looking
vendor references. Master data are synthetic. No real vendor, payment account,
email endpoint, or bank rail is connected.

The generator is deterministic from a seed committed by SHA-256 before the
run. Receipts bind the canonical JSON case digest, and the campaign binds the
ordered manifest digest. The seed was withheld from the worker during execution
and revealed only after the terminal report was sealed. It is now published in
`artifacts/sealed/final-v2/seed-reveal.txt` for reproducibility.

## Fault strata

The schedule is selected before a branch starts and is immutable during that
run. Development includes worker kills after PO confirmation, receipt
validation, and bill posting; browser death during quantity entry; duplicated
receipt/payment submission; a wrong quantity; a one-cent price mutation; and a
timeout while the payment dialog is open. Clean controls are interleaved.

Schedules are assigned to case positions before execution. Clean positions test
liveness; faulted positions test either safe refusal or valid idempotent
recovery. The injector may not read or modify oracle code, database-query code,
the expected case, or another branch. A failure proven to occur before the
first business mutation may receive a bounded fresh infrastructure retry; every
attempt is retained. Post-mutation retries are separate trials, never erased
attempts.

## Precommitted gates

The candidate fails immediately if:

1. even one invalid state is promoted;
2. even one effect escapes the snapshotted VM boundary;
3. any seeded invalid counterexample is accepted by the oracle; or
4. a missing/errored oracle result can reach the promoter as success.

After those hard gates, report clean-case valid-promotion rate, faulted-case
recovery rate, safe-refusal rate, latency, branch count, and resource use. Do
not hide refusals inside an aggregate success score. The baseline comparison
reports persistent invalid-state frequency after every injected interruption.

The final trial count, retry policy, stop rules, and resource cap were fixed
before final evidence was opened. The run allowed no plan change, balance
top-up, or automatic overage.

## Evidence handling

Development artifacts were kept separate from the untouched final output
directory. Every final attempt was retained, including infrastructure failures.
The published verifier checks the revealed seed, generated cases, protocol,
source and dependency hashes, raw attempts, retry boundary, and report digest.

The final campaign was run in the original implementation environment. It is
therefore described as adversarial verification, not independent replication.
Independent replication would require a separate implementation or evidence
custodian to repeat the protocol.
