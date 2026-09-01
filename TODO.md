# TODO — Solari OSINT Operations Center

Status: active development  
Branch: `develop`

> Root action/remediation tracker for the public Solari OSINT Operations Center. Completed work before this reconciliation remains preserved in Git history, implementation tests, `meta.md`, `sources.md`, and project documentation. In accordance with the Prime Prompts TODO standard, this file emphasizes unresolved work instead of retaining hundreds of historical completed boxes.

## Submission objective
Build and publicly demonstrate a comprehensive OSINT operations center that uses Solari Browser, Sandbox, and Desktop for legitimate public-source acquisition/processing workflows and shows production-minded evidence handling, observability, debugging, visualization, static/no-hosting operation, and cross-platform reproducibility.

## Verified completions — 2026-09-01 reconciliation
- [x] Browser session recording implementation supports requested recordings and catalogs retained replay artifacts; live provider validation remains a separate integration-test gate.
- [x] Browser executions are surfaced in the operations/debug UI with status/session/recording/replay/artifact references.
- [x] Sandbox executions are surfaced in the operations/debug UI with results, diagnostics, timing, and artifact references.
- [x] A legitimate public-HTTPS screen-driven Solari Desktop workflow is implemented with session lifecycle, readiness, mouse click, keyboard input, screenshot capture, cleanup, and explicit interpretation boundaries.
- [x] Desktop screenshot evidence is normalized into the common acquisition/event/evidence model.
- [x] Desktop executions are surfaced in the operations/debug UI.
- [x] Public GTFS/transportation baseline implemented through bounded MBTA static GTFS route/schedule ingestion with archive safety checks and explicit `schedule_only` semantics.
- [x] Public storm-observation baseline implemented through bounded NOAA/SPC preliminary hail-report ingestion with 1200 UTC convective-day semantics and no warning/damage inference.
- [x] Dashboard exposes Browser/Sandbox/Desktop execution views and screenshot/session-recording artifact references through the mounted Solari execution APIs.
- [x] Visual node-graph workflow builder supports bounded add/remove/dependency editing, validation, execution, and current-data rerun without evaluating untrusted expressions.
- [x] One-click workflow rerun against current persisted public-source data is implemented in the workflow UI/API.
- [x] Screenshot artifact retention is wired to browser/Desktop Solari executions through the content-addressed artifact catalog.
- [x] Browser recording artifact retention is wired to recorded browser executions.
- [x] Sandbox output artifact retention is wired to execution transcripts/results.
- [x] Desktop screenshot artifact retention is wired to Desktop executions; video retention is not claimed because the current workflow uses screenshots.
- [x] Production FastAPI entrypoint route regression coverage verifies nested jobs/Solari/workflow router aggregation without duplicate direct mounts.
- [x] Fixture normalization coverage now includes MBTA static GTFS and NOAA/SPC preliminary hail adapters in addition to the previously implemented public adapters.
- [x] `sources.md` documents access mode, cadence, bounds, schema/provenance, interpretation limits, terms/attribution, and live-test state for the GTFS and SPC adapters.
- [x] `meta.md` and source registry were reconciled with the adapter/workflow/Solari execution state at that checkpoint.
- [x] Dashboard includes a safe raw-acquisition metadata inspector that preserves the raw-vs-normalized boundary without rendering source response bodies as active content.
- [x] Dashboard includes a dependency-free orthographic 3D globe for global situational awareness.
- [x] 2D/3D analyst selection is synchronized through event-stream/map/globe/evidence/graph pivots, including globe-to-Leaflet recentering and 2D event selection-to-globe focus.
- [x] Public weather-satellite orbital visualization uses retained CelesTrak general-perturbations elements with a bounded ±24-hour two-body Kepler approximation, explicit epoch handling, and a visible warning that it is not SGP4 or operational navigation data.
- [x] Static and server modes share a generated domain-contract manifest derived from the server Pydantic models; the static console validates/consumes the checked-in contract and tests fail on model/manifest drift.
- [x] A durable local SQLite task queue provides atomic claims, bounded payloads/results, retry state, schedule-slot deduplication, worker heartbeats, queue wait/runtime telemetry, and read-only API visibility without claiming distributed-queue semantics.
- [x] A separate background worker process executes durable registered-public-source collection and bounded declarative workflow tasks.
- [x] A separate scheduler process persists interval schedules and enqueues due public-source/workflow tasks with slot-level deduplication and missed-interval catch-up bounds.
- [x] Persistent local queue depth, active/busy worker counts, utilization, oldest-pending age, queue-wait timing, and run-duration timing are exposed through API/SSE telemetry.
- [x] Georgia Tech IODA country-level outage-alert telemetry is implemented and registered with a bounded six-hour/300-alert/2 MiB acquisition window, deterministic normalization/tests, and an explicit detector-signal/no-cause/no-impact interpretation boundary.
- [x] Real Chromium CI covers the server dashboard with page-error detection plus static no-backend first run, IndexedDB v1-to-v3 migration/persistence, credential/session non-persistence and clear behavior, and explicit direct-network/CORS-failure broker fallback.
- [x] Browser QA identified and fixed a production classic-script `refresh`/`collect` identifier collision in the dashboard correlation controls; exact-head CI was green after the correction.
- [x] Cross-platform updater verification passed on clean GitHub-hosted Ubuntu, Windows, and macOS runners, including fresh and repeat/idempotent updater executions on all three platforms.

## Verified completions — 2026-09-02 autonomous pass
- [x] Added and registered a bounded FAA National Airspace System airport-operational-status adapter using the official machine-readable airport-status endpoint, hardened XML parsing, deterministic identities, explicit source wording/provenance, and no status/geolocation inference from METAR data.
- [x] Added and registered a bounded U.S. Coast Guard Navigation Center port-status adapter using exact published COTP-zone allowlisting, table/header validation, deterministic identities, date-only timestamp provenance, and no vessel/geolocation inference.
- [x] Added bounded local OCR for lawful public/user-supplied images through an already-installed Tesseract engine: 10 MiB/20-million-pixel input limits, 1–30 second timeout, language-selector validation, no shell execution, temporary decoded-PNG boundary, and capped returned text.
- [x] Added bounded QR/common-barcode extraction through headless OpenCV with the same image limits, exact-result deduplication, a 100-result cap, inert decoded values, and a real generated-QR regression fixture.
- [x] Completed a practical accessibility engineering pass over both reviewer-facing web surfaces with automated landmark/control/visualization naming checks, explicit high-visibility keyboard focus treatment, and reduced-motion handling. This is not represented as third-party accessibility certification.
- [x] Completed a representative retained-data performance regression pass covering 5,000 normalized events and 300 content-addressed artifacts with deliberately generous CI acceptance ceilings rather than precision benchmark claims.
- [x] Ran and documented representative unauthenticated live public-source smoke checks for USGS earthquakes, NOAA SWPC products, and NOAA NDBC latest observations. Unsupported validation-client content types/fetches are recorded as tooling/network failures rather than empty source data.
- [x] Verified the current official Solari client model before making direct-static claims. The published Browser/Sandbox TypeScript examples are Node/process-environment clients, Browser maintains a Node-side loopback proxy, and Desktop is documented through a process-environment client; no browser-script/short-lived browser credential flow is published. Direct static Browser/Sandbox/Desktop orchestration is therefore not applicable under the currently documented provider client/security model; static mode uses public CORS sources plus optional narrow broker/server delegation instead of exposing a durable provider key.
- [x] All registered server public-source adapters now use a registry-level immutable raw-response retention boundary. Direct `urlopen` collectors and the allowlisted WZDx explicit-opener path retain exact bytes consumed by the collector in the SHA-256 raw archive, verify single-response digests against the acquisition envelope, expose safe digest/size/status/content-type references, and are covered by registry-wide and deduplication/integrity tests.
- [x] Reconciled speculative scale-out dependencies against measured/current deployment needs. PostgreSQL, Redis/distributed queue infrastructure, a broader migration framework, distributed-queue telemetry, and provider cost telemetry now have explicit evidence-based reopen triggers in `docs/server-scaling-design.md` instead of remaining active implementation boxes without a demonstrated requirement.
- [x] Current code/test batch passed GitHub CI on `develop` at commit `c04ef8713db1f24d3845286e384ad5476b0833cb`, including Python tests, dependency-free static-console tests, real Chromium QA, and the public-release secret-pattern scan. Subsequent raw-retention commits are required to pass the same exact-head CI gate before this pass is considered settled.
- [x] Converged static-local and FastAPI-backed operation onto the same checked-in `static-console/` analyst frontend. FastAPI mounts it unchanged at `/workspace/` and redirects `/` there; a path-scoped runtime adapter synchronizes normalized server events/entities/relationships/evidence/acquisitions/source-health state into the same IndexedDB or memory-only workspace and exposes registered-source collection controls. Standalone static hosting performs no FastAPI discovery request. The pre-existing rich server-only operations UI remains available at `/server-dashboard` rather than being discarded.
- [x] Hardened the converged service-worker boundary so dynamic `/api/` responses are never shell-cached, added dependency-free runtime-normalization/UI-contract tests plus FastAPI route/asset identity tests, and extended real Chromium QA to prove both standalone no-backend behavior and FastAPI-backed canonical-workspace behavior. Exact-head CI passed at `a2d1b4cda01340c834f07f3bda474deb49f08139` with Python tests, static-console tests, Chromium QA, and the public-release scan all green.

## Governance / public-release boundary
- [ ] Create/synchronize the central Prime Prompts TODO mirror. **Blocked by current single-repository scope unless cross-repository authorization is explicitly granted.**
- [ ] Add this repository to the applicable Prime Prompts work-repository registry. **Blocked by current single-repository scope unless cross-repository authorization is explicitly granted.**
- [ ] Perform the final semantic public-release review for private names, unrelated project/company identifiers, credentials, proprietary material, restricted data, and other disclosure issues immediately before submission/release.

## Solari Browser
- [ ] Demonstrate a JavaScript-heavy public source with live Solari Browser credentials.
- [ ] Demonstrate stateful browser profile/session use where lawful and useful.
- [ ] Demonstrate stealth/proxy capability against an appropriate public test/source without bypassing access restrictions.

## Solari Sandbox
- [ ] Demonstrate geospatial/enrichment computation inside the live Solari Sandbox; bounded deterministic geospatial program generation and unit coverage already exist.

## Public source maintenance
Additional lawful free/open sources may be added when they materially broaden the showcase and have defensible provenance/terms. The current autonomous expansion now includes event, disaster, environmental, transportation, storm, infrastructure/outage, aviation-operational, and maritime-port status families; do not add sources merely to inflate adapter count.

## Dashboard / visualization
Provider cost telemetry is intentionally conditional rather than an active repository-only TODO. Re-open it only when Solari or another provider exposes documented per-job/source billing data that can be recorded without estimation.

## Evidence vault / raw acquisition
Registered direct API/feed collectors now retain immutable content-addressed raw response bytes through the common registry boundary; see `docs/raw-acquisition-retention.md`. Browser/Sandbox/Desktop evidence continues through the existing artifact catalog.

## Reconnaissance / document processing
- [ ] Demonstrate PDF metadata/text extraction inside live Solari Sandbox; bounded local PDF metadata extraction already exists.

## Debugging / observability
- [ ] Add remote Solari Browser/Sandbox/Desktop resource-leak detection validated against real provider sessions.

Distributed-queue-specific capacity/timing telemetry is conditional on introducing a distributed queue. The current SQLite queue already exposes the relevant single-host queue timings and worker utilization. Provider cost telemetry follows the documented-provider-data trigger above.

Direct provider orchestration from the browser-only static console is intentionally not a current TODO: current official Solari client documentation does not provide a browser-targeted credential/client model that would make durable-key static execution a defensible design. Re-open that work only if the provider publishes explicit browser/CORS support with a safe credential model.

## Packaging / deployment
PostgreSQL, Redis/distributed queue infrastructure, and a broader migration framework are conditional scale-out options rather than current implementation requirements. `docs/server-scaling-design.md` records the existing single-host evidence and the exact architectural/deployment conditions that must be met before those items are reopened.

## Tests / QA
- [ ] Run Solari Browser integration tests with a live evaluator/user key.
- [ ] Run Solari Sandbox integration tests with a live evaluator/user key.
- [ ] Run Solari Desktop integration tests with a live evaluator/user key.
- [ ] Validate remote Solari cleanup/resource-leak behavior with real provider sessions.

## Documentation / submission
- [ ] Run and document the live demo scenario exercising Browser + Sandbox + Desktop with evaluator/user provider credentials.
- [ ] Capture reviewer-useful screenshots/GIF/video only after the corresponding live flows are verified.
- [ ] Perform the final end-to-end live test and complete every applicable gate in the submission checklist.

## External/manual blockers
The following unresolved work cannot be truthfully completed from repository-only automation:
- Live Solari Browser/Sandbox/Desktop validation requires evaluator/user-owned `SOLARI_API_KEY` access and explicit enablement.
- NASA FIRMS live validation requires an evaluator/user-owned FIRMS key plus bounded area configuration.
- ReliefWeb live validation requires an approved evaluator/user appname.
- Cross-repository Prime Prompts mirror/registry changes require explicit cross-repository authorization under the current scope rule.

## Maintenance
- **TODO last reviewed:** 2026-09-02
- **Reviewed with `meta.md`:** Yes — reconciled 2026-09-02.
- **Reviewed with `sources.md`:** Yes — no source-registry change was required for frontend convergence.
- **Prime Prompts revision reviewed:** `2766813375b227177e722c52498fc789a87ff7a0`
- **Prime Prompts TODO standard:** completed tasks may be removed when their history is preserved elsewhere; unresolved findings remain visible until remediated, explicitly accepted as an exception, or determined not applicable.

## Definition of ready
The project is ready only when the major dashboard and operations surfaces work, representative open sources are live-validated, all three Solari products have meaningful tested roles, setup is reproducible, evidence is human-verifiable, tests are green, remote resource cleanup is proven, the documented static/no-hosting workflows operate without an application server, and the public repository has passed the final privacy/secret/proprietary-material review.
