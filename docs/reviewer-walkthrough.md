# Reviewer walkthrough

This walkthrough is designed to show the project quickly without requiring private infrastructure or undocumented setup.

## 1. Understand the deployment model
Read the README and architecture documentation first. The project deliberately supports two modes: a static/no-hosting single-user analyst console and an optional FastAPI server mode. The static console keeps investigations in browser storage unless the analyst explicitly exports them.

## 2. Start with the no-hosting console
Serve the `static-console/` directory from any simple static origin or use the documented static build artifact. No Python application server, database service, Docker daemon, or permanent VM is required. Confirm the browser capability/status panel, offline-capable shell, local storage status, privacy mode, and credential state.

Use the built-in public USGS adapter to collect the documented GeoJSON feed when network/CORS access is available. The console retains normalized events, acquisition metadata, a SHA-256-addressed raw artifact, evidence linkage, source state, and source health. Network/CORS failures are explicit rather than silently interpreted as empty data.

## 3. Inspect and analyze locally
Use shared source/category/severity/quality/time/geographic filters, inspect the local map and timeline table, save a view, and examine the interactive entity/relationship graph when graph records are present. Add a public/user-supplied artifact to see content-addressed deduplication and evidence linkage.

## 4. Exercise portable investigations
Create a portable case from local state. Review JSON, CSV, GeoJSON, GraphML, and offline HTML report derivatives. Export an encrypted `.solari-case` with a passphrase, then preview/import it. The import path validates schema, size, integrity and secret/session patterns before mutation and supports isolated read-only open plus conflict-safe merge.

## 5. Inspect server/team mode
Start the FastAPI application using the documented updater/quickstart. Review `/api/v1/health`, `/api/v1/ready`, the read-only API explorer, source registry/health, current events, acquisition telemetry, entity/relationship/case APIs, artifacts, observables/reconnaissance, alerts/watchlists, jobs, correlation candidates and exports. The server dashboard exposes map/timeline filtering, evidence inspection, aggregate category statistics, source attribution, source health and recent collector executions.

## 6. Review evidence and safety boundaries
Follow one event from acquisition identity to normalized fields and evidence references. Compare raw-versus-normalized state and note the observed/transformed/inferred distinction. Review the public-target SSRF checks, bounded XML/JSON parsing, source cadence policies, schema-drift handling, immutable raw-object archive, content-addressed artifact vault and public-release scanner.

## 7. Solari-specific live demonstration
The repository includes Browser and Sandbox integration foundations, but live provider execution requires operator/evaluator-owned credentials. Before a final submission demonstration, run the documented Browser, Sandbox and selected Desktop workflows and record non-sensitive evidence that sessions are cleaned up. Direct browser-side Solari orchestration from the static console must not be claimed until provider CORS/browser-client support is verified.

## 8. Reproducibility and final review
Run the exact update entrypoint for the target operating system, execute Python/static tests, and check CI on the exact commit being reviewed. Consult `docs/submission-checklist.md` for the remaining manual/live/public-release gates. The project should not be described as submission-ready until those gates are evidenced.
