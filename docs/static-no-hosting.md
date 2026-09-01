# Static / no-hosting analyst console

The `static-console/` application is intentionally independent of the FastAPI service. Its baseline workflow requires only static files in a modern browser: acquire a CORS-enabled public source, normalize records in-browser, retain investigation state locally, visualize events, and export a portable investigation. No PHP, Python application server, database server, Docker daemon, permanent VM, or background service is required for this mode.

## Run locally

For the broadest browser support, serve the repository with any static web server and open `/static-console/`. Direct `file://` opening can work for some browsers, but ES modules, service workers, and storage/security APIs are intentionally restricted by some browsers on local-file origins. A localhost static server is therefore the reproducible local path; it is still a no-application-server deployment because the server only transfers static files.

## Deployment targets

The folder can be published unchanged to GitHub Pages, Cloudflare Pages, Netlify, an S3-compatible static website, a generic HTTPS web server, or another static-file platform. The console does not assume a private hostname or provider-specific runtime. Use HTTPS in published deployments so Web Crypto, service workers, OPFS, and related secure-context capabilities remain available.

`python tools/build_static_zip.py` creates `dist/solari-static-console.zip`. The generated `dist/` directory is a build artifact and should not be committed.

## Data and privacy modes

Persistent mode uses IndexedDB stores for cases, events, entities, relationships, evidence metadata, saved views, source state, notes, watchlists, layouts, preferences, and artifacts. Memory-only privacy mode bypasses IndexedDB for new session state. The purge action removes the local application database and Cache Storage entries. The storage panel reports available browser capabilities and quota usage when the browser exposes them.

The Solari key field is bring-your-own-key scaffolding for evaluator/developer workflows. The current console keeps that value in JavaScript memory only and provides an explicit clear action. Direct Solari Browser/Sandbox/Desktop calls are not claimed until browser-side provider CORS/API support is verified. Sources that fail direct browser fetch with a network/CORS error are reported as requiring Solari Browser or an optional broker rather than being silently treated as source failures.

## Offline behavior

The service worker caches the application shell. Existing locally retained investigations remain usable when offline; network acquisition naturally remains unavailable. The console displays online/offline state explicitly.

## Server mode compatibility

FastAPI remains available for shared/team/server use. Static mode and server mode are separate deployment choices around the same normalized event/evidence concepts; static mode is not a degraded page that depends on the FastAPI process.
