# Reviewer Walkthrough

This walkthrough is designed to let a reviewer understand the project quickly without implying that credential-dependent or live-only capabilities have been exercised when they have not.

## 1. Start with the deployment choice

The project has two deliberate operating modes that share the same public-source/evidence principles:

- **Static/no-hosting analyst mode:** serve `static-console/` from a static host or local HTTP server. Investigation state remains in browser storage (or memory-only privacy mode); no FastAPI process or database server is required.
- **Server/team mode:** run the FastAPI application for shared persistence, collector execution, API access, job telemetry, source health, cases, graph data, artifacts, workflows, alerts, and richer operational surfaces.

Use the static mode first if the goal is to understand the project's unusual deployment model. Use server mode next to inspect the broader operations-center architecture.

## 2. Static/no-hosting path

Open the static console and review the capabilities/storage panel. The console reports whether the browser exposes IndexedDB, OPFS, Web Crypto, service workers, File APIs, storage estimates, and online status.

Run the `USGS Earthquakes` public-source adapter. The console attempts the public HTTPS/GeoJSON request directly in the browser. A successful acquisition is normalized, retained in IndexedDB, mapped on the dependency-free world view, recorded in collector/source-health state, and preserved as a SHA-256-addressed raw acquisition artifact.

If the browser cannot complete a source request because of CORS/network restrictions, an evaluator can enter an optional broker endpoint. The console retries through that endpoint; no broker address is embedded in the static build. `static-broker/` documents the bounded reference worker. The worker is intentionally not a case/database/application backend.

Inspect filters, saved views, local artifacts, relationship graph, portable case export, encrypted `.solari-case` export/import, integrity preview, conflict-safe merge, read-only opening, derivative CSV/GeoJSON/GraphML export, and offline HTML report generation. Toggle memory-only privacy mode to see the local-persistence boundary.

## 3. Server operations-center path

Start the normal server-mode application using the documented platform updater/quickstart. The dashboard exposes:

- source/category/time/search/quality filtering;
- marker, cluster, and density map modes;
- event stream and evidence inspection;
- entity/relationship graph;
- source-health and acquisition telemetry;
- aggregate category statistics;
- public-source attribution/usage notes; and
- explainable correlation candidates that do not auto-merge independent source records.

The read-only API explorer documents the GET surfaces. The full OpenAPI contract additionally exposes bounded collection and analyst-workspace operations.

## 4. Public-source breadth

The source registry is the authority for what is implemented versus merely planned. Current credential-free/configuration-bounded baselines cover earthquakes, NWS alerts, space weather, NHC products, tsunami bulletins, OpenFEMA, GDACS, CelesTrak weather satellites, OFAC SDN, USGS elevated-volcano status, USGS Water latest continuous observations, NOAA NDBC latest environmental observations, and EPA AirNow daily air-quality data. NASA FIRMS and ReliefWeb adapters exist but require evaluator/user-owned configuration described in `sources.md`.

No source is treated as intelligence simply because it was fetched. Each adapter retains source identity, acquisition metadata, deterministic record identity, evidence path, and interpretation limits. Preliminary measurements, centroids, list membership, and environmental observations retain their source semantics rather than being promoted into unsupported conclusions.

## 5. Evidence, cases, and reproducibility

Inspect the common event/evidence contracts and the content-addressed artifact system. Cases can retain events, entities, relationships, evidence, notes, artifacts, activity history, review state, and reproducibility metadata. Portable bundles carry checksums and can be encrypted without exporting API keys, cookies, or session material.

`samples/normalized-public-source.sample.json` is a deterministic checked-in fixture rather than a claimed live observation. It is validated by the test suite against the current acquisition/event contracts so reviewers have a stable example even when external networks are unavailable.

## 6. Solari-specific execution

Browser, Sandbox, and Desktop integrations are intentionally distinguished from ordinary public API/feed collection. Browser is for browser-native acquisition/evidence, Sandbox for isolated execution/transformation, and Desktop for legitimate GUI-only workflows.

Do not infer live completion from adapter code alone. The final submission checklist requires live evaluator-owned credentials and an actual end-to-end run before Browser/Sandbox/Desktop demonstration items are considered complete. Where live provider access is unavailable, the repository preserves unit-tested lifecycle, cleanup, bounded execution, and program-generation foundations but leaves the live TODO unchecked.

## 7. Security and public-release boundary

Review `AAA_READ_ME_FIRST.md`, the static threat model, retention/cleanup policy, public-source boundary documentation, source registry, and CI workflow. The CI path runs Python tests, static-console Node tests, and the public-release scanner. Imported content is treated as untrusted; browser-side source JavaScript is never executed in the analyst origin, and generated parsing code belongs in the isolated sandbox path rather than `eval`/`Function`.

## 8. Final verification

Before treating the repository as submission-ready, use `docs/submission-checklist.md`. In particular, live source smoke tests, live Solari Browser/Sandbox/Desktop runs, cross-platform fresh/repeat updates, browser accessibility/smoke checks, final history/current-tree scanning, and exact-commit end-to-end verification must remain explicit gates rather than optimistic claims.
