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
- **Implemented public adapters:** USGS earthquakes, NWS active alerts, NOAA SWPC alerts, and NOAA/NHC Atlantic-basin tropical cyclone RSS products; adapters publish explicit capability/dependency descriptors and parser/record/response telemetry.
- **Collection orchestration:** bounded concurrent multi-source collection with deterministic result ordering and per-source failure preservation; persistence remains serialized for auditability. Source runtime adds spacing, rolling-window quotas, cache TTLs, retry-after state and per-source diagnostics.
- **Normalized storage:** acquisitions, current event records, first/last seen, sighting counts, event-history snapshots, entities, relationships, cases, and case-object links.
- **Analyst workspace:** persisted case activity, safe Markdown notes, annotations/dispositions, allow/block annotations, bookmarks, templates, cloning, archive/restore, evidence attachments/links, correction overlays, validation-error inbox, source reliability and suppression rules.
- **Correlation/geospatial:** explainable cross-source correlation candidates without auto-merge; haversine distance, initial bearing, antimeridian-aware bounding boxes, simple polygon filtering and great-circle interpolation.
- **Job model:** explicit failure taxonomy, bounded exponential retry policy, terminal job state, attempt timings, and reusable circuit-breaker/cooldown primitive.
- **Alert/watchlist foundation:** persisted source/category/severity/geographic/entity/observable/correlation/change rules, suppression windows, acknowledgement/history, and public-HTTPS webhook/JSON output validation.
- **Reconnaissance foundation:** generic observables plus bounded public-target DNS/reverse-DNS, RDAP, CT, TLS, HTTP-header, SPF/DMARC, ASN/prefix, redirect-chain and Internet Archive enrichment.
- **Artifact/evidence vault:** content-addressed SHA-256 catalog, deduplication/integrity verification, MIME/size metadata, safe text previews, tags, typed links, custody records, retention cleanup, and manifest/checksum ZIP evidence bundles.
- **Static workspace stores:** cases, events, entities, relationships, evidence, saved views, source state, notes, watchlists, layouts, preferences, and artifacts.
- **Portable investigation:** versioned JSON contract, manifest/source IDs, logical-member SHA-256 integrity checks, AES-256-GCM optional encryption, import preview/conflict analysis, safe merge/read-only open, JSON/CSV/GeoJSON/GraphML output, and standalone offline HTML report generation.
- **API surfaces:** events, evidence, event history, entities, relationships, cases/workspace, graph queries, correlation candidates, alerts/watchlists, artifacts, observables/reconnaissance, jobs, sources/dependencies/health, acquisitions with decoded telemetry, dashboard metrics, liveness, readiness, version, JSON schema, OpenAPI/read-only explorer, CSV, and GeoJSON.
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
- Correlation candidates never destructively merge independent source records without a future explicit review decision.

## Static / No-Hosting Security Boundary
- Solari/API credentials must never be embedded in static assets or repository content.
- Current bring-your-own Solari key scaffolding keeps the key in page memory and provides an explicit clear action.
- Static CSP permits only self-hosted script/style execution and blocks object/frame/form execution paths.
- No third-party runtime CDN dependencies are required by the static console.
- Imported portable cases are size/schema/integrity/secret checked before mutation and can be opened read-only.
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
- Public no-credential sources are preferred.
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
- **TODO review status:** Reconciled through the current 2026-09-01 implementation pass; implemented items are checked only where repository tests/code/CI evidence exists and live/manual items remain open.
- **TODO last reviewed:** 2026-09-01
- **Central TODO mirror:** Pending; not mutated because the current task is single-repository scoped.

## Repository Security Hygiene
- **Security-hygiene audit status:** Partial
- **Security-hygiene audit completed:** Current-tree automated secret-pattern scan passes; history and final private/proprietary-content review remain pending.
- **Current-tree secret scan:** Passed in CI on the active development tree after current feature/test changes.
- **Git-history secret scan:** Not yet completed
- **`.gitignore` review:** Reviewed and updated 2026-09-01T08:02:49Z
- **Sensitive-file tracking review:** Current-tree automated filename/pattern scan passes; Git-history and configured private-name/identifier review remain pending.
- **Example-config review:** No live example credential identified by the current-tree scanner.
- **Generated/runtime data review:** Runtime SQLite/data, logs/temp/backups, dist output, caches, and local environments are ignored.
- **Security findings/remediation reference:** `TODO.md`
- **Live credential remediation required/status:** None identified by current-tree scanner / history scan still pending.
- **Live credential remediation completed:** N/A
- **Repository/current-tree credential cleanup:** No current-tree finding from the automated scanner.
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
- **Metadata updated for:** NOAA/NHC tropical-cyclone adapter, analyst workspace/case-management surfaces, alert/watchlist engine, observable/reconnaissance enrichment, evidence-vault retention/bundles, current-tree CI secret scan, source-runtime controls, and TODO reconciliation.
