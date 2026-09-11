# Integrated R2 live plan — NOT EXECUTED

Status: PROTOTYPE — STATIC. One reviewed run owns all resources through StretchHarness. No CLI runs it automatically. No SDK request is made by importing the harness. Independent review and a fresh explicit authorization are required before live invocation.

| Case | Question | Resources | PASS condition | Failure classification | Cleanup and output |
| --- | --- | --- | --- | --- | --- |
| S1 | Can C0 seed independent current and divergent workers? | A, B, C: three Sandboxes total | A terminal before B; B terminal before C; three IDs; same parent; B unchanged; C changed | FAIL or NOT_EXECUTED; never replacement create | Kill acknowledgement plus get gone/structured 404; preserve handoff and branch receipts |
| S2 | Do incompatible support bytes refuse agreement? | Reuse B/C evidence | CONFLICT_REQUIRES_REOBSERVATION; authority false | FAIL if manufactured agreement | No resources; reconciliation result retained |
| S3 | Can artifacts outlive their producer? | One Volume attached to A then B/C | A writes deterministic artifact; A terminal; B reads identical digest; currentness remains NOT_ESTABLISHED | BLOCKED_PLATFORM_RUNTIME on actual 501; FAIL on tamper/unknown cleanup | Delete only after workers terminal, then confirm get 404; record producer ID/evidence ID, volume/path/hash and retrieval envelope |
| D1 | Can the Desktop route capture bounded GUI evidence? | One Desktop | Create with documented GUI template default; verify native health ready/display/vnc; set 800x600 display; capture one native screenshot and hash exact bytes | GUI readiness or screenshot failure is FAIL; no replacement | Kill/get confirmation; screenshot plus DESKTOP envelope; pixels do not establish semantic truth |
| B1 | Can the official Browser observe deterministic content? | One Browser | newPage, setContent of bundled inline HTML, exact title check, DOM envelope | Launch/connection uncertainty or cleanup failure is FAIL; no replacement | BrowserSession.close waits for release; Solari.close closes local transport; store no endpoint/token |
| R1 | Do typed requirements choose the intended primitive? | Reuses S1/S3/D1/B1 | All four fixed routes observed; no planner or optimization claim | PARTIAL if a route unavailable; unknown requirement UNSUPPORTED | Route outcomes share the above evidence |

STRETCH_LIVE_MAX_SANDBOXES = 3
STRETCH_LIVE_MAX_DESKTOPS = 1
STRETCH_LIVE_MAX_BROWSERS = 1
STRETCH_LIVE_MAX_VOLUMES = 1
STRETCH_LIVE_MAX_SNAPSHOTS = 0

The lifecycle hook runs artifact production/retrieval before existing worker cleanup. No extra worker is needed. A/B/C are sequential; the plan does not assume a concurrency entitlement.

Use officialClients with only SOLARI_API_KEY. The compute fetch guard counts every creation HTTP dispatch, blocks repeated idempotency keys and all snapshot routes. Browser maxAttempts=1 and launch retries=0 prevent replacement attempts. An uncertain creation stops further resources and remains UNKNOWN in the ledger, never terminal. Browser launch can fail after internal session creation; the SDK's failure-path fire-and-forget release is not accepted as confirmed cleanup. Such a run must retain UNKNOWN and stop; no retry or success claim is allowed.

Caller obligations before dispatch: create an exclusive attempt lock atomically, persist the ledger synchronously before each creation, and securely persist the returned report/artifact bytes. Do not log credentials, browser endpoints or SDK error bodies. The harness takes explicit callbacks for these local operations; no existing attempt lock is opened by this static pass. A supervisor must retain unresolved records if the process exits unexpectedly. SDK connection operations can outlast individual HTTP timeouts; an external wall-time stop must be treated as unresolved cleanup, not proof of termination.

Future live verdicts: PROVEN_LIVE, PARTIAL, BLOCKED_PLATFORM_RUNTIME, UNSUPPORTED, FAIL, NOT_EXECUTED. Controlled local runs are tagged CONTROLLED_STATIC and never produce PROVEN_LIVE. Static protocol success is carried by assertions and test output, not relabeled as cloud evidence.

R2 includes an explicit runLiveStretch entry and attemptStore implementation: exclusive wx lock, atomic ledger replacement, digest-named artifact files and a structured result. Tests exercise the store only in disposable local fixture directories. No actual live-attempt lock was consumed. The live output directory must remain fixed across attempts; changing it is not an authorized retry.

Final apparatus correction: D1 establishes BOUNDED_GUI_OBSERVATION_OCCURRED only. No shell painting command or utility dependency is used. Official Desktop documentation lists template default and native health/display/screenshot APIs: https://docs.getsolari.com/sdk/typescript/vms . Real installed Sandbox/Core 0.1.3 requests are exercised through injected fake fetch. Volume creation uses POST /volumes with an SDK-generated Idempotency-Key; the existing guard remains strict and unchanged.


## One-time live qualification: FAIL

The accepted 125-test candidate made one Volume create request on 2026-09-11 UTC. The endpoint returned HTTP 501. SDK retry handling obscured that response from the harness, which preserved UNKNOWN and stopped. No Sandbox, Desktop, or Browser was dispatched; no checkpoint, fork, reconciliation, screenshot, DOM, or persistence evidence was produced. Persistent Evidence Cache is BLOCKED BY CURRENT LIVE PLATFORM BEHAVIOR. All other stretch live capabilities are NOT_EXECUTED; their implementation remains PROTOTYPE — STATIC. Semantic Lease is KILLED. No Volume identity was returned, so cleanup/absence is unconfirmed and explicitly accounted for. There was no replacement attempt. This failure does not invalidate or extend the older demo evidence. Publication of this stretch is withheld.


## Historical successor disposition

Attempt 2 completed with PARTIAL; three Sandboxes and one Desktop, all confirmed terminal; Browser blocked locally before HTTP dispatch. Volume was disabled in the harness and HTTP guard. No retries or further live execution are authorized by this completed plan. See [live qualification](live-qualification.md).
