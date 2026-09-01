# TODO — Solari OSINT Operations Center

Status: active development
Branch: `develop`

## Submission objective
Build and publicly demonstrate a comprehensive OSINT operations center that uses Solari Browser, Sandbox, and Desktop for legitimate acquisition/processing workflows and shows production-minded evidence handling, observability, debugging, visualization, and cross-platform reproducibility.

## Governance / public-release boundary
- [x] Create `develop` branch.
- [x] Add `AAA_READ_ME_FIRST.md`.
- [x] Add full `meta.md` foundation.
- [x] Add `sources.md` registry.
- [x] Add root `TODO.md`.
- [x] Record exact Prime Prompts commit SHA used for compliance review.
- [ ] Create/synchronize central Prime Prompts TODO mirror. Blocked by single-repository scope unless cross-repository authorization is explicitly granted.
- [ ] Add repository to applicable Prime Prompts work-repository registry. Blocked by single-repository scope unless cross-repository authorization is explicitly granted.
- [ ] Complete applicable Prime Prompts compliance review.
- [ ] Complete current-tree secret scan.
- [ ] Complete Git-history secret scan.
- [x] Review `.gitignore` and sensitive/generated-file exclusions.
- [ ] Perform final public-release scan for private names, unrelated project/company identifiers, credentials, proprietary material, and restricted data.

## Product architecture
- [x] Select implementation stack while preserving upstream cookbook examples.
- [x] Define normalized source/event/evidence schema.
- [x] Define raw-acquisition object model.
- [x] Define provenance/transformation chain model.
- [x] Define entities and relationships model.
- [x] Define baseline geospatial point model and coordinate rules.
- [x] Define deduplication/correlation strategy beyond deterministic source IDs.
- [x] Define source/collector health model.
- [x] Define full execution/job/retry model.
- [x] Define configuration and secret boundary.
- [ ] Define retention/cleanup policy for browser sessions, recordings, screenshots, raw acquisitions, sandbox outputs, and desktop artifacts.

## Solari Browser
- [x] Implement generic browser acquisition adapter foundation.
- [x] Capture final URL, timestamps, rendered HTML, screenshot metadata and relevant page metadata.
- [ ] Add browser session recording where useful.
- [ ] Demonstrate a JavaScript-heavy public source.
- [ ] Demonstrate stateful browser profile/session use where lawful and useful.
- [ ] Demonstrate stealth/proxy capability against an appropriate public test/source without bypassing access restrictions.
- [ ] Add bounded retry/timeout/error taxonomy.
- [ ] Surface browser executions in operations/debug UI.

## Solari Sandbox
- [x] Implement generic sandbox job adapter.
- [x] Run parsing/transformation in isolated sandbox.
- [x] Demonstrate generated parser/extraction logic safely inside sandbox.
- [x] Demonstrate document/data transformation.
- [ ] Demonstrate geospatial/enrichment computation inside the sandbox.
- [x] Capture stdout/stderr/result/error/timing and safe diagnostic artifacts.
- [ ] Reuse stateful code contexts for bounded multi-step analysis where useful.
- [x] Ensure VM termination/cleanup on success and failure.
- [ ] Surface sandbox executions in operations/debug UI.

## Solari Desktop
- [ ] Identify a legitimate public-source GUI-only or screen-driven workflow.
- [ ] Implement desktop session lifecycle.
- [ ] Capture screenshots/evidence.
- [ ] Demonstrate click/type/computer-use workflow.
- [ ] Normalize resulting observations into the same evidence model.
- [ ] Surface desktop executions in operations/debug UI.

## Public source adapters
- [x] USGS earthquakes.
- [x] NOAA/NWS weather alerts.
- [ ] NOAA/NHC tropical cyclone products.
- [ ] NOAA tsunami products.
- [x] NOAA space weather.
- [ ] NASA FIRMS wildfire.
- [ ] GDACS disasters.
- [ ] ReliefWeb humanitarian events.
- [ ] FEMA/public emergency-management datasets.
- [ ] EPA/environmental datasets.
- [ ] Public flood/hydrology feeds.
- [ ] Public volcano data.
- [ ] Public aviation operational/status data.
- [ ] Public maritime safety/environmental data.
- [ ] Public GTFS/transportation feeds.
- [ ] Public sanctions/watchlists.
- [ ] Open geospatial/boundary/gazetteer sources.
- [ ] Public satellite/orbital data.
- [ ] Public internet-health/outage telemetry where lawful and free.
- [ ] Public infrastructure status datasets.
- [ ] Public air-quality and environmental sensor feeds.
- [ ] Public lightning/storm observation feeds.
- [ ] Public river gauge/water-level feeds.
- [ ] Public volcanic observatory feeds.
- [ ] Public airport/airspace status feeds.
- [ ] Public vessel/port status sources that do not require restricted credentials.
- [ ] Additional lawful free/open sources discovered during development.

## Ingestion / normalization
- [x] Adapter interface and source registry.
- [x] Acquisition persistence.
- [x] Normalized records.
- [x] Schema validation through typed models.
- [x] Deterministic identifiers/idempotence.
- [x] Duplicate/correlation candidate detection across different source IDs without destructive auto-merge.
- [x] Cross-source correlation.
- [ ] Geographic normalization/geocoding strategy.
- [ ] Time normalization and timezone provenance.
- [x] Entity extraction where appropriate.
- [x] Baseline confidence/quality scoring field.
- [x] Distinguish observed facts from transformed/inferred evidence types.
- [x] Field/source-path evidence references.
- [x] First-seen / last-seen tracking.
- [x] Observation frequency / sighting counts.
- [ ] Immutable raw-object archive with content-addressed lookup.
- [ ] Schema versioning and migrations for normalized event contracts.
- [ ] Source-specific rate limiting and quotas.
- [ ] Result caching with explicit freshness TTLs.
- [x] Parallel/concurrent multi-source collection.
- [x] Multi-target collection jobs.
- [ ] Fan-out/fan-in enrichment pipelines.
- [x] Source adapter capability descriptors.
- [x] Source adapter dependency graph.
- [ ] Per-field conflict tracking when sources disagree.
- [ ] Preferred-value selection with provenance preserved.
- [x] Confidence aggregation across independent-source reliability, record-quality and corroboration inputs.
- [x] Observation supersession/history rather than destructive overwrite.

## Dashboard
- [x] Responsive application shell.
- [x] Global/regional interactive map.
- [ ] Marker clustering.
- [ ] Heat/density layer.
- [x] Source/category filter controls.
- [ ] Rich layer toggles and source overlays.
- [ ] Time-window slider.
- [ ] Historical playback.
- [x] Timeline/event stream foundation.
- [ ] Faceted filters.
- [ ] Geographic filters.
- [ ] Source/category/severity/quality/confidence filters.
- [ ] Full-text/entity search.
- [ ] Saved views/query state.
- [x] Event detail/evidence inspector foundation.
- [x] Normalized properties inspection.
- [ ] Raw-source view.
- [ ] Provenance/transformation chain visualization.
- [ ] Related-event/entity relationship graph.
- [ ] Aggregate charts/statistics.
- [ ] Geographic drill-down.
- [ ] Source health dashboard UI.
- [ ] Collector execution dashboard UI.
- [ ] Browser/Sandbox/Desktop execution views.
- [ ] Failure/retry/debug trace view.
- [ ] Screenshot/session-recording references.
- [x] Acquisition latency backend telemetry.
- [ ] Cost telemetry when Solari exposes sufficient billing/job data.
- [x] JSON export foundation through existing event endpoint.
- [x] CSV export.
- [x] GeoJSON export.
- [x] GraphML graph export through portable/static investigation export.
- [ ] STIX 2.x export/import where semantically appropriate.
- [ ] Read-only API explorer/documentation.
- [ ] 3D globe mode for global situational awareness.
- [ ] 2D/3D synchronized selection state.
- [ ] Shared selection context across dashboard modules.
- [ ] Shared time context across dashboard modules.
- [ ] Position/event replay from retained history.
- [ ] Side-by-side map and graph analysis mode.
- [ ] Country/region dossier view built only from public structured sources.
- [ ] Data freshness badges on every major widget.
- [ ] Analyst workspace layout presets.
- [ ] Keyboard-driven command palette.
- [ ] Universal object/entity quick-open.
- [ ] Context-menu pivots from map markers/entities.

## Investigation / case management — competitive backlog
- [x] Investigation/case containers.
- [x] Case priority, status, owner and tags.
- [x] Case-scoped event/entity/evidence/relationship collections.
- [ ] Case activity timeline.
- [ ] Case notes with Markdown rendering.
- [ ] Analyst comments and annotations.
- [ ] Manual entity creation.
- [ ] Manual relationship creation.
- [ ] Evidence attachments with provenance metadata.
- [ ] Evidence-to-entity links.
- [ ] Evidence-to-event links.
- [ ] Investigation trail/history of pivots and actions.
- [ ] Bookmarks/pins/starred evidence.
- [ ] Case templates.
- [ ] Case cloning/branching for alternate hypotheses.
- [ ] Case archive/restore workflow.
- [x] Case export bundle.
- [x] Analyst-ready offline HTML report generation from a case.
- [ ] Graph snapshot in generated reports.
- [x] Timeline snapshot/table in generated reports.
- [x] Source/evidence appendix in generated reports.
- [ ] Reproducibility manifest showing source IDs, timestamps and transformations used in a report.

## Knowledge graph / entity intelligence — competitive backlog
- [x] Persistent knowledge graph abstraction over entities and relationships.
- [ ] Entity types for location, organization, infrastructure, domain, IP, URL, email, username/alias, phone, vessel, aircraft, satellite and other lawful public identifiers.
- [x] Typed relationship edges.
- [x] Edge confidence scoring.
- [x] Edge provenance.
- [x] First-seen and last-seen on entities/relationships.
- [ ] Interactive graph visualization.
- [x] Node expansion/pivoting through bounded neighborhood queries.
- [x] Neighborhood exploration with depth limits.
- [x] Graph path finding between entities.
- [x] Temporal graph filtering.
- [x] Geographic graph filtering.
- [x] Graph clustering/community detection foundation through connected components.
- [x] Relationship inference state separated visibly from observed relationships.
- [ ] Auto-correlation rules that create/review graph relationships.
- [ ] Correlation explanation UI view.
- [ ] Merge/split entities with audit history.
- [ ] Alias resolution.
- [ ] Entity canonicalization.
- [ ] Entity deduplication suggestions.
- [ ] Manual accept/reject of inferred relationships.
- [ ] Hypothesis labels on inferred links.
- [ ] Confidence decay / staleness rules for old relationships.

## Analyst automation / workflows — competitive backlog
- [ ] Reusable playbooks for repeatable analyses.
- [ ] Visual node-graph workflow builder.
- [ ] Conditional workflow branches.
- [ ] Parallel workflow steps.
- [ ] Retry/fallback workflow nodes.
- [ ] Human-review/approval workflow node.
- [ ] Scheduleable workflows.
- [ ] Event-triggered workflows.
- [ ] Source-health-triggered workflows.
- [ ] Reusable scan templates/presets.
- [ ] Pivot chains that launch follow-up analysis from prior results.
- [x] Pluggable analyzers.
- [ ] Executable pluggable ingestors.
- [ ] Executable pluggable visualizers.
- [ ] Executable pluggable exporters/connectors.
- [x] Plugin manifest/schema.
- [x] Plugin capability discovery.
- [x] Plugin isolation through Solari Sandbox when practical.
- [x] Per-plugin timeout/resource limits.
- [x] Per-plugin provenance and execution trace.
- [ ] One-click re-run of prior analysis with current source data.
- [ ] Diff previous vs current analysis results.
- [ ] Batch/multi-target analysis jobs.
- [ ] Queue prioritization and concurrency controls.

## Data quality / false-positive controls — competitive backlog
- [x] Warning-list framework for known benign/public/common values.
- [x] Exact-string warning-list matching.
- [x] Substring warning-list matching.
- [x] Hostname/domain warning-list matching.
- [x] CIDR warning-list matching.
- [x] Regex warning-list matching.
- [ ] Analyst allowlist/blocklist annotations.
- [ ] False-positive triage state.
- [ ] True-positive / false-positive / suspicious analyst disposition where applicable.
- [ ] Duplicate/correlation suppression rules.
- [ ] Persisted source reliability scoring separate from event confidence.
- [x] Data completeness score.
- [x] Staleness score.
- [ ] Contradiction/conflict flag when authoritative sources disagree.
- [ ] Schema-drift quarantine instead of silent ingestion.
- [ ] Validation error inbox for malformed source records.
- [ ] Manual correction overlay preserving original source data.

## Evidence vault / artifact management — competitive backlog
- [x] Content-addressed artifact store.
- [ ] HTML/text raw capture retention wired to collectors.
- [ ] Screenshot artifact retention wired to browser executions.
- [ ] Browser recording artifact retention.
- [ ] Sandbox output artifact retention wired to executions.
- [ ] Desktop screenshot/video artifact retention where appropriate.
- [x] File hash and MIME metadata.
- [ ] Artifact preview.
- [ ] Artifact tags.
- [ ] Artifact-to-case/entity/event relationships.
- [ ] Evidence chain-of-custody metadata for demo purposes.
- [ ] Artifact retention policies.
- [x] Deduplicate identical artifacts by hash.
- [ ] Export evidence bundle with manifest/checksums including artifact bytes.
- [ ] Object-storage backend abstraction for future S3-compatible storage.

## Reconnaissance / observable enrichment — competitive backlog
- [ ] Generic observable model distinct from situational events.
- [ ] Domain/IP/URL enrichment adapters using lawful free sources.
- [ ] DNS and reverse-DNS lookup module.
- [ ] RDAP/WHOIS-style public registration lookup where terms permit.
- [ ] Certificate Transparency lookup.
- [ ] TLS certificate metadata extraction.
- [ ] HTTP technology/header fingerprinting for user-supplied public targets.
- [ ] SPF/DMARC/DNS security metadata checks.
- [ ] Public ASN/network ownership lookup.
- [ ] Public geolocation of network prefixes with uncertainty metadata.
- [ ] Username/alias correlation only against lawful public sources.
- [ ] Public repository/code search pivots.
- [ ] Public document metadata extraction.
- [ ] PDF metadata/text extraction in sandbox.
- [ ] Image EXIF metadata extraction for user-supplied/public artifacts.
- [ ] OCR pipeline for public/user-supplied evidence where appropriate.
- [ ] QR/barcode extraction from public/user-supplied artifacts.
- [ ] URL redirect-chain analysis.
- [ ] Web archive/history lookup using lawful public archive services.
- [ ] Screenshot comparison / visual change detection.

## Geospatial / situational-awareness backlog
- [ ] Track moving objects with timestamped positions when free/public sources permit.
- [ ] Position trails/history.
- [ ] Replay moving-object history.
- [ ] Geofences and region-of-interest definitions.
- [ ] Enter/exit geofence events.
- [x] Distance/bearing calculations.
- [ ] Proximity correlation between both events and entities.
- [ ] Bounding-box/polygon filters (bounding-box filtering exists; polygon filtering remains).
- [ ] Administrative boundary intersection.
- [ ] Reverse geocoding from open datasets.
- [ ] Place-name gazetteer lookup.
- [ ] Coordinate precision/uncertainty visualization.
- [ ] Great-circle route visualization.
- [ ] Public satellite orbital/TLE visualization.
- [ ] Optional 3D terrain/globe visualization.
- [ ] Tile/layer attribution management.
- [x] Offline/local baseline map works without external tile assets; richer licensed offline map cache remains optional.

## Alerts / watchlists
- [ ] User-defined watchlists over public entities/events.
- [ ] Geographic watch areas.
- [ ] Source watch rules.
- [ ] Category/severity threshold alerts.
- [ ] Entity/observable watch rules.
- [ ] Correlation-triggered alerts.
- [ ] Change-detection alerts.
- [ ] Alert acknowledgement/triage.
- [ ] Alert suppression/deduplication window.
- [ ] Alert history.
- [ ] Webhook output connector.
- [ ] Generic REST output connector.
- [ ] Optional email/Slack-style connector interfaces without embedding credentials in repository.

## Debugging / observability
- [ ] Structured logs with correlation/job IDs.
- [x] Source acquisition timings in persistence layer.
- [x] Parser timings recorded in acquisition metadata for implemented API/feed collectors.
- [ ] Queue/job timings for a persistent queue if one is introduced.
- [x] Failure taxonomy.
- [x] Retry counters and terminal-failure state in bounded job executions.
- [x] Source freshness/staleness detection.
- [x] Last acquisition per source backend query.
- [ ] Schema drift detection.
- [ ] Raw-vs-normalized comparison.
- [ ] Deduplication/correlation explanation UI view.
- [x] Health endpoint.
- [x] Source-health backend endpoint.
- [x] Readiness endpoint distinct from liveness.
- [x] Metrics suitable for dashboard display.
- [x] Safe doctor/diagnostic command that does not expose secrets/session material.
- [ ] Per-job execution timeline/Gantt view.
- [ ] Persistent queue depth and worker utilization.
- [x] Source response-size telemetry in acquisition metadata/metrics.
- [x] Records accepted/rejected per implemented collector run.
- [x] Transformation-step timing.
- [ ] Resource-leak detection for Solari browser/sandbox/desktop sessions.
- [ ] Cost-per-job/source telemetry where provider data allows.
- [ ] Wire circuit breaker into collectors after repeated failures.
- [ ] Wire automated collector recovery after cooldown.

## API / interoperability
- [x] Read-only events endpoint.
- [x] Sources/status endpoint foundation.
- [x] Evidence/provenance endpoint.
- [x] Entity/relationship endpoint.
- [x] Health endpoint.
- [x] Readiness endpoint.
- [x] Basic filters/limits.
- [x] Cursor pagination.
- [x] Time-window filters.
- [x] Bounding-box/geospatial filters.
- [x] Full-text search/filter support.
- [x] Graph query endpoint.
- [x] Case/investigation read endpoint.
- [ ] Artifact/evidence endpoint including stored artifact access.
- [ ] Job/execution endpoint.
- [x] OpenAPI generation through FastAPI.
- [ ] WebSocket/SSE live updates.
- [ ] GraphQL evaluation for graph-heavy client queries.
- [ ] STIX 2.x interoperability where appropriate.
- [ ] MISP-compatible export/import evaluation for relevant cyber observables only.
- [x] Generic JSON schema export.
- [x] API versioning/deprecation policy.

## Collaboration / governance backlog
- [x] Local single-user mode remains default for demo simplicity.
- [ ] Optional multi-user architecture design.
- [ ] Role-based access control design if multi-user mode is implemented.
- [ ] Immutable analyst action audit log.
- [ ] Shareable saved views without leaking secrets.
- [ ] Investigation assignment/work queue.
- [ ] Analyst handoff notes.
- [ ] Review/approval status on derived conclusions.
- [ ] Data/source license and attribution registry surfaced in UI.
- [x] Per-source terms/usage notes maintained in source registry/descriptors.
- [x] Public-source legal/ethical boundary page.

## No-hosting static console mode
- [x] Make the primary single-user analyst console capable of running as a fully static browser application with no application server required.
- [ ] Keep one identical frontend backend-independent so the same UI can operate in static-local mode or FastAPI team/server mode; current modes are separate frontends sharing concepts/portable data.
- [ ] Define one fully shared generated domain/data contract across static and server modes; current portable semantics align but remain separately implemented.
- [x] Add browser-side IndexedDB persistence for cases, events, entities, relationships, evidence metadata, saved views, source state, notes, watchlists, layouts, preferences, and artifacts.
- [x] Add IndexedDB schema versioning and migrations.
- [ ] Add browser-side content-addressed artifact storage using IndexedDB/OPFS where supported.
- [x] Add a pure-static source adapter layer for public APIs that permit browser-side CORS access.
- [ ] Detect CORS-incompatible public sources and actually route them through Solari Browser or optional broker rather than only explaining the fallback.
- [ ] Add static-mode direct Solari Browser orchestration where Solari browser-side API access is supported.
- [ ] Add static-mode direct Solari Sandbox orchestration where Solari browser-side API access is supported.
- [ ] Add static-mode direct Solari Desktop orchestration where Solari browser-side API access is supported.
- [ ] Verify Solari API CORS/browser-client support before claiming direct static operation.
- [x] Add bring-your-own Solari API key mode for developer/evaluator use.
- [x] Keep the Solari API key in memory by default; never embed it in static assets or repository content.
- [ ] Evaluate optional Web Crypto-encrypted local key persistence with explicit opt-in and prominent risk warning.
- [x] Add one-click clear/forget local credentials and cached session material.
- [x] Add a visible credential/session-state indicator in static mode without exposing secret values.
- [ ] Add optional tiny credential-broker mode for deployments that should not expose provider credentials to browser JavaScript.
- [ ] Keep broker functionality narrowly scoped to credential delegation/request signing rather than recreating the full application server.
- [ ] Add support for user-configurable broker endpoint without hard-coding private infrastructure.
- [x] Add static deployment targets/documentation for GitHub Pages, Cloudflare Pages, Netlify, S3-compatible static hosting, generic web servers, and local-file/localhost use where browser restrictions permit.
- [x] Add downloadable ZIP build that can be unpacked and run without installing a backend service.
- [x] Add Progressive Web App manifest/service worker for installable/offline-capable analyst shell.
- [x] Add offline-first loading for the application shell and locally retained investigations.
- [x] Add explicit offline/online/source-availability indicators.
- [x] Provide an offline local-map baseline with no tile licensing dependency; richer cached tiles remain optional.
- [x] Ensure static mode never requires PHP, Python, Docker, a database server, a permanent VM, or a daemon.
- [x] Preserve FastAPI/server mode for shared/team deployments without making it a prerequisite for single-user use.
- [x] Add local-only analyst workstation mode that uses the static frontend and browser storage without publishing investigation state externally.
- [ ] Evaluate Tauri packaging using the same frontend for an optional desktop build with OS credential storage.
- [ ] Evaluate Electron only if Tauri/browser mode cannot meet a required capability; avoid duplicative desktop stacks without justification.

## Portable investigation bundle
- [x] Define a portable case bundle format that can move between static, local-workstation, and server deployments conceptually.
- [x] Use the neutral project-owned `.solari-case` extension for encrypted portable cases.
- [ ] Bundle the full case metadata, events, entities, relationships, evidence references, artifact bytes, screenshots, acquisitions, transformations, provenance, notes, saved views, and reproducibility manifest; current v2 covers the core structured subsets but not all artifact/acquisition bytes.
- [x] Include a manifest with schema version, creation timestamp, tool version, source identifiers, content hashes, and required capabilities.
- [x] Include per-logical-member SHA-256 checksums and bundle integrity verification.
- [x] Add optional Web Crypto encryption for portable case bundles using a user-supplied passphrase/key.
- [x] Never include Solari/API credentials, browser cookies, authenticated session tokens, or unrelated local secrets in exported bundles; secret/session scanning blocks suspected values.
- [x] Add export-time secret/session scanner before bundle creation.
- [x] Add import preview showing bundle contents, schema version, checksums, source provenance, and warnings before mutation of local state.
- [ ] Complete conflict handling for divergent analyst edits across every bundled object type; event duplicate/newer/older and incompatible-schema handling is implemented.
- [x] Add safe merge mode and isolated-open/read-only mode for imported bundles.
- [ ] Add case cloning from imported bundles for alternate hypotheses without mutating the original evidence package.
- [x] Add reproducible offline HTML report generation directly from a portable investigation.
- [x] Add bundle-to-JSON/CSV/GeoJSON/GraphML export where applicable.
- [x] Add bundle integrity/encryption/derivative round-trip test fixtures.
- [x] Document the portable format so third-party tools can inspect or produce compatible bundles without running the application.

## Static-mode security and privacy
- [x] Define static-mode threat model covering XSS, malicious imported bundles, hostile source content, compromised third-party scripts, browser storage theft, API-key exposure, and service-worker cache poisoning.
- [x] Eliminate inline executable code where practical and use a strict Content Security Policy compatible with static hosting.
- [x] Minimize third-party CDN runtime dependencies; current static console has no third-party runtime CDN dependency.
- [x] Subresource Integrity is not applicable to the current static runtime because no third-party hosted runtime assets remain; add SRI if that changes.
- [x] Sanitize/escape source-derived HTML/text before rendering; table content uses text nodes and exported report content is XML/HTML escaped.
- [x] Never execute source-provided JavaScript inside the analyst console origin.
- [x] Keep generated/untrusted parsing code confined to Solari Sandbox rather than browser `eval`/`Function` execution.
- [x] Validate imported bundle schemas and size limits before storing content.
- [x] Add decompression-bomb/oversized-artifact protections for the current uncompressed JSON format via overall size/member-count limits; revisit if archive compression is introduced.
- [x] Add explicit purge controls for local cases, artifacts, caches, service-worker data, and IndexedDB databases.
- [x] Add privacy mode that disables persistent local storage and keeps investigation state memory-only for the session.
- [x] Add storage-usage dashboard and quota warnings.
- [x] Add browser capability checks for IndexedDB, OPFS, Web Crypto, service workers, File System Access API, and online/source behavior.

## Packaging / deployment — competitive backlog
- [x] Dockerfile.
- [x] Docker Compose stack.
- [x] Healthchecks in container definitions.
- [ ] Optional PostgreSQL backend for larger deployments.
- [ ] Optional Redis queue/cache for concurrent jobs.
- [ ] Optional S3-compatible artifact storage.
- [ ] Migration framework if database schema grows beyond simple bootstrap migrations.
- [ ] Background worker process.
- [ ] Scheduler process.
- [ ] Horizontal worker scaling design.
- [x] Configuration validation command.
- [x] Doctor/diagnostics command.
- [x] CLI client in addition to web UI.
- [x] Machine-readable version/build metadata endpoint.

## Cross-platform setup/update
- [x] Require Linux `update.sh`.
- [x] Require Windows `update.ps1`.
- [x] Require macOS `update-macos.sh`.
- [ ] Test fresh checkout on Linux.
- [ ] Test repeat/idempotent Linux update.
- [ ] Test fresh checkout on Windows.
- [ ] Test repeat/idempotent Windows update.
- [ ] Test fresh checkout on macOS or document unavailable validation environment honestly.
- [x] Test missing `SOLARI_API_KEY` behavior at unit level.
- [x] Test/reject unsupported Python runtime policy and reject unsupported Node runtime in platform updater entrypoints.
- [x] Ensure updater executes Python and static-console tests automatically for the current stack.

## Tests / QA
- [x] Unit tests for baseline normalization/idempotence/provenance.
- [x] Fixture normalization tests for every currently implemented source adapter.
- [ ] Live smoke tests for representative public sources.
- [ ] Solari Browser integration tests with live key.
- [ ] Solari Sandbox integration tests with live key.
- [ ] Solari Desktop integration test.
- [x] Failure/retry/timeout tests.
- [ ] Schema drift tests.
- [ ] Browser UI smoke tests.
- [x] API contract tests for core liveness/readiness/schema/filter/metrics/correlation surfaces.
- [ ] Accessibility pass.
- [ ] Performance pass with representative event volume.
- [ ] Cleanup/resource-leak tests for remote Solari resources.
- [ ] Migration/upgrade tests beyond current schema migration unit coverage.
- [ ] Data-retention cleanup tests.
- [x] Graph integrity/path/component tests.
- [x] Correlation explanation/candidate tests.
- [x] Portable report reproducibility/escaping test foundation.
- [ ] Public-release/private-name scanner test.
- [ ] Secret-pattern scanner in CI.
- [ ] Static-mode first-run browser test with no backend process available.
- [x] Static-mode offline-shell asset regression test.
- [ ] IndexedDB persistence/migration browser tests.
- [x] Portable case bundle round-trip/integrity tests.
- [x] Encrypted bundle import/export tests.
- [ ] Static-mode credential purge browser tests.
- [x] Static-mode CSP/XSS regression tests.
- [ ] Browser capability/fallback integration tests.

## Documentation / submission
- [x] Expand README with project showcase while preserving attribution/upstream context.
- [x] Initial architecture document and diagram.
- [x] Data/evidence model documentation.
- [x] Collector/source authoring guide.
- [x] Plugin/analyzer authoring guide.
- [x] Operations/debugging guide.
- [x] Investigation/case workflow guide.
- [x] Security/public-data boundary documentation.
- [x] Cross-platform quickstart.
- [x] Static/no-hosting quickstart: clone/download, serve static console, optionally enter evaluator-owned Solari key, begin work.
- [x] Static architecture diagram showing browser console → public APIs / conditional Solari Browser / Sandbox / Desktop → IndexedDB/OPFS.
- [x] Portable investigation bundle format documentation.
- [x] Static-mode security/threat-model documentation.
- [ ] Demo scenario that exercises Browser + Sandbox + Desktop with live provider credentials.
- [x] Demo scenario that runs without an application server.
- [ ] Screenshots/GIF/video as appropriate.
- [ ] Reproducible checked-in sample output.
- [x] Known limitations.
- [x] Competitive-feature research notes with citations to public projects.
- [ ] Final submission checklist.
- [ ] Final end-to-end live test.
- [ ] Final reviewer-oriented walkthrough.

## Competitive feature references reviewed
Feature ideas in the backlog were independently re-expressed after reviewing public OSINT/intelligence projects including OpenCTI, IntelOwl, SpiderFoot, and MISP warning-list concepts, plus additional public OSINT dashboard/framework references recorded during feature discovery. Do not copy source code or proprietary implementation details; use these only as public feature/architecture references.

## Definition of ready
The project is ready only when the major dashboard and operations surfaces work, representative open sources are live, all three Solari products have meaningful tested roles, setup is reproducible, evidence is human-verifiable, tests are green, resource cleanup is proven, the static/no-hosting console can operate without an application server for its documented use cases, and the public repository has passed privacy/secret/proprietary-material review.
