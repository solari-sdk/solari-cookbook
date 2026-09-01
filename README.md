# Solari Cookbook + OSINT Operations Center

This public fork preserves the upstream Solari cookbook examples while developing a production-minded OSINT operations-center showcase around them. The showcase demonstrates public-source acquisition, normalized evidence, isolated transformations, geospatial visualization, observability, portable investigations, and two deployment modes: a FastAPI server mode and a static/no-hosting analyst console.

The project uses only lawful public/open sources for the demonstration. It is not a media-monitoring product and does not include private source inventories, credentials, customer data, or unrelated proprietary logic.

## OSINT showcase

### Static / no-hosting mode

`static-console/` is a browser-only analyst workspace that does not require an application server, database server, PHP, Python runtime, Docker daemon, permanent VM, or background process. A modern browser can acquire a CORS-enabled public feed, normalize and retain events in IndexedDB, display a world view, work offline with previously retained investigations, and export/import portable cases.

Current static capabilities include:
- versioned IndexedDB stores for cases, events, entities, relationships, evidence, saved views, source state, notes, watchlists, layouts, preferences, and artifacts;
- memory-only privacy mode plus local database/cache purge controls;
- browser capability, online/offline, and storage-quota diagnostics;
- a dependency-free global event canvas;
- a pure-static USGS earthquake adapter with explicit CORS/network fallback messaging;
- portable investigation manifests and logical-member SHA-256 integrity checks;
- optional AES-256-GCM `.solari-case` encryption using a user passphrase;
- import preview, integrity/secret checks, conflict counts, deterministic merge, and isolated read-only open;
- JSON, CSV, GeoJSON, and GraphML derivative exports;
- a service-worker/PWA shell for offline-capable local analysis.

For reproducible local use, serve `static-console/` from any localhost static-file server. Some browsers restrict ES modules, service workers, and secure storage APIs on `file://` origins. The same folder can be deployed unchanged to GitHub Pages, Cloudflare Pages, Netlify, S3-compatible static hosting, or a generic HTTPS server. `python tools/build_static_zip.py` creates a distributable ZIP under ignored `dist/`.

Direct browser-side Solari Browser/Sandbox/Desktop calls are deliberately **not** claimed until provider browser/CORS behavior is verified. The Solari key field is bring-your-own-key scaffolding and currently keeps the value in page memory only.

### Server mode

The FastAPI application under `app/` currently provides:
- typed acquisition, source, event, geospatial, and evidence contracts;
- implemented public adapters for USGS earthquakes, NWS active alerts, and NOAA SWPC alerts;
- SQLite persistence with deterministic IDs, first/last seen state, sighting counts, and retained event snapshots;
- source/acquisition health telemetry and source staleness calculation;
- read-only event queries with source/category, time-window, bounding-box, and text filters;
- evidence and event-history endpoints;
- JSON, CSV, and GeoJSON output;
- liveness, readiness, version, OpenAPI, and JSON-schema surfaces.

Run the server after installing requirements:

```bash
python -m uvicorn app.main:app --reload
```

The project root update scripts remain the normal setup/update entrypoints on Linux, macOS, and Windows.

## Project documentation

- `AAA_READ_ME_FIRST.md` — public-repository and evidence rules
- `meta.md` — project/governance state
- `sources.md` — source registry, provenance, and source-routing rules
- `TODO.md` — implementation and submission backlog
- `docs/architecture.md` — initial architecture
- `docs/data-evidence-model.md` — normalized acquisition/event/evidence semantics
- `docs/collector-guide.md` — public source adapter requirements
- `docs/operations-debugging.md` — health/readiness and debugging guidance
- `docs/static-no-hosting.md` — static deployment and privacy modes
- `docs/portable-case-format.md` — portable investigation schema, integrity, and encryption
- `docs/static-threat-model.md` — browser/static security model

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
