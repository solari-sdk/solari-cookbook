# Static / no-hosting analyst console

The `static-console/` application is the canonical analyst frontend for both deployment modes. Its local/static workflow requires only static files in a modern browser: acquire a CORS-enabled public source, normalize records in-browser, retain investigation state locally, visualize events, and export a portable investigation. No PHP, Python application server, database server, Docker daemon, permanent VM, or background service is required for this mode.

The FastAPI application mounts these exact checked-in frontend files at `/workspace/`; the project root redirects there in server mode. A small backend-independent runtime adapter activates only on that server mount, reads normalized API records, converts SQLite/API JSON fields back into the shared browser contract, and synchronizes events, entities, relationships, evidence, acquisitions, and source-health state into the same IndexedDB or memory-only workspace. The old rich server operations UI is preserved at `/server-dashboard` for server-only execution/debugging surfaces rather than being maintained as a second analyst frontend.

## Run locally

For the broadest browser support, serve the repository with any static web server and open `/static-console/`. Direct `file://` opening can work for some browsers, but ES modules, service workers, and storage/security APIs are intentionally restricted by some browsers on local-file origins. A localhost static server is therefore the reproducible local path; it is still a no-application-server deployment because the server only transfers static files.

## Deployment targets

The folder can be published unchanged to GitHub Pages, Cloudflare Pages, Netlify, an S3-compatible static website, a generic HTTPS web server, or another static-file platform. The console does not assume a private hostname or provider-specific runtime. Use HTTPS in published deployments so Web Crypto, service workers, OPFS, and related secure-context capabilities remain available.

`python tools/build_static_zip.py` creates `dist/solari-static-console.zip`. The generated `dist/` directory is a build artifact and should not be committed.

## Data and privacy modes

Persistent mode uses IndexedDB stores for cases, events, entities, relationships, evidence metadata, saved views, source state, notes, watchlists, layouts, preferences, artifacts, acquisitions, and transformations. Memory-only privacy mode bypasses IndexedDB for new session state. The purge action removes the local application database and Cache Storage entries. The storage panel reports available browser capabilities and quota usage when the browser exposes them.

The Solari key field is bring-your-own-key scaffolding for evaluator/developer workflows. The current console keeps that value in JavaScript memory only and provides an explicit clear action. Direct Solari Browser/Sandbox/Desktop calls are not claimed because the current documented provider clients use process-environment credentials rather than a browser-targeted credential/CORS model. Sources that fail direct browser fetch with a network/CORS error can use the optional allowlisted broker pattern instead of being silently treated as source failures.

## Offline behavior

The service worker caches the application shell. Existing locally retained investigations remain usable when offline; network acquisition naturally remains unavailable. The console displays online/offline state explicitly. Dynamic `/api/` requests are never inserted into the shell cache, so FastAPI-backed mode cannot accidentally replay a cached API response as if it were current server state.

## FastAPI-backed mode

Run the FastAPI application normally and open `/` or `/workspace/`. The same `static-console/` files are served without a generated copy. `server-runtime.js` activates because the page is mounted under `/workspace/`, synchronizes server data into the shared browser stores, exposes registered-source collection controls, and links to `/server-dashboard` for advanced queue/Solari/workflow/debugging views.

Static hosting at another path does not trigger the server adapter and performs no `/api/v1/` discovery request. This path-scoped behavior is covered by dependency-free unit tests and real Chromium QA so the standalone mode remains genuinely backend-independent.
