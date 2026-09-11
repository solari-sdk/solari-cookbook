# Historical evidence summaries

Each JSON file is a small, whitelisted summary of authoritative recorded integration artifacts. It contains the experiment question, bounded observations, a negative/caveat result, non-claims, exact source SHA256 values, JSON pointers, and relative internal artifact identifiers. Private absolute paths, session identifiers and raw research payloads are omitted.

The source logs remain private. Their hashes establish which inputs were used, not independent public verification of unpublished data. The review packet retains the internal source map. These summaries do not certify the newly extracted application; its separate live smoke is pending.

- [R1: continuity after destruction](R1_SUMMARY.json)
- [R1C: reject stale currentness](R1C_SUMMARY.json)
- [R2: complementary persistence primitives](R2_SUMMARY.json)


## One-time live qualification: FAIL

The accepted 125-test candidate made one Volume create request on 2026-09-11 UTC. The endpoint returned HTTP 501. SDK retry handling obscured that response from the harness, which preserved UNKNOWN and stopped. No Sandbox, Desktop, or Browser was dispatched; no checkpoint, fork, reconciliation, screenshot, DOM, or persistence evidence was produced. Persistent Evidence Cache is BLOCKED BY CURRENT LIVE PLATFORM BEHAVIOR. All other stretch live capabilities are NOT_EXECUTED; their implementation remains PROTOTYPE — STATIC. Semantic Lease is KILLED. No Volume identity was returned, so cleanup/absence is unconfirmed and explicitly accounted for. There was no replacement attempt. This failure does not invalidate or extend the older demo evidence. Publication of this stretch is withheld.


## Successor qualification

[Attempt 1](CONTINUITY_NATIVE_ATTEMPT1_SUMMARY.json) preserves the Volume HTTP 501/global-stop discovery. [Attempt 2](CONTINUITY_NATIVE_ATTEMPT2_SUMMARY.json) records PARTIAL: live continuity and conflict refusal, terminal Sandbox/Desktop resources, failed Desktop observation and Browser pre-dispatch apparatus failure. No Volume retry occurred. The original Attempt 1 artifact remains immutable.
