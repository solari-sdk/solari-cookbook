# TODO — Solari OSINT Operations Center

Status: active development  
Branch: `develop`

> Root action/remediation tracker for the public Solari OSINT Operations Center. Completed work before this reconciliation remains preserved in Git history, implementation tests, `meta.md`, `sources.md`, and project documentation. In accordance with the Prime Prompts TODO standard, this file now emphasizes unresolved work instead of retaining hundreds of historical completed boxes.

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
- [x] `sources.md` documents access mode, cadence, bounds, schema/provenance, interpretation limits, terms/attribution, and live-test state for the new GTFS and SPC adapters.
- [x] `meta.md` and source registry were reconciled with the current adapter/workflow/Solari execution state.

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

## Public source expansion
- [ ] Add lawful free/open public internet-health/outage telemetry if a suitable source with acceptable access/reuse terms is identified.
- [ ] Add public airport/airspace operational-status data beyond weather observations without inferring status from METAR data.
- [ ] Add public vessel/port status data that does not require restricted credentials or prohibited redistribution.
- [ ] Continue adding additional lawful free/open sources when they materially broaden the showcase and have defensible provenance/terms.

## Dashboard / visualization
- [ ] Add a raw-source/raw-acquisition view that preserves the observed-vs-normalized boundary without rendering active source content unsafely.
- [ ] Add cost telemetry only when Solari/provider billing or job-cost data are available through a defensible interface.
- [ ] Add optional 3D globe/terrain visualization for global situational awareness.
- [ ] Synchronize selection state between 2D and future 3D views.
- [ ] Add public satellite orbital/TLE visualization using a defensible propagation/epoch model rather than plotting orbital elements as fake current coordinates.

## Evidence vault / raw acquisition
- [ ] Wire immutable HTML/text raw capture retention to all applicable server collectors; current content-addressed raw/archive primitives and Solari execution artifacts do not yet cover every direct API/feed collector payload.

## Reconnaissance / document processing
- [ ] Demonstrate PDF metadata/text extraction inside live Solari Sandbox; bounded local PDF metadata extraction already exists.
- [ ] Add an OCR pipeline for lawful public/user-supplied evidence with explicit size/type/resource bounds.
- [ ] Add QR/barcode extraction for lawful public/user-supplied evidence with explicit size/type/resource bounds.

## Debugging / observability
- [ ] Add queue/job timing telemetry if/when a persistent distributed queue is introduced.
- [ ] Add persistent queue depth and worker-utilization telemetry if/when background workers are introduced.
- [ ] Add remote Solari Browser/Sandbox/Desktop resource-leak detection validated against real provider sessions.
- [ ] Add cost-per-job/source telemetry when provider data make this possible without guessing.

## Static / no-hosting mode
- [ ] Converge static-local and FastAPI/server modes onto one backend-independent frontend; today they share contracts/portable data but remain separate frontends.
- [ ] Generate/consume one shared domain/data contract across static and server modes rather than maintaining aligned-but-separate implementations.
- [ ] Verify Solari API browser/CORS/client support before claiming direct static Solari operation.
- [ ] Add direct static Solari Browser orchestration if provider browser/CORS support permits it safely.
- [ ] Add direct static Solari Sandbox orchestration if provider browser/CORS support permits it safely.
- [ ] Add direct static Solari Desktop orchestration if provider browser/CORS support permits it safely.

## Packaging / deployment
- [ ] Add optional PostgreSQL backend for larger/shared deployments when the SQLite boundary becomes insufficient.
- [ ] Add optional Redis queue/cache for concurrent/distributed jobs when justified by deployment requirements.
- [ ] Introduce a broader database migration framework if schema evolution outgrows the current bootstrap/versioned migration approach.
- [ ] Add a background worker process for durable asynchronous jobs.
- [ ] Add a scheduler process for durable scheduled workflows/collections.

## Cross-platform setup/update validation
- [ ] Test a fresh Linux checkout through the documented root updater.
- [ ] Test repeat/idempotent Linux update behavior.
- [ ] Test a fresh Windows checkout through `update.ps1`.
- [ ] Test repeat/idempotent Windows update behavior.
- [ ] Test a fresh macOS checkout through `update-macos.sh`, or document honestly if no macOS validation environment is available.

## Tests / QA
- [ ] Run live smoke tests against representative public sources and record endpoint/date/result without treating network failure as empty data.
- [ ] Run Solari Browser integration tests with a live evaluator/user key.
- [ ] Run Solari Sandbox integration tests with a live evaluator/user key.
- [ ] Run Solari Desktop integration tests with a live evaluator/user key.
- [ ] Add browser UI smoke tests for the server dashboard.
- [ ] Complete an accessibility pass.
- [ ] Complete a performance pass with representative retained-event/artifact volume.
- [ ] Validate remote Solari cleanup/resource-leak behavior with real provider sessions.
- [ ] Add a first-run static browser test with no backend process available.
- [ ] Add real-browser IndexedDB persistence/migration tests.
- [ ] Add real-browser credential/session purge tests.
- [ ] Add browser capability/CORS/broker-fallback integration tests.

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
- Windows and macOS updater validation require those operating-system environments; live browser QA requires a browser-capable test environment.

## Maintenance
- **TODO last reviewed:** 2026-09-01
- **Reviewed with `meta.md`:** Yes
- **Reviewed with `sources.md`:** Yes
- **Prime Prompts revision reviewed:** `0c499baad9f2b8dcf42e78deb6086174d000a90f`
- **Prime Prompts TODO standard:** completed tasks may be removed when their history is preserved elsewhere; unresolved findings remain visible until remediated, explicitly accepted as an exception, or determined not applicable.

## Definition of ready
The project is ready only when the major dashboard and operations surfaces work, representative open sources are live-validated, all three Solari products have meaningful tested roles, setup is reproducible, evidence is human-verifiable, tests are green, remote resource cleanup is proven, the documented static/no-hosting workflows operate without an application server, and the public repository has passed the final privacy/secret/proprietary-material review.