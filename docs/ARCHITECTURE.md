# Solari OSINT Operations Center — Architecture

## Mission

Build a public-source intelligence operations center that demonstrates Solari Browser, Sandbox, and Desktop as disposable execution surfaces around a normalized, evidence-first data system.

This is not a media-monitoring application. Sources are public/open operational datasets, hazard feeds, public infrastructure/status sources, government datasets, environmental sensors, public safety alerts, transportation feeds, watchlists, and other lawful open-data systems.

## Design goals

1. **Evidence before inference.** Every normalized observation can point back to the acquired source material that supports it.
2. **Disposable execution.** Browser, sandbox, and desktop sessions are jobs, not pets. They must be bounded, observable, and cleaned up.
3. **Adapter isolation.** Every source implements the same collector contract and produces normalized records.
4. **Raw + normalized.** Preserve enough raw acquisition metadata to reproduce and debug transformations without forcing the dashboard to understand source-specific formats.
5. **Public-safe by default.** No committed credentials, private endpoints, private source inventories, session secrets, or unrelated proprietary logic.
6. **Operational transparency.** Failures, retries, stale sources, schema drift, execution timing, and correlation decisions are visible in the UI.

## Runtime topology

```text
Public/open sources
      |
      +--> Direct API/feed adapters
      |
      +--> Solari Browser jobs --------+
      |                                |
      +--> Solari Desktop jobs --------+--> Raw acquisition envelope
                                       |
                                       v
                              Solari Sandbox jobs
                         parse / normalize / enrich
                                       |
                                       v
                              Normalized evidence store
                              /        |         \
                             /         |          \
                         events     entities     executions
                           |            |             |
                           +------------+-------------+
                                        |
                                        v
                                FastAPI application
                                        |
                      +-----------------+------------------+
                      |                 |                  |
                    API             Dashboard          Debug/ops
```

## Application stack

The first implementation uses:

- **Python 3.12+** for collectors, orchestration, API, tests, and Solari integrations.
- **FastAPI** for the application/API layer.
- **Pydantic** for contracts and validation.
- **SQLite** for zero-friction local development, with storage interfaces kept narrow enough to permit PostgreSQL later.
- **Server-rendered HTML + lightweight browser JavaScript** initially, to keep the project reproducible and focused on the collection/execution system rather than framework scaffolding.
- **MapLibre GL JS** for mapping when the dashboard map is added.

The upstream cookbook examples remain intact under `examples/`.

## Core domains

### Source

A registered public/open data source. Important fields include stable source ID, name, category, transport, authoritative URL, polling expectations, license/terms notes, and current health state.

### Acquisition

One attempt to acquire data. The acquisition envelope records:

- job/correlation ID
- source ID
- acquisition method (`api`, `feed`, `browser`, `desktop`)
- requested URL or target
- canonical/final URL where relevant
- start/end timestamps
- HTTP/status metadata where relevant
- raw payload reference or inline fixture-safe payload
- screenshot/recording references when available
- content hash
- success/failure state and error taxonomy

### Observation/Event

A normalized public-source observation suitable for search, mapping, filtering, correlation, and export. Events are source-agnostic and may represent earthquakes, alerts, wildfire detections, storms, transportation disruptions, sanctions records, public emergency notices, environmental readings, and other operationally meaningful open data.

### Evidence

A record linking a normalized field or claim to its supporting acquisition. Evidence distinguishes:

- observed source fact
- deterministic transformation
- inferred/enriched value

### Entity / relationship

Optional normalized people/organizations/assets/places/vehicles/facilities or other entities from lawful public datasets, with explicit relationship provenance.

### Execution

Operational record for direct collectors and Solari Browser/Sandbox/Desktop work. It captures lifecycle state, timings, retries, resource identifiers safe for public diagnostics, and sanitized errors.

## Collector contract

Every collector must:

1. expose stable metadata;
2. fetch only its declared public source(s);
3. return a raw acquisition envelope;
4. normalize through deterministic code where possible;
5. validate output against the shared event/evidence contracts;
6. create deterministic IDs to make repeated collection idempotent;
7. classify errors rather than swallowing them;
8. never log secrets or sensitive session material;
9. provide fixtures for offline tests;
10. declare whether it requires direct HTTP, Solari Browser, Solari Sandbox, or Solari Desktop.

## Solari roles

### Browser

Use when browser rendering is genuinely required: JavaScript applications, browser-only navigation state, screenshots, public session workflows, or replay/debug value. Direct documented APIs remain direct API adapters.

### Sandbox

Use for transformations that benefit from isolation: generated extraction logic, document conversion, untrusted source artifacts, parser experimentation, geospatial processing, or dependency-heavy analysis. Sandbox code must produce a validated artifact back to the host and terminate the VM on every path.

### Desktop

Use for legitimate public GUI-only workflows where browser/API automation is not a faithful representation of the source interaction. Desktop workflows must have a clear reason to exist and normalize their observations into the same evidence model.

## Failure taxonomy

Initial taxonomy:

- `network_error`
- `timeout`
- `http_error`
- `rate_limited`
- `source_unavailable`
- `schema_drift`
- `parse_error`
- `validation_error`
- `solari_session_error`
- `resource_cleanup_error`
- `configuration_error`
- `unknown_error`

Failures are records. A collector that failed silently is considered broken even if the rest of the system is healthy.

## Data quality

Every event carries quality metadata derived from objective signals such as source authority, completeness, freshness, location precision, timestamp precision, corroboration, and transformation depth. A numerical score must always be explainable; opaque AI confidence alone is insufficient.

## Security and public-release boundary

The repository is public. Production credentials are environment-only. Test fixtures must be public data or synthetic data. Browser recordings, screenshots, cookies, debug dumps, and generated artifacts are runtime data and are ignored by default. Before any artifact is intentionally committed, it must be reviewed as public-release material.

## Development sequence

1. contracts and storage;
2. direct public-source adapter + fixtures;
3. API and dashboard shell;
4. operations/execution model;
5. Solari Browser acquisition;
6. Solari Sandbox transformations;
7. Solari Desktop workflow;
8. source expansion, correlation, visualization, observability, and submission polish.
