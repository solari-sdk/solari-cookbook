# Live qualification history

## Attempt 1 — FAIL: platform/apparatus boundary

During a separate maximum-stretch qualification, the documented Volume creation endpoint returned HTTP 501 in this test environment. The safety apparatus stopped before creating other resources because resource existence could not be established. Volume is therefore treated here as an optional backend with a recorded live platform boundary, not as a requirement for the Project Continuity Layer.

The original UNKNOWN ledger remains unchanged. No resource identity was returned, so Volume absence or cleanup is not confirmed. Core continuity, Desktop and Browser were NOT_EXECUTED; this does not establish their failure. Attempt 1 archive SHA256: B4636AE20DC0D39CD41FCF1A1494072A0D6F83EABB3F70DBAAACD60617D92354.

## Attempt 2 — PARTIAL: useful live continuity core

Three distinct Sandboxes shared one checkpoint across sequential workers. B re-observed unchanged state; C re-observed a bounded change. Prior support for that change was rejected as current. Reconciliation returned CONFLICT_REQUIRES_REOBSERVATION, with no canonical winner. All three Sandboxes were killed and then returned structured HTTP 404. The application-owned contextual API supplied this behavior; it is not a native Solari method.

One Desktop was created and confirmed absent after cleanup, but no screenshot was produced. The harness discarded the operation error detail; the failing readiness/display/screenshot stage is unknown. One Browser launch was attempted but the operator HTTP observer incorrectly parsed its empty POST body before dispatch. The HTTP ledger has no Browser request; offline reproduction with the installed SDK confirms this local apparatus defect. No Browser was created, no DOM evidence exists, and no retry was made. The original UNKNOWN Browser ledger is preserved alongside this adjudication.

No Volume or Snapshot request occurred. Volume remains BLOCKED_PLATFORM_RUNTIME based solely on Attempt 1. Routing reached Sandbox observation; Desktop and Browser routes did not produce evidence. The deterministic map recognizes Volume without dispatch and rejects unsupported requirements. Cross-primitive evidence remains PARTIAL because live artifacts are Sandbox-only. Desktop and Browser adapters remain PROTOTYPE — STATIC with failed live qualification attempts. Semantic Lease is KILLED.

The fixture observes three selected files, not arbitrary repository behavior. Byte observations do not establish behavioral correctness or execution authority. All authority remains false; envelopes retain primitive identity and currentness limits. No external model provider is used. See the two sanitized evidence summaries for exact identities, hashes, classification and cleanup.
