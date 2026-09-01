# Project Metadata

## Project
- **Project name:** Solari OSINT Operations Center
- **Repository:** `tocsindata/solari-cookbook`
- **Purpose:** Public engineering showcase and production-minded OSINT operations dashboard demonstrating Solari cloud browsers, sandboxes, and desktops across acquisition, extraction, enrichment, correlation, evidence preservation, visualization, observability, and debugging.
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
- **Local development URL:** N/A until application shell is selected
- **Production URL:** N/A until deployment target is selected
- **Production runtime/document-root path:** N/A / not selected
- **Production deployment branch/ref:** N/A / not selected
- **Deployment model:** Not selected

## Product Scope
Build a full OSINT operations center that deliberately exercises all three Solari execution surfaces where they provide real value:

1. **Browser acquisition:** dynamic pages, difficult rendering, authenticated/public-session workflows where permitted, stealth/proxy-capable acquisition, screenshots, session recording, source capture.
2. **Sandbox processing:** isolated parsers, generated extraction code, document transforms, normalization, enrichment, correlation, geospatial processing, validation, export generation, and untrusted-input containment.
3. **Desktop workflows:** GUI-only or screen-driven public-source workflows that cannot be represented cleanly as direct HTTP/API/browser automation.
4. **Evidence and provenance:** every derived record should retain sufficient source, timestamp, acquisition, transformation, and evidence metadata for human verification.
5. **Operations dashboard:** maps, timelines, charts, entity/relationship views, filters, search, source health, collector status, retries, latency, debug traces, acquisition replay where available, and export/API views.

### Explicit exclusions
- No media-monitoring product or media-monitoring clone.
- No copying proprietary code, private source inventories, credentials, customer logic, private operational data, or identifying information from unrelated systems or people.
- No repository documentation may name unrelated companies, projects, coworkers, clients, or private individuals.
- Public/open-source techniques may be reimplemented generically from first principles.

## Architecture Principles
- Prefer free/open public data sources and documented public APIs.
- Use source adapters behind a normalized event/evidence contract.
- Preserve raw acquisition separately from normalized/derived records.
- Field-level provenance where practical.
- Deterministic parsing before AI inference when deterministic methods are sufficient.
- AI-derived claims must be attributable to source evidence and distinguish inference from observed fact.
- Idempotent collection and deduplication.
- Explicit source health and failure states; never silently drop failed collectors.
- Treat web content and generated parser code as untrusted input.
- Sandboxed execution for risky transformations.
- Human-verifiable output is a first-class requirement.
- Observability is part of the product, not an afterthought.

## Source Categories Planned
Public/open sources may include natural hazards, earthquakes, volcanoes, wildfire, weather, storms, floods, aviation, maritime, space/weather, infrastructure status, public safety alerts, emergency management, humanitarian events, public government datasets, sanctions/watchlists where legally reusable, public transportation status, environmental sensors, public geospatial datasets, and other lawful open-data sources. Media-monitoring feeds are excluded.

## UI / Analysis Capabilities Planned
- Interactive global/regional map
- Marker clustering and density/heat visualization
- Layer toggles and source overlays
- Time-window slider and historical playback
- Timeline/event stream
- Faceted filters
- Full-text/entity search
- Saved views
- Event detail and evidence drawer
- Source/provenance chain
- Related-entity graph
- Charts and aggregate statistics
- Geographic drill-down
- Confidence/quality filters
- Deduplication/correlation inspection
- Raw acquisition inspection
- Collector/source health dashboard
- Solari browser/sandbox/desktop execution dashboard
- Retry/failure/debug traces
- Session screenshot/recording references where supported
- Latency and cost telemetry where available
- JSON/CSV/GeoJSON export
- Read-only API surface

## Cross-Platform Operator Workflow
Root-level single-entrypoint scripts are required:
- Linux: `./update.sh`
- macOS: `./update-macos.sh`
- Windows PowerShell: `.\update.ps1`

Scripts must be safe to rerun, fail visibly, validate repository identity/branch, install locked dependencies when present, execute applicable tests/builds, and never invent secrets.

## Configuration / Secrets
- Never commit live API keys, tokens, credentials, cookies, private keys, or authenticated session material.
- `SOLARI_API_KEY` and any source-specific credentials must be environment supplied.
- Public sources requiring no credentials are preferred.
- Example environment files must contain placeholders only.
- Debug artifacts must be reviewed for accidental credential/session leakage before being committed or published.

## Prime Prompts Governance
- Governing repository: `tocsindata/prime-prompts`
- Development branch standard: `develop` / `develop/*`.
- Required root governance files: `AAA_READ_ME_FIRST.md`, `meta.md`, `sources.md`, `TODO.md`.
- Repository-neutral output: do not name AI assistants/tools/models in branch names, commits, stored prompts, documentation, comments, fixtures, or changelogs.
- Prime Prompts compliance review status: Partial — initial project bootstrap only
- Prime Prompts revision reviewed: current `main` as of 2026-09-01 UTC; exact commit SHA still to be recorded
- Compliance review timestamp: 2026-09-01T05:55:00Z
- Compliance exceptions/remediation reference: `TODO.md`

## TODO Review
- **TODO path:** `TODO.md`
- **TODO review status:** Initial tracker created; full applicable-rule reconciliation pending
- **TODO last reviewed:** 2026-09-01T05:55:00Z
- **Central TODO mirror:** Pending

## Security-Hygiene Audit
- **Security-hygiene audit status:** Partial
- **Security-hygiene audit timestamp:** 2026-09-01T05:55:00Z
- **Current-tree secret scan:** Not yet completed
- **Git-history secret scan:** Not yet completed
- **`.gitignore` review:** Pending
- **Sensitive-file tracking review:** Pending
- **Security findings/remediation reference:** `TODO.md`
- **Live credential remediation required/status:** None known / verification pending
- **Live credential remediation completed:** N/A
- **Repository/current-tree credential cleanup:** Pending scan
- **Git-history remediation:** Pending scan
- **Post-remediation verification:** N/A unless findings occur

## Communications
- **Slack:** None assigned.

## Monitoring / Analytics
- **Application observability:** Built into project scope; implementation pending.
- **External uptime monitoring:** N/A until deployed.
- **Matomo:** N/A until a public application hostname is assigned.
- **matomo_id:** N/A

## Administrative
- **Owner / operator:** Tocsin Data
- **Approval authority:** Repository owner
- **Issue/task tracking:** Root `TODO.md`; central mirror pending

## Notes
Never store passwords, API keys, tokens, private keys, session cookies, private source inventories, or other secrets in this file.

## Maintenance
- **Metadata last updated:** 2026-09-01T05:55:00Z
- **Metadata updated for:** Initial full-scope OSINT showcase bootstrap
