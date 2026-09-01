# Demo scenario — no application server

This scenario demonstrates the browser-only analyst workflow. It does not require the FastAPI process, a database server, PHP, Docker, a permanent VM, or a background daemon.

## Setup

Serve the repository with any static-file server and open `/static-console/`. A static server is recommended over `file://` because browsers restrict ES modules, service workers, IndexedDB, and Web Crypto on local-file origins. No application code executes on that server.

## Walkthrough

1. Confirm the capability panel reports IndexedDB and canvas support. Web Crypto and service-worker support require a secure context (`https://` or a browser-trusted localhost origin).
2. Leave the Solari key empty; the baseline demo does not need provider credentials.
3. Use the built-in USGS earthquake source and select **Fetch and store**.
4. Confirm normalized events appear in the local table and on the dependency-free world canvas.
5. Disconnect the network or use browser offline mode. Reload the installed/cached shell where supported and confirm the retained local investigation remains viewable.
6. Enter a case title and export JSON. Inspect the manifest: it includes schema/tool versions, source identifiers, required capabilities, and SHA-256 integrity values for logical members.
7. Enter a passphrase and export an encrypted `.solari-case`; the passphrase is not written into the bundle.
8. Import the bundle. Review the preview and integrity result before choosing merge or isolated read-only open.
9. Export CSV, GeoJSON, or GraphML derivatives as appropriate.
10. Use **Purge local data** to remove the local IndexedDB database and application Cache Storage entries.

## Expected evidence

A successful run proves that public-source acquisition, normalization, local persistence, visualization, portable investigation export/import, encryption, integrity checking, offline shell behavior, and explicit purge controls can operate without the server-mode application.

Direct browser-side Solari Browser/Sandbox/Desktop orchestration is intentionally excluded from this scenario until provider CORS/browser-client behavior has been verified with evaluator-owned credentials.
