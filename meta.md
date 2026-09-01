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
- **Implemented public event/reference adapters:** USGS earthquakes, NWS active alerts, NOAA SWPC alerts, NOAA/NHC Atlantic-basin tropical cyclone RSS products, NOAA/NWS tsunami bulletin RSS, OpenFEMA disaster declarations, GDACS multi-hazard events, CelesTrak weather-group orbital GP data, and OpenStreetMap/Nominatim place/reverse-geocoding reference enrichment. Event adapters publish explicit capability/dependency descriptors and parser/record/response telemetry.
- **Source registration:** public collection adapters are centralized in `app.sources.registry`; duplicate source IDs fail at import instead of silently replacing one another.
- **Collection orchestration:** bounded concurrent multi-source collection with deterministic result ordering and per-source failure preservation; persistence remains serialized for auditability. Source runtime adds spacing, rolling-window quotas, cache TTLs, retry-after state and per-source diagnostics.
- **Normalized storage:** acquisitions, current event records, first/last seen, sighting counts, event-history snapshots, entities, relationships, cases, and case-object links. Versioned event-contract migrations and a separate immutable SHA-256 raw-object archive now define explicit schema/raw preservation boundaries.
- **Normalization/enrichment:** timezone-aware UTC normalization with source/assumption provenance; documented CRS/geocoding rules; bounded parallel fan-out/fan-in enrichers with per-step timing, partial-failure state, and retained conflicts. Nominatim place results retain provider bounding boxes and derived uncertainty instead of pretending provider centroids are exact.
- **Analyst workspace:** persisted case activity, safe Markdown notes, annotations/dispositions, allow/block annotations, bookmarks, templates, cloning, archive/restore, evidence attachments/links, correction overlays, validation-error inbox, source reliability and suppression rules.
- **Collaboration foundation:** optional shared-mode architecture/RBAC design plus append-only analyst audit records, secret-safe saved views, prioritized assignments/work queues, handoff notes, and review decisions. Local single-user mode remains the default.
- **Knowledge graph:** persisted typed entities/relationships, bounded neighborhood/path/component queries, alias canonicalization/deduplication suggestions, relationship staleness, explicit inferred-link review/hypothesis labels, and audited merge/split operations.
- **Correlation/geospatial:** explainable cross-source correlation candidates without auto-merge; per-field conflict/preferred-value support; explainable suppression rules; haversine distance, initial bearing, event/entity proximity, tracks/position history/replay, geofences and enter/exit events, administrative-boundary intersection, antimeridian-aware bounding boxes, simple polygon filtering, great-circle interpolation, and explicit map-layer attribution policy.
- **Workflow engine:** reusable versioned playbooks, dependency/pivot context, declarative conditions, bounded parallel steps, retry/fallback, human-review gates, batch runs, result diffs, priority queueing, reusable preset registry, and schedule/event/source-health trigger matching. No untrusted expressions are evaluated.
- **Job model:** explicit failure taxonomy, bounded exponential retry policy, terminal job state, attempt timings, reusable circuit-breaker/cooldown primitive, and an SSE job-metrics stream. Structured logging can bind both correlation and job IDs to the same execution trail.
- **Alert/watchlist foundation:** persisted source/category/severity/geographic/entity/observable/correlation/change rules, suppression windows, acknowledgement/history, public-HTTPS webhook/JSON output validation, and credential-free email/Slack-style connector envelopes for configured transports.
- **Reconnaissance foundation:** generic observables plus bounded public-target DNS/reverse-DNS, RDAP, CT, TLS, HTTP-header, SPF/DMARC, ASN/prefix, redirect-chain and Internet Archive enrichment; place search/reverse geocoding; and bounded STIX 2.1 import/export for supported public observables.
- **Artifact/evidence vault:** content-addressed SHA-256 catalog, deduplication/integrity verification, MIME/size metadata, safe text previews, tags, typed links, custody records, retention cleanup, manifest/checksum ZIP evidence bundles, and a backend protocol suitable for future S3-compatible implementations.
- **Debug/data quality:** schema-drift detection/quarantine, validation-error inbox, source reliability, warning/suppression rules, correction overlays, raw-vs-normalized field comparison, source freshness, parser/response/record telemetry, and conflict-preserving enrichment/correlation behavior.
- **Static workspace stores:** cases, events, entities, relationships, evidence, saved views, source state, notes, watchlists, layouts, preferences, acquisitions, transformations, and content-addressed artifacts.
- **Portable investigation:** version-3 contract with case metadata, events, entities, relationships, evidence, artifact bytes, acquisitions, transformations, provenance, notes and saved views; logical-member SHA-256 integrity, AES-256-GCM optional encryption, secret/session scanning, conflict-safe all-store merge, isolated read-only open, alternate-hypothesis cloning, JSON/CSV/GeoJSON/GraphML output, and standalone offline HTML report generation.
- **API surfaces:** events, evidence, event history, entities, relationships, cases/workspace, graph queries, correlation candidates, alerts/watchlists, artifacts, observables/reconnaissance, Nominatim place/reverse-geocoding, STIX observable import/export, jobs plus SSE metrics, sources/dependencies/health, acquisitions with decoded telemetry, dashboard metrics, liveness, readiness, version, JSON schema, OpenAPI/read-only explorer, CSV, and GeoJSON.
- **Operations UI:** current server dashboard exposes event/source/category/time/quality filtering, map/timeline, evidence inspection, aggregate category statistics, source health, recent collector executions, and source attribution/terms notes.
- **Solari direct browser-mode caveat:** browser-side CORS/client support has not yet been verified, so direct static Solari Browser/Sandbox/Desktop orchestration is not claimed.

## Architecture Principles
- Prefer free/open public data and documented public APIs.
- Use adapters behind normalized event/evidence contracts.
- Preserve raw acquisition/evidence separately from derived values where practical.
- Use deterministic parsing before inference when sufficient.
- Keep inference distinguishable from observed facts.
- Idempotent collection with deterministic identities.
- Explicit source health/failure states.
- Treat web content, imported bundles, uploaded documents, XML, and generated parsers as untrusted.
- Bound response sizes and reject risky XML constructs before parsing where XML feeds are used.
- Run risky/generated processing in Solari Sandbox rather than host/browser execution.
- Human-verifiable output and observability are first-class requirements.
- Correlation candidates never destructively merge independent source records without an explicit review decision.
- Provider cadence/usage policies are engineering constraints: for example, CelesTrak collection is limited to one named group and a two-hour configured interval rather than bulk/high-frequency polling.

## Static / No-Hosting Security Boundary
- Solari/API credentials must never be embedded in static assets or repository content.
- Current bring-your-own Solari key scaffolding keeps the key in page memory and provides an explicit clear action.
- Static CSP permits only self-hosted script/style execution and blocks object/frame/form execution paths.
- No third-party runtime CDN dependencies are required by the static console.
- Imported portable cases are size/schema/integrity/secret checked before mutation and can be opened read-only.
- Divergent imported objects without comparable timestamps are retained as unresolved instead of silently overwriting local state.
- Memory-only privacy mode bypasses persistent workspace storage for new session state.
- Purge controls remove the local IndexedDB database and Cache Storage entries.
- Offline HTML reports escape case/source content and contain no executable script.

## Cross-Platform Operator Workflow
Root single-entrypoint scripts:
- Linux: `./update.sh`
- macOS: `./update-macos.sh`
- Windows PowerShell: `.\update.ps1`

Scripts validate repository/branch, enforce Python 3.11+ and Node.js 20+ where applicable, install Python dependencies, run dependency-free static Node tests when present, run Python tests, and report missing `SOLARI_API_KEY` without inventing credentials.

## Configuration / Secrets
- Never commit live API keys, tokens, credentials, cookies, private keys, authenticated session material, runtime databases, exports, logs, or generated credential artifacts.
- `SOLARI_API_KEY` and any future source credentials are environment/user supplied.
- Public no-credential sources are preferred. Current GDACS/OpenFEMA/NOAA tsunami/CelesTrak baseline adapters require no repository credential.
- `.gitignore` was reviewed and expanded for environment files, runtime databases/data, virtual environments/caches, coverage, logs/temp/backups, build output, editor files, and generated screenshot artifacts.
- CI runs `tools/public_release_scan.py` against the checked-out development tree and fails on known sensitive filenames and likely private/AWS/GitHub/Slack/Stripe/bearer/credential-in-URL patterns.

## Prime Prompts Governance
- **Governing repository:** `tocsindata/prime-prompts`
- **Prime Prompts revision reviewed:** `39318ae0dc0b7311cfd10bfd201e6ccb11a47161`
- **Prime Prompts revision timestamp verified:** 2026-09-01T08:02:49Z review session; branch commit dated 2026-09-01T07:18:59Z
- **Compliance review status:** Partial — repository-specific public/data/configuration/update/TODO/security requirements reviewed; central mirror/registry and Git-history/final public-release review remain pending
- **Compliance review timestamp:** 2026-09-01T08:15:24Z
- **Compliance exceptions/remediation reference:** `TODO.md`
- **Current META_TEMPLATE blob SHA in registry header:** `f4e3bfe4c3b25e8ca78cd972edfca546caa383db`

## TODO / Remediation Tracking
- **TODO path:** `TODO.md`
- **TODO review status:** Reconciled through the current 2026-09-01 implementation pass; implemented items are checked only where repository code/tests/docs provide evidence and live/manual items remain open.
- **TODO last reviewed:** 2026-09-01
- **Central TODO mirror:** Pending; not mutated because the current task is single-repository scoped.

## Repository Security Hygiene
- **Security-hygiene audit status:** Partial
- **Security-hygiene audit completed:** Current-tree automated secret-pattern scan passed before this run's final head; final current-head CI and history/final private/proprietary-content review remain pending.
- **Current-tree secret scan:** CI scanner configured and passing on the preceding active development tree; revalidation required on final current head.
- **Git-history secret scan:** Not yet completed
- **`.gitignore` review:** Reviewed and updated 2026-09-01T08:02:49Z
- **Sensitive-file tracking review:** Automated filename/pattern scan is configured; Git-history and configured private-name/identifier review remain pending.
- **Example-config review:** No live example credential identified by the current-tree scanner.
- **Generated/runtime data review:** Runtime SQLite/data, logs/temp/backups, dist output, caches, and local environments are ignored.
- **Security findings/remediation reference:** `TODO.md`
- **Live credential remediation required/status:** None identified by the preceding scanner / history scan still pending.
- **Live credential remediation completed:** N/A
- **Repository/current-tree credential cleanup:** No preceding current-tree finding from the automated scanner.
- **Git-history remediation:** Pending full history scan
- **Post-remediation verification:** N/A unless findings occur

## Information Handling / Compliance Applicability
- **Information handled:** Public only by project rule.
- **FCI:** Not applicable based on current project scope.
- **CUI:** Not applicable based on current project scope.
- **Classified:** Prohibited / not applicable.
- **CMMC/NIST/DFARS:** No current authoritative applicability identified for this public showcase; do not imply certification/compliance.
- **Public release:** Repository is intentionally public and therefore still requires final private/proprietary-material and Git-history review before submission readiness.

## Communications / Monitoring
- **Slack:** None assigned.
- **External uptime monitoring:** N/A until deployed.
- **Matomo / matomo_id:** N/A until a public application hostname is assigned.

## Administrative
- **Owner / operator:** Tocsin Data
- **Approval authority:** Repository owner
- **Issue/task tracking:** Root `TODO.md`; central mirror pending by repository-scope rule

## Maintenance
- **Metadata last updated:** 2026-09-01
- **Metadata updated for:** expanded registered public adapters (NOAA tsunami, OpenFEMA, GDACS, CelesTrak), centralized source registry, Nominatim geocoding/reference status, STIX and SSE interoperability, source attribution/dashboard state, and current TODO reconciliation evidence.
