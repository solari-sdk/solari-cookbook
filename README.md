# Solari Cookbook + OSINT Operations Center

This public fork preserves the upstream Solari cookbook examples while developing a production-minded OSINT operations-center showcase around them. The showcase demonstrates public-source acquisition, normalized evidence, isolated transformations, geospatial visualization, explainable correlation, observability, portable investigations, and one backend-independent analyst frontend that supports both static/no-hosting and FastAPI-backed runtime modes.

The project uses only lawful public/open sources for the demonstration. It is not a media-monitoring product and does not include private source inventories, credentials, customer data, or unrelated proprietary logic.

## OSINT showcase

### Static / no-hosting mode

`static-console/` is the canonical analyst workspace. It does not require an application server, database server, PHP, Python runtime, Docker daemon, permanent VM, or background process when used in local/static mode. A modern browser can acquire a CORS-enabled public feed, normalize and retain events in IndexedDB, display a world view, work offline with previously retained investigations, and export/import portable cases.

Current static capabilities include:
- versioned IndexedDB stores for cases, events, entities, relationships, evidence, saved views, source state, notes, watchlists, layouts, preferences, acquisitions, transformations, and artifacts;
- memory-only privacy mode plus local database/cache purge controls;
- browser capability, online/offline, and storage-quota diagnostics;
- a dependency-free global event canvas with no external tile requirement;
- a pure-static USGS earthquake adapter with explicit CORS/network fallback messaging;
- portable investigation manifests and logical-member SHA-256 integrity checks;
- optional AES-256-GCM `.solari-case` encryption using a user passphrase;
- import preview, integrity/secret checks, conflict counts, deterministic merge, and isolated read-only open;
- JSON, CSV, GeoJSON, GraphML, and standalone offline HTML report exports;
- a service-worker/PWA shell for offline-capable local analysis;
- a path-scoped FastAPI runtime adapter that is inactive on normal static hosting and, when mounted at `/workspace/`, synchronizes normalized server events/entities/relationships/evidence/acquisitions/source health into the same browser workspace.

For reproducible local use, serve `static-console/` from any localhost static-file server. Some browsers restrict ES modules, service workers, and secure storage APIs on `file://` origins. The same folder can be deployed unchanged to GitHub Pages, Cloudflare Pages, Netlify, S3-compatible static hosting, or a generic HTTPS server. `python tools/build_static_zip.py` creates a distributable ZIP under ignored `dist/`.

Direct browser-side Solari Browser/Sandbox/Desktop calls are deliberately **not** claimed under the currently documented provider client model. The official cookbook clients use process-environment credentials rather than a browser-targeted credential/CORS flow, so provider execution remains a controlled server/broker responsibility unless that model changes. The optional Solari key field remains page-memory-only scaffolding and is never persisted.

### Server mode

The FastAPI application under `app/` mounts the same checked-in `static-console/` files at `/workspace/`; `/` redirects there. The runtime adapter synchronizes server data into the same analyst workspace and exposes registered-source collection controls. The previous rich server dashboard is preserved at `/server-dashboard` as an advanced operator surface for server-only execution, queue, Solari, workflow, globe, and debugging capabilities rather than being maintained as a second analyst frontend.

The FastAPI application currently provides:
- typed acquisition, source, event, geospatial, evidence, entity, relationship, and case contracts;
- implemented public adapters for USGS earthquakes, NWS active alerts, NOAA SWPC alerts, and the broader registered source set documented in `sources.md`, with explicit capabilities/dependencies and acquisition/parser/record telemetry;
- bounded concurrent multi-source collection with deterministic result ordering and per-source failure preservation;
- SQLite persistence with deterministic IDs, first/last seen state, sighting counts, retained event snapshots, entities/relationships, cases, and case-object links;
- deterministic event-to-source/location graph projection plus bounded neighborhood/path/component queries;
- explainable cross-source correlation candidates using time, title similarity, and optional geographic separation without destructive auto-merge;
- dependency-free geospatial distance, initial bearing, bounding-box/antimeridian, and radius primitives;
- content-addressed SHA-256 artifact storage with MIME/size metadata and load-time integrity verification;
- warning-list matchers, completeness/staleness scoring, and confidence aggregation foundations;
- bounded job/retry/circuit-breaker primitives with explicit failure taxonomy and attempt timing;
- source/acquisition health telemetry, source staleness calculation, parser/response-size/accepted/rejected metrics, and dashboard-safe aggregate metrics;
- read-only event queries with source/category, time-window, bounding-box, and text filters plus cursor pagination;
- evidence, event-history, entity, relationship, case, graph, and correlation endpoints;
- JSON, CSV, GeoJSON, OpenAPI, and typed JSON-schema output;
- liveness, readiness, version, source-dependency, metrics, and configuration/doctor surfaces.

Run the server after installing requirements:

```bash
python -m uvicorn app.main:app --reload
```

Open `/` for the canonical analyst workspace or `/server-dashboard` for the advanced server-only operations view.

The project root update scripts remain the normal setup/update entrypoints on Linux, macOS, and Windows. They validate the repository/branch, require Python 3.11+ and Node.js 20+ where applicable, install dependencies, and run the Python/static-console test suites.

## Project documentation

- `AAA_READ_ME_FIRST.md` — public-repository and evidence rules
- `meta.md` — project/governance state
- `sources.md` — source registry, provenance, and source-routing rules
- `TODO.md` — implementation and submission backlog
- `docs/architecture.md` — initial architecture
- `docs/data-evidence-model.md` — normalized acquisition/event/evidence semantics
- `docs/collector-guide.md` — public source adapter requirements
- `docs/plugin-analyzer-guide.md` — sandboxed analyzer/plugin contract
- `docs/operations-debugging.md` — health/readiness and debugging guidance
- `docs/investigation-case-workflow.md` — case/investigation model and workflow
- `docs/security-public-data-boundary.md` — public-data/security boundary
- `docs/api-versioning.md` — API compatibility and deprecation policy
- `docs/static-no-hosting.md` — static deployment and privacy modes
- `docs/static-architecture.md` — static/no-hosting architecture diagram
- `docs/portable-case-format.md` — portable investigation schema, integrity, and encryption
- `docs/static-threat-model.md` — browser/static security model
- `docs/demo-static-no-hosting.md` — reproducible no-application-server demo
- `docs/competitive-feature-research.md` — public feature references and independent design conclusions

---

## Upstream cookbook examples

The original cookbook is a set of short, runnable examples for [Solari](https://getsolari.com) — cloud browsers, sandboxes, and desktops behind one API key. The examples remain deliberately small and are preserved as compatibility/reference material.

### Cloud browser

| Example | Language | What it shows |
| --- | --- | --- |
| [browser-quickstart-ts](examples/browser-quickstart-ts) | TypeScript | Launch a browser, open a page, read it |
| [browser-quickstart-py](examples/browser-quickstart-py) | Python | Launch a browser, open a page, read it |
| [browser-stealth-proxy-ts](examples/browser-stealth-proxy-ts) | TypeScript | Stealth mode + residential proxy egress |
| [browser-profiles-ts](examples/browser-profiles-ts) | TypeScript | Log in once, reuse the session forever |
| [browser-session-recording-py](examples/browser-session-recording-py) | Python | Record a session, download the replay |

### Sandbox

| Example | Language | What it shows |
| --- | --- | --- |
| [sandbox-quickstart-ts](examples/sandbox-quickstart-ts) | TypeScript | Run a command, write and read files |
| [sandbox-code-interpreter-py](examples/sandbox-code-interpreter-py) | Python | Stateful Python kernel for agent loops |
| [sandbox-port-preview-ts](examples/sandbox-port-preview-ts) | TypeScript | Expose a server in the VM on a public URL |

### Desktop

| Example | Language | What it shows |
| --- | --- | --- |
| [desktop-computer-use-py](examples/desktop-computer-use-py) | Python | Screenshot, click, and type on a Linux GUI |

## Running an upstream example

Each example directory is self-contained. Provide your own Solari key through the environment rather than storing it in repository content.

```bash
cd examples/browser-quickstart-ts
npm install                          # or: pip install -r requirements.txt
export SOLARI_API_KEY=your_key_here
npm start                            # or: python main.py
```

## Which Solari product fits which task?

- **Cloud browser** — browser-native acquisition, rendering, forms, browser state, screenshots, and session recording.
- **Sandbox** — isolated code execution, untrusted parsing, generated extraction logic, transformation, and data jobs.
- **Desktop** — legitimate GUI/screen-driven workflows that cannot be represented cleanly through an API or browser workflow.

## Important upstream behavior

- Browser clients should be closed when the SDK requires it so local retry/control resources do not remain open.
- Recording must be enabled for the browser session that needs a replay.
- Sandbox command APIs take executable + argv rather than implicitly parsing shell syntax.
- Destroy sandbox VMs with `kill()`; dropping a local control channel alone does not terminate the remote VM.
- Sandbox idle timeouts are rolling idle windows rather than hard execution deadlines.

## Links

- Solari docs — [docs.getsolari.com](https://docs.getsolari.com)
- Solari console — [console.getsolari.com](https://console.getsolari.com)
- Solari changelog — [changelog.getsolari.com](https://changelog.getsolari.com)

MIT licensed.