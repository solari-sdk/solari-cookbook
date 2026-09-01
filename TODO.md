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
- [ ] Record exact Prime Prompts commit SHA used for compliance review.
- [ ] Create/synchronize central Prime Prompts TODO mirror.
- [ ] Add repository to applicable Prime Prompts work-repository registry.
- [ ] Complete applicable Prime Prompts compliance review.
- [ ] Complete current-tree secret scan.
- [ ] Complete Git-history secret scan.
- [ ] Review `.gitignore` and sensitive/generated-file exclusions.
- [ ] Perform final public-release scan for private names, unrelated project/company identifiers, credentials, proprietary material, and restricted data.

## Product architecture
- [x] Select implementation stack while preserving upstream cookbook examples.
- [x] Define normalized source/event/evidence schema.
- [x] Define raw-acquisition object model.
- [ ] Define provenance/transformation chain model.
- [ ] Define entities and relationships model.
- [x] Define baseline geospatial point model and coordinate rules.
- [ ] Define deduplication/correlation strategy beyond deterministic source IDs.
- [x] Define source/collector health model.
- [ ] Define full execution/job/retry model.
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
- [ ] Implement generic sandbox job adapter.
- [ ] Run parsing/transformation in isolated sandbox.
- [ ] Demonstrate generated parser/extraction logic safely inside sandbox.
- [ ] Demonstrate document/data transformation.
- [ ] Demonstrate geospatial/enrichment computation.
- [ ] Capture stdout/stderr/result/error/timing and safe diagnostic artifacts.
- [ ] Reuse stateful code contexts for bounded multi-step analysis where useful.
- [ ] Ensure VM termination/cleanup on success and failure.
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
- [ ] Duplicate detection across different source IDs.
- [ ] Cross-source correlation.
- [ ] Geographic normalization/geocoding strategy.
- [ ] Time normalization and timezone provenance.
- [ ] Entity extraction where appropriate.
- [x] Baseline confidence/quality scoring field.
- [x] Distinguish observed facts from transformed/inferred evidence types.
- [x] Field/source-path evidence references.
- [ ] First-seen / last-seen tracking.
- [ ] Observation frequency / sighting counts.
- [ ] Immutable raw-object archive with content-addressed lookup.
- [ ] Schema versioning and migrations for normalized event contracts.
- [ ] Source-specific rate limiting and quotas.
- [ ] Result caching with explicit freshness TTLs.
- [ ] Parallel/concurrent multi-source collection.
- [ ] Multi-target collection jobs.
- [ ] Fan-out/fan-in enrichment pipelines.
- [ ] Source adapter capability descriptors.
- [ ] Source adapter dependency graph.
- [ ] Per-field conflict tracking when sources disagree.
- [ ] Preferred-value selection with provenance preserved.
- [ ] Confidence aggregation across independent sources.
- [ ] Observation supersession/history rather than destructive overwrite.

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
- [ ] JSON export.
- [ ] CSV export.
- [ ] GeoJSON export.
- [ ] GEXF/GraphML graph export.
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
- [ ] Investigation/case containers.
- [ ] Case priority, status, owner and tags.
- [ ] Case-scoped event/entity/evidence collections.
- [ ] Case activity timeline.
- [ ] Case notes with Markdown.
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
- [ ] Case archive/restore.
- [ ] Case export bundle.
- [ ] Analyst-ready report generation from a case.
- [ ] Graph snapshot in generated reports.
- [ ] Timeline snapshot in generated reports.
- [ ] Source/evidence appendix in generated reports.
- [ ] Reproducibility manifest showing source IDs, timestamps and transformations used in a report.

## Knowledge graph / entity intelligence — competitive backlog
- [ ] Persistent knowledge graph abstraction over entities and relationships.
- [ ] Entity types for location, organization, infrastructure, domain, IP, URL, email, username/alias, phone, vessel, aircraft, satellite and other lawful public identifiers.
- [ ] Typed relationship edges.
- [ ] Edge confidence scoring.
- [ ] Edge provenance.
- [ ] First-seen and last-seen on entities/relationships.
- [ ] Interactive graph visualization.
- [ ] Node expansion/pivoting.
- [ ] Neighborhood exploration with depth limits.
- [ ] Graph path finding between entities.
- [ ] Temporal graph filtering.
- [ ] Geographic graph filtering.
- [ ] Graph clustering/community detection.
- [ ] Relationship inference separated visibly from observed relationships.
- [ ] Auto-correlation rules.
- [ ] Correlation explanation view.
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
- [ ] Pluggable analyzers.
- [ ] Pluggable ingestors.
- [ ] Pluggable visualizers.
- [ ] Pluggable exporters/connectors.
- [ ] Plugin manifest/schema.
- [ ] Plugin capability discovery.
- [ ] Plugin isolation through Solari Sandbox when practical.
- [ ] Per-plugin timeout/resource limits.
- [ ] Per-plugin provenance and execution trace.
- [ ] One-click re-run of prior analysis with current source data.
- [ ] Diff previous vs current analysis results.
- [ ] Batch/multi-target analysis jobs.
- [ ] Queue prioritization and concurrency controls.

## Data quality / false-positive controls — competitive backlog
- [ ] Warning-list framework for known benign/public/common values.
- [ ] Exact-string warning-list matching.
- [ ] Substring warning-list matching.
- [ ] Hostname/domain warning-list matching.
- [ ] CIDR warning-list matching.
- [ ] Regex warning-list matching.
- [ ] Analyst allowlist/blocklist annotations.
- [ ] False-positive triage state.
- [ ] True-positive / false-positive / suspicious analyst disposition where applicable.
- [ ] Duplicate/correlation suppression rules.
- [ ] Source reliability scoring separate from event confidence.
- [ ] Data completeness score.
- [ ] Staleness score.
- [ ] Contradiction/conflict flag when authoritative sources disagree.
- [ ] Schema-drift quarantine instead of silent ingestion.
- [ ] Validation error inbox for malformed source records.
- [ ] Manual correction overlay preserving original source data.

## Evidence vault / artifact management — competitive backlog
- [ ] Content-addressed artifact store.
- [ ] HTML/text raw capture retention.
- [ ] Screenshot artifact retention.
- [ ] Browser recording artifact retention.
- [ ] Sandbox output artifact retention.
- [ ] Desktop screenshot/video artifact retention where appropriate.
- [ ] File hash and MIME metadata.
- [ ] Artifact preview.
- [ ] Artifact tags.
- [ ] Artifact-to-case/entity/event relationships.
- [ ] Evidence chain-of-custody metadata for demo purposes.
- [ ] Artifact retention policies.
- [ ] Deduplicate identical artifacts by hash.
- [ ] Export evidence bundle with manifest/checksums.
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
- [ ] Distance/bearing calculations.
- [ ] Proximity correlation between events/entities.
- [ ] Bounding-box/polygon filters.
- [ ] Administrative boundary intersection.
- [ ] Reverse geocoding from open datasets.
- [ ] Place-name gazetteer lookup.
- [ ] Coordinate precision/uncertainty visualization.
- [ ] Great-circle route visualization.
- [ ] Public satellite orbital/TLE visualization.
- [ ] Optional 3D terrain/globe visualization.
- [ ] Tile/layer attribution management.
- [ ] Offline/local map-cache option where licensing permits.

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
- [ ] Parser timings.
- [ ] Queue/job timings if queues are used.
- [ ] Failure taxonomy.
- [ ] Retry counters and terminal-failure state.
- [ ] Source freshness/staleness detection.
- [x] Last acquisition per source backend query.
- [ ] Schema drift detection.
- [ ] Raw-vs-normalized comparison.
- [ ] Deduplication/correlation explanation view.
- [x] Health endpoint.
- [x] Source-health backend endpoint.
- [ ] Readiness endpoint distinct from liveness.
- [ ] Metrics suitable for dashboard display.
- [ ] Diagnostic mode that does not expose secrets/session material.
- [ ] Per-job execution timeline/Gantt view.
- [ ] Queue depth and worker utilization.
- [ ] Source response-size telemetry.
- [ ] Records accepted/rejected per run.
- [ ] Transformation-step timing.
- [ ] Resource-leak detection for Solari browser/sandbox/desktop sessions.
- [ ] Cost-per-job/source telemetry where provider data allows.
- [ ] Collector circuit breaker after repeated failures.
- [ ] Automated recovery after cooldown.

## API / interoperability
- [x] Read-only events endpoint.
- [x] Sources/status endpoint foundation.
- [ ] Evidence/provenance endpoint.
- [ ] Entity/relationship endpoint.
- [x] Health endpoint.
- [ ] Readiness endpoint.
- [x] Basic filters/limits.
- [ ] Cursor pagination.
- [ ] Time-window filters.
- [ ] Bounding-box/geospatial filters.
- [ ] Full-text search endpoint.
- [ ] Graph query endpoint.
- [ ] Case/investigation endpoint.
- [ ] Artifact/evidence endpoint.
- [ ] Job/execution endpoint.
- [x] OpenAPI generation through FastAPI.
- [ ] WebSocket/SSE live updates.
- [ ] GraphQL evaluation for graph-heavy client queries.
- [ ] STIX 2.x interoperability where appropriate.
- [ ] MISP-compatible export/import evaluation for relevant cyber observables only.
- [ ] Generic JSON schema export.
- [ ] API versioning/deprecation policy.

## Collaboration / governance backlog
- [ ] Local single-user mode remains default for demo simplicity.
- [ ] Optional multi-user architecture design.
- [ ] Role-based access control design if multi-user mode is implemented.
- [ ] Immutable analyst action audit log.
- [ ] Shareable saved views without leaking secrets.
- [ ] Investigation assignment/work queue.
- [ ] Analyst handoff notes.
- [ ] Review/approval status on derived conclusions.
- [ ] Data/source license and attribution registry surfaced in UI.
- [ ] Per-source terms/usage notes.
- [ ] Public-source legal/ethical boundary page.

## Packaging / deployment — competitive backlog
- [ ] Dockerfile.
- [ ] Docker Compose stack.
- [ ] Healthchecks in container definitions.
- [ ] Optional PostgreSQL backend for larger deployments.
- [ ] Optional Redis queue/cache for concurrent jobs.
- [ ] Optional S3-compatible artifact storage.
- [ ] Migration framework if database schema grows beyond simple bootstrap.
- [ ] Background worker process.
- [ ] Scheduler process.
- [ ] Horizontal worker scaling design.
- [ ] Configuration validation command.
- [ ] Doctor/diagnostics command.
- [ ] CLI client in addition to web UI.
- [ ] Machine-readable version/build metadata endpoint.

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
- [ ] Test unsupported runtime/tool version behavior.
- [x] Ensure updater executes tests automatically for current Python stack.

## Tests / QA
- [x] Unit tests for baseline normalization/idempotence/provenance.
- [ ] Fixture tests for every source adapter.
- [ ] Live smoke tests for representative public sources.
- [ ] Solari Browser integration tests with live key.
- [ ] Solari Sandbox integration tests.
- [ ] Solari Desktop integration test.
- [ ] Failure/retry/timeout tests.
- [ ] Schema drift tests.
- [ ] UI smoke tests.
- [ ] API contract tests.
- [ ] Accessibility pass.
- [ ] Performance pass with representative event volume.
- [ ] Cleanup/resource-leak tests.
- [ ] Migration/upgrade tests.
- [ ] Data-retention cleanup tests.
- [ ] Graph integrity tests.
- [ ] Correlation explanation tests.
- [ ] Report reproducibility tests.
- [ ] Public-release/private-name scanner test.
- [ ] Secret-pattern scanner in CI.

## Documentation / submission
- [ ] Expand README with project showcase while preserving attribution/upstream context.
- [x] Initial architecture document and diagram.
- [ ] Data/evidence model documentation.
- [ ] Collector/source authoring guide.
- [ ] Plugin/analyzer authoring guide.
- [ ] Operations/debugging guide.
- [ ] Investigation/case workflow guide.
- [ ] Security/public-data boundary documentation.
- [ ] Cross-platform quickstart.
- [ ] Demo scenario that exercises Browser + Sandbox + Desktop.
- [ ] Screenshots/GIF/video as appropriate.
- [ ] Reproducible sample output.
- [ ] Known limitations.
- [ ] Competitive-feature research notes with citations to public projects.
- [ ] Final submission checklist.
- [ ] Final end-to-end live test.
- [ ] Final reviewer-oriented walkthrough.

## Competitive feature references reviewed
Feature ideas in the backlog were independently re-expressed after reviewing public OSINT/intelligence projects including OSIF, OpenCTI, IntelOwl, SpiderFoot, Axiom, Velocity, Palantir-OSINT, Strategic OSINT Dashboard, and MISP warning-list concepts. Do not copy source code or proprietary implementation details; use these only as public feature/architecture references.

## Definition of ready
The project is ready only when the major dashboard and operations surfaces work, representative open sources are live, all three Solari products have meaningful tested roles, setup is reproducible, evidence is human-verifiable, tests are green, resource cleanup is proven, and the public repository has passed privacy/secret/proprietary-material review.
