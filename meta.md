# Project Metadata

## Project
- **Project name:** Solari OSINT Operations Center
- **Repository:** `tocsindata/solari-cookbook`
- **Purpose:** Public engineering showcase and production-minded OSINT operations center demonstrating Solari cloud browsers, sandboxes, and desktops across lawful public-source acquisition, isolated processing, evidence preservation, visualization, observability, and debugging.
- **Status / lifecycle:** Active development
- **Work type:** Public engineering challenge / portfolio project
- **Information handling:** Public-source information only. Do not ingest private, proprietary, customer, FCI, CUI, classified, credentialed-private, or personally sensitive datasets.

## Repository
- **Repository URL:** https://github.com/tocsindata/solari-cookbook
- **Visibility:** Public
- **Primary branch:** `main`
- **Development branch:** `develop`
- **Upstream:** `solari-sdk/solari-cookbook`
- **Local source checkout:** User-defined; do not infer from repository name
- **Production URL:** Not assigned
- **Production deployment branch/ref:** Not selected
- **Deployment model:** Dual-mode: static/no-hosting browser analyst console plus optional FastAPI team/server mode

## Product Scope
1. **Browser acquisition:** dynamic public pages, browser state where permitted, screenshots/recordings, and browser-level evidence when a direct API/feed is insufficient.
2. **Sandbox processing:** isolated parsers, generated extraction code, document/data transforms, normalization, enrichment, and untrusted-input containment.
3. **Desktop workflows:** legitimate GUI/screen-driven public-source workflows that cannot be represented cleanly through an API or browser workflow.
4. **Evidence/provenance:** source identity, acquisition time, content hash where applicable, transformation state, and observed/transformed/inferred distinctions.
5. **Operations dashboard:** map/timeline/event/evidence/health/debug/export/API surfaces.
6. **Static/no-hosting mode:** browser-only analyst workspace using local browser storage, offline shell support, portable investigations, and direct CORS-enabled public sources without requiring an application server.

### Explicit exclusions
- No media-monitoring product or clone.
- No proprietary code, private source inventories, credentials, customer logic, private operational data, or unrelated identifying information.
- No FCI, CUI, classified, or otherwise restricted information.

## Current Architecture State
- **Server stack:** FastAPI + Pydantic + SQLite.
- **Static stack:** dependency-free HTML/CSS/ES modules + IndexedDB + Web Crypto + service worker/PWA shell.
- **Implemented public event/reference adapters:** USGS earthquakes, NWS active alerts, NOAA SWPC alerts, NOAA/NHC Atlantic-basin tropical cyclone RSS products, NOAA/NWS tsunami bulletins, OpenFEMA disaster declarations, GDACS multi-hazard events, CelesTrak weather-group orbital GP data, NASA FIRMS active-fire detections when user credentials/area are supplied, ReliefWeb disasters when an approved appname is supplied, OFAC SDN, USGS elevated-volcano status, NOAA NDBC environmental observations, USGS Water latest-continuous observations, EPA AirNow daily air-quality data, AviationWeather.gov METAR observations, FAA NAS airport operational-status events, an exact-host-allowlisted public WZDx work-zone feed, MBTA static GTFS planned-service routes, NOAA/SPC preliminary hail storm observations, Georgia Tech IODA country-level outage signals, U.S. Coast Guard Navigation Center port-status rows, and OpenStreetMap/Nominatim reference enrichment. Event adapters publish explicit capability/dependency descriptors and parser/record/response telemetry.
- **Source registration:** public collection adapters are centralized in `app.sources.registry`; duplicate source IDs fail at import instead of silently replacing one another.
- **Collection orchestration:** bounded concurrent multi-source collection with deterministic result ordering and per-source failure preservation; persistence remains serialized for auditability. Source runtime adds spacing, rolling-window quotas, cache TTLs, retry-after state and per-source diagnostics.
- **Normalized storage:** acquisitions, current event records, first/last seen, sighting counts, event-history snapshots, entities, relationships, cases, and case-object links. Versioned event-contract migrations and a separate immutable SHA-256 raw-object archive define explicit schema/raw preservation boundaries.
- **Shared domain contract:** `app.domain_contract` generates a compact compatibility manifest directly from the server Pydantic model fields/required fields. The checked-in `static-console/domain-contract.json` is generated from that model, served through `/api/v1/domain-contract`, validated by the static console before portable-case construction, and covered by an exact drift test.
- **Normalization/enrichment:** timezone-aware UTC normalization with source/assumption provenance; documented CRS/geocoding rules; bounded parallel fan-out/fan-in enrichers with per-step timing, partial-failure state, and retained conflicts. Nominatim place results retain provider bounding boxes and derived uncertainty instead of pretending provider centroids are exact.
- **Analyst workspace:** persisted case activity, safe Markdown notes, annotations/dispositions, allow/block annotations, bookmarks, templates, cloning, archive/restore, evidence attachments/links, correction overlays, validation-error inbox, source reliability and suppression rules.
- **Collaboration foundation:** optional shared-mode architecture/RBAC design plus append-only analyst audit records, secret-safe saved views, prioritized assignments/work queues, handoff notes, and review decisions. Local single-user mode remains the default.
- **Knowledge graph:** persisted typed entities/relationships, bounded neighborhood/path/component queries, alias canonicalization/deduplication suggestions, relationship staleness, explicit inferred-link review/hypothesis labels, and audited merge/split operations.
- **Correlation/geospatial:** explainable cross-source correlation candidates without auto-merge; per-field conflict/preferred-value support; explainable suppression rules; haversine distance, initial bearing, event/entity proximity, tracks/position history/replay, geofences and enter/exit events, administrative-boundary intersection, antimeridian-aware bounding boxes, simple polygon filtering, great-circle interpolation, explicit map-layer attribution, and UI precision/uncertainty cues that do not invent numeric error radii.
- **Workflow engine:** reusable versioned playbooks, dependency/pivot context, declarative conditions, bounded parallel steps, retry/fallback, human-review gates, batch runs, result diffs, priority queueing, reusable preset registry, schedule/event/source-health trigger matching, and a visual node-graph builder with validate/run/rerun controls. No untrusted expressions are evaluated.
- **Durable background execution:** optional single-host SQLite task queue provides atomic task claiming, bounded JSON payload/result summaries, bounded retries, schedule-slot deduplication, interval schedules, worker heartbeats, queue wait/run-duration telemetry, and separate `python -m app.worker` / `python -m app.scheduler` processes. Durable tasks currently allow registered public-source collection and the existing allowlisted declarative workflows. This is deliberately not described as a distributed queue.
- **Job model:** explicit failure taxonomy, bounded exponential retry policy, terminal job state, attempt timings, reusable circuit-breaker/cooldown primitive, persistent synchronous execution records, durable local queue metrics, and an SSE job-metrics stream. Structured logging can bind both correlation and job IDs to the same execution trail.
- **Alert/watchlist foundation:** persisted source/category/severity/geographic/entity/observable/correlation/change rules, suppression windows, acknowledgement/history, public-HTTPS webhook/JSON output validation, and credential-free email/Slack-style connector envelopes for configured transports.
- **Reconnaissance foundation:** generic observables plus bounded public-target DNS/reverse-DNS, RDAP, CT, TLS, HTTP-header, SPF/DMARC, ASN/prefix, redirect-chain and Internet Archive enrichment; place search/reverse geocoding; bounded STIX 2.1 import/export for supported public observables; bounded PDF/image metadata; local Tesseract OCR with explicit byte/pixel/time/text limits; OpenCV QR/common-barcode extraction with bounded results; and screenshot/image change metrics.
- **Artifact/evidence vault:** content-addressed SHA-256 catalog, deduplication/integrity verification, MIME/size metadata, safe text previews, tags, typed links, custody records, retention cleanup, manifest/checksum ZIP evidence bundles, local filesystem backend, and tested injected-client S3-compatible object-storage backend. Solari browser HTML/screenshots/replays, sandbox result transcripts, and desktop screenshots are cataloged when those executions run. Optional boto3 construction uses the normal credential provider chain and does not accept/persist repository credentials.
- **Debug/data quality:** schema-drift detection/quarantine, validation-error inbox, source reliability, warning/suppression rules, correction overlays, raw-vs-normalized field comparison, source freshness, parser/response/record telemetry, conflict-preserving enrichment/correlation behavior, and a safe metadata-only raw-acquisition inspector that never activates source response content.
- **Static workspace stores:** cases, events, entities, relationships, evidence, saved views, source state, notes, watchlists, layouts, preferences, acquisitions, transformations, and content-addressed artifacts.
- **Portable investigation:** version-3 contract with case metadata, events, entities, relationships, evidence, artifact bytes, acquisitions, transformations, provenance, notes and saved views; logical-member SHA-256 integrity, AES-256-GCM optional encryption, secret/session scanning, conflict-safe all-store merge, isolated read-only open, alternate-hypothesis cloning, JSON/CSV/GeoJSON/GraphML output, and standalone offline HTML report generation.
- **API surfaces:** events, evidence, event history, entities, relationships, cases/workspace, graph queries, correlation candidates, alerts/watchlists, artifacts, observables/reconnaissance, Nominatim place/reverse-geocoding, STIX observable import/export, jobs plus SSE metrics, durable queue/schedule telemetry, shared domain contract, sources/dependencies/health, acquisitions with decoded telemetry, Solari execution/artifact APIs, workflow validate/run/rerun APIs, dashboard metrics, liveness, readiness, version, JSON schema, OpenAPI/read-only explorer, CSV, and GeoJSON.
- **Operations UI:** server dashboard exposes source/category/severity/time/quality filtering, full-text/event/entity search, historical playback, marker/cluster/density map modes, precision cues, map/graph/event synchronized selection, safe raw-acquisition inspection, context pivots, evidence/provenance, region dossier, aggregate statistics, source health, collector/job execution telemetry, Solari Browser/Sandbox/Desktop execution artifacts, source attribution, visual workflow editing/rerun controls, workspace presets, command palette/quick-open, per-panel freshness badges, and a dependency-free orthographic 3D globe. The globe displays geolocated public events and bounded weather-satellite positions derived from retained CelesTrak elements with explicit epoch semantics and a visible warning that the two-body Kepler approximation is not SGP4 or navigation-grade.
- **Solari direct static-client boundary:** current official Solari Browser/Sandbox TypeScript cookbook examples are Node/process-environment clients, Browser maintains a Node-side loopback proxy, and the Desktop example is process-environment based. No browser-script/short-lived browser credential flow is currently published. The project therefore does not expose a durable provider key to static JavaScript or claim direct static Browser/Sandbox/Desktop orchestration; `docs/static-solari-client-verification.md` records the verification and broker/server delegation boundary.

## Architecture Principles
- Prefer free/open public data and documented public APIs.
- Use adapters behind normalized event/evidence contracts.
- Preserve raw acquisition/evidence separately from derived values where practical.
- Use deterministic parsing before inference when sufficient.
- Keep inference distinguishable from observed facts.
- Idempotent collection with deterministic identities.
- Explicit source health/failure states.
- Treat web content, imported bundles, uploaded documents, XML, archives, and generated parsers as untrusted.
- Bound response sizes and reject risky XML/archive constructs before parsing where those formats are used.
- Run risky/generated processing in Solari Sandbox rather than host/browser execution when the live provider environment is available and isolation materially improves the boundary; local bounded deterministic helpers remain explicitly identified as local processing.
- Human-verifiable output and observability are first-class requirements.
- Correlation candidates never destructively merge independent source records without an explicit review decision.
- Provider cadence/usage policies are engineering constraints: for example, CelesTrak collection is limited to one named group and a two-hour configured interval rather than bulk/high-frequency polling.
- Configurable public feed URLs must have explicit public-host boundaries; the WZDx adapter requires an exact host allowlist and revalidates redirects rather than becoming a generic network proxy.
- Schedule and preliminary-observation feeds retain their provider semantics: MBTA static GTFS is never presented as real-time transit status, and SPC daily hail reports remain explicitly preliminary observations rather than warnings or finalized storm records.
- The local durable task queue is a single-host deployment option; optional Redis/PostgreSQL or other distributed infrastructure must not be claimed until implemented, justified, and tested.

## Static / No-Hosting Security Boundary
- Solari/API credentials must never be embedded in static assets or repository content.
- The optional evaluator-key field remains page-memory-only scaffolding and provides an explicit clear action; it does not imply direct provider execution under the current documented client model.
- Static CSP permits only self-hosted script/style execution and blocks object/frame/form execution paths.
- No third-party runtime CDN dependencies are required by the static console.
- Imported portable cases are size/schema/integrity/secret checked before mutation and can be opened read-only.
- The static console consumes a checked-in shared domain-contract manifest generated from the server model and refuses unsupported contract/portable-case versions.
- Divergent imported objects without comparable timestamps are retained as unresolved instead of silently overwriting local state.
- Memory-only privacy mode bypasses persistent workspace storage for new session state.
- Purge controls remove the local IndexedDB database and Cache Storage entries.
- Offline HTML reports escape case/source content and contain no executable script.
- Provider operations that require durable credentials or Node/process-local client machinery remain server/broker responsibilities unless Solari later publishes an explicit browser-targeted safe credential/client model.

## Cross-Platform Operator Workflow
Root single-entrypoint scripts:
- Linux: `./update.sh`
- macOS: `./update-macos.sh`
- Windows PowerShell: `.\update.ps1`

Scripts validate repository/branch, enforce Python 3.11+ and Node.js 20+ where applicable, install Python dependencies, run dependency-free static Node tests when present, run Python tests, and report missing `SOLARI_API_KEY` without inventing credentials.

## Configuration / Secrets
- Never commit live API keys, tokens, credentials, cookies, private keys, authenticated session material, runtime databases, exports, logs, or generated credential artifacts.
- `SOLARI_API_KEY` and any future source credentials are environment/user supplied.
- Public no-credential sources are preferred. Credential/configuration-gated adapters explicitly document required evaluator-owned values; WZDx requires a public feed URL plus exact hostname allowlist rather than any repository credential.
- `.gitignore` was reviewed and expanded for environment files, runtime databases/data, virtual environments/caches, coverage, logs/temp/backups, build output, editor files, and generated screenshot artifacts.
- CI runs `tools/public_release_scan.py` against the checked-out development tree and fails on known sensitive filenames and likely private/AWS/GitHub/Slack/Stripe/bearer/credential-in-URL patterns.

## Prime Prompts Governance
- **Governing repository:** `tocsindata/prime-prompts`
- **Prime Prompts revision reviewed:** `0c499baad9f2b8dcf42e78deb6086174d000a90f`
- **Compliance review status:** Remediation required — repository-specific public/data/configuration/update/TODO/security requirements reviewed; central mirror/registry and final public-release gates remain open under the current single-repository scope.
- **Compliance review timestamp:** 2026-09-01
- **Compliance exceptions/remediation reference:** `TODO.md`
- **Current META_TEMPLATE blob SHA in registry header:** recorded in the compliance review evidence; re-check before final release if Prime Prompts advances.

## TODO / Remediation Tracking
- **TODO path:** `TODO.md`
- **TODO review status:** Reconciled through the 2026-09-02 autonomous implementation pass; implemented items are removed from unresolved sections only where repository code/tests/docs provide evidence, while live/manual/conditional deployment items remain open.
- **TODO last reviewed:** 2026-09-02
- **Central TODO mirror:** Pending; not mutated because the current task is single-repository scoped.

## Repository Security Hygiene
- **Security-hygiene audit status:** Partial pending final-release review.
- **Security-hygiene audit completed:** Current-tree automated secret-pattern scan and reachable Git-history scan are passing on verified development commits; final private/proprietary-content review remains pending.
- **Current-tree secret scan:** CI scanner configured and passing on verified development commits; revalidation remains part of every subsequent CI run.
- **Git-history secret scan:** Completed for reachable history at commit `94a22969c92749b19a2f3233fd2b88447d8d6f45`; the scanner fixture was bounded so its synthetic secret-like test data does not create a false release finding.
- **`.gitignore` review:** Reviewed and updated 2026-09-01.
- **Sensitive-file tracking review:** Automated filename/pattern scan is configured; configured private-name/identifier and final proprietary-material review remain release gates.
- **Example-config review:** No live example credential identified by the current-tree scanner.
- **Generated/runtime data review:** Runtime SQLite/data, logs/temp/backups, dist output, caches, and local environments are ignored.
- **Security findings/remediation reference:** `TODO.md`
- **Live credential remediation required/status:** None identified by current-tree or reachable-history automated scans; final semantic public-release review remains open.
- **Live credential remediation completed:** N/A
- **Repository/current-tree credential cleanup:** No current-tree finding from the automated scanner.
- **Git-history remediation:** No live credential finding identified by the completed reachable-history scan.
- **Post-remediation verification:** Current CI continues to run the public-release scanner after repository changes.

## Information Handling / Compliance Applicability
- **Information handled:** Public only by project rule.
- **FCI:** Not applicable based on current project scope.
- **CUI:** Not applicable based on current project scope.
- **Classified:** Prohibited / not applicable.
- **CMMC/NIST/DFARS:** No current authoritative applicability identified for this public showcase; do not imply certification/compliance.
- **Public release:** Repository is intentionally public and therefore still requires final private/proprietary-material review before submission readiness.

## Communications / Monitoring
- **Slack:** None assigned.
- **External uptime monitoring:** N/A until deployed.
- **Matomo / matomo_id:** N/A until a public application hostname is assigned.

## Administrative
- **Owner / operator:** Tocsin Data
- **Approval authority:** Repository owner
- **Issue/task tracking:** Root `TODO.md`; central mirror pending by repository-scope rule

## Maintenance
- **Metadata last updated:** 2026-09-02
- **Metadata updated for:** FAA NAS airport operational status, USCG Navigation Center port status, bounded OCR/QR-barcode processing, representative live source smoke validation, accessibility/retained-volume QA, and verified static Solari client/security boundary.
