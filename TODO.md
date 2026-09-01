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
- [ ] Select implementation stack while preserving upstream cookbook examples.
- [ ] Define normalized source/event/evidence schema.
- [ ] Define raw-acquisition object model.
- [ ] Define provenance/transformation chain model.
- [ ] Define entities and relationships model.
- [ ] Define geospatial model and coordinate/precision rules.
- [ ] Define deduplication/correlation strategy.
- [ ] Define source/collector health model.
- [ ] Define execution/job/retry model.
- [ ] Define configuration and secret boundary.
- [ ] Define retention/cleanup policy for browser sessions, recordings, screenshots, raw acquisitions, sandbox outputs, and desktop artifacts.

## Solari Browser
- [ ] Implement generic browser acquisition adapter.
- [ ] Capture canonical URL, redirects, timestamps, rendered HTML/text, screenshot and relevant response metadata.
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
- [ ] Capture stdout/stderr/exit state/timing and safe diagnostic artifacts.
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
- [ ] USGS earthquakes.
- [ ] NOAA/NWS weather alerts.
- [ ] NOAA/NHC tropical cyclone products.
- [ ] NOAA tsunami products.
- [ ] NOAA space weather.
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
- [ ] Additional lawful free/open sources discovered during development.

## Ingestion / normalization
- [ ] Adapter interface and source registry.
- [ ] Raw acquisition persistence.
- [ ] Normalized records.
- [ ] Schema validation.
- [ ] Deterministic identifiers/idempotence.
- [ ] Duplicate detection.
- [ ] Cross-source correlation.
- [ ] Geographic normalization/geocoding strategy.
- [ ] Time normalization and timezone provenance.
- [ ] Entity extraction where appropriate.
- [ ] Confidence/quality scoring.
- [ ] Distinguish observed facts from inferred/enriched values.
- [ ] Field-level evidence references where practical.

## Dashboard
- [ ] Responsive application shell.
- [ ] Global/regional interactive map.
- [ ] Marker clustering.
- [ ] Heat/density layer.
- [ ] Source/layer toggles.
- [ ] Time-window slider.
- [ ] Historical playback.
- [ ] Timeline/event stream.
- [ ] Faceted filters.
- [ ] Geographic filters.
- [ ] Source/category/severity/quality/confidence filters.
- [ ] Full-text/entity search.
- [ ] Saved views/query state.
- [ ] Event detail/evidence drawer.
- [ ] Raw-source view.
- [ ] Provenance/transformation chain.
- [ ] Related-event/entity relationship graph.
- [ ] Aggregate charts/statistics.
- [ ] Geographic drill-down.
- [ ] Source health dashboard.
- [ ] Collector execution dashboard.
- [ ] Browser/Sandbox/Desktop execution views.
- [ ] Failure/retry/debug trace view.
- [ ] Screenshot/session-recording references.
- [ ] Latency telemetry.
- [ ] Cost telemetry when Solari exposes sufficient billing/job data.
- [ ] JSON export.
- [ ] CSV export.
- [ ] GeoJSON export.
- [ ] Read-only API explorer/documentation.

## Debugging / observability
- [ ] Structured logs with correlation/job IDs.
- [ ] Source acquisition timings.
- [ ] Parser timings.
- [ ] Queue/job timings if queues are used.
- [ ] Failure taxonomy.
- [ ] Retry counters and terminal-failure state.
- [ ] Source freshness/staleness detection.
- [ ] Last successful acquisition per source.
- [ ] Schema drift detection.
- [ ] Raw-vs-normalized comparison.
- [ ] Deduplication/correlation explanation view.
- [ ] Health/readiness endpoints.
- [ ] Metrics suitable for dashboard display.
- [ ] Diagnostic mode that does not expose secrets/session material.

## API
- [ ] Read-only events endpoint.
- [ ] Sources/status endpoint.
- [ ] Evidence/provenance endpoint.
- [ ] Entity/relationship endpoint.
- [ ] Health/readiness endpoint.
- [ ] Filters/pagination/time-window support.
- [ ] OpenAPI or equivalent machine-readable contract.

## Cross-platform setup/update
- [x] Require Linux `update.sh`.
- [x] Require Windows `update.ps1`.
- [x] Require macOS `update-macos.sh`.
- [ ] Test fresh checkout on Linux.
- [ ] Test repeat/idempotent Linux update.
- [ ] Test fresh checkout on Windows.
- [ ] Test repeat/idempotent Windows update.
- [ ] Test fresh checkout on macOS or document unavailable validation environment honestly.
- [ ] Test missing `SOLARI_API_KEY` behavior.
- [ ] Test unsupported runtime/tool version behavior.
- [ ] Ensure updater executes tests/build automatically when implementation stack is established.

## Tests / QA
- [ ] Unit tests for normalization/deduplication/provenance.
- [ ] Fixture tests for each source adapter.
- [ ] Live smoke tests for representative public sources.
- [ ] Solari Browser integration tests.
- [ ] Solari Sandbox integration tests.
- [ ] Solari Desktop integration test.
- [ ] Failure/retry/timeout tests.
- [ ] Schema drift tests.
- [ ] UI smoke tests.
- [ ] API contract tests.
- [ ] Accessibility pass.
- [ ] Performance pass with representative event volume.
- [ ] Cleanup/resource-leak tests.

## Documentation / submission
- [ ] Expand README with project showcase while preserving attribution/upstream context.
- [ ] Architecture document and diagram.
- [ ] Data/evidence model documentation.
- [ ] Collector/source authoring guide.
- [ ] Operations/debugging guide.
- [ ] Security/public-data boundary documentation.
- [ ] Cross-platform quickstart.
- [ ] Demo scenario that exercises Browser + Sandbox + Desktop.
- [ ] Screenshots/GIF/video as appropriate.
- [ ] Reproducible sample output.
- [ ] Known limitations.
- [ ] Final submission checklist.
- [ ] Final end-to-end live test.
- [ ] Final reviewer-oriented walkthrough.

## Definition of ready
The project is ready only when the major dashboard and operations surfaces work, representative open sources are live, all three Solari products have meaningful tested roles, setup is reproducible, evidence is human-verifiable, tests are green, resource cleanup is proven, and the public repository has passed privacy/secret/proprietary-material review.
