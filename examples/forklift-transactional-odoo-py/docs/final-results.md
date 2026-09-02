# Sealed final result

Forklift passed its frozen final campaign: **6/6 audited positions completed,
0 invalid states accepted, and all 8 attempts preserved**. Two extra attempts
were real Chrome crashes before login; both were retained as inconclusive
infrastructure failures and retried only because no business mutation had
occurred. No post-mutation attempt was retried.

| Position | Hidden regime | Intentional fault | Required outcome | Result |
|---:|---|---|---|---|
| 1 | zero receipt | none | accept valid PO-only state | accepted after one preserved pre-mutation crash |
| 2 | partial receipt | none | accept correct receipt, bill, and payment | accepted |
| 3 | full receipt | none | accept correct receipt, bill, and payment | accepted |
| 4 | zero receipt | one-cent wrong unit price | refuse on price invariant | refused: `po-unit_price` |
| 5 | partial receipt | kill worker after receipt | refuse missing downstream bill | refused: `bill-count`, after one preserved pre-mutation crash |
| 6 | full receipt | duplicate payment submission | accept exactly one valid payment | accepted |

The final seed, six case files, schedule digests, code hashes, exact host and
remote Python distributions, thresholds, retry rules, and zero-additional-
spend cap were committed before execution. The seed was revealed only after
the terminal report was written, so anyone can now regenerate the cases and
check the commitment.

Run the offline verifier:

```bash
python -m scripts.verify_final_evidence
```

It recomputes the protocol digest, all frozen code and dependency hashes, every
case from the revealed seed, every attempt hash, all acceptance/refusal rules,
the retry boundary, the report digest, and the zero-false-acceptance gate.

## Evidence identities

- protocol digest: `f77b1b4e101d24c720a26cdc9b9dbce877fb553747967b72c978cf5c7101531e`
- protocol file SHA-256: `11f7a91e666005a8aeb8112d1c5669cacbd972e78f7b3ce80d1fe09c6d0a5421`
- final report SHA-256: `4f9e1ccf0c49897afc9dc350d0e157a7b123c98944c784949ea29b15d396bb2b`
- revealed-seed SHA-256: `0570277009a174d410255ce7c1f3c02d87773cd5c7940a96c2b51f19734dd0c5`

This is adversarial verification from the original implementation environment,
not independent replication. The exact claim is limited to the frozen
Odoo/PostgreSQL state and oracle. Real bank transfers, emails, and facts outside
oracle v1 are excluded.

## Why the comparison matters

On the same 16 audited developmental GUI trials, a matched “trust the worker's
completion signal” baseline accepted 3 invalid states. Forklift accepted 0.
An accepted development snapshot was also promoted to a durable Solari
template, booted as a new sandbox, and re-audited with an identical all-pass
verdict. This shows both sides of the mechanism: bad work does not escape, and
good work can become the durable result.
