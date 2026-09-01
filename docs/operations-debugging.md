# Operations and debugging

Use `/api/v1/health` for liveness and `/api/v1/ready` for dependency/readiness state once deployed. `/api/v1/source-health` summarizes the latest acquisition outcome by source, and `/api/v1/acquisitions` exposes bounded recent acquisition records including duration.

Collector failures must remain explicit. Do not convert network/parser/schema failures into empty-success results. Acquisition and transformation records should carry correlation-safe identifiers, timings, error type, and diagnostic metadata that excludes credentials/session material.

For the static console, the capabilities panel reports secure-context, IndexedDB, OPFS, Web Crypto, service-worker, File API, File System Access, storage-manager, canvas, and network availability. A direct-source CORS/network failure is reported as a routing limitation and can later be handled by Solari Browser or a narrow broker.

Use root update scripts for routine setup. Generated static ZIPs, runtime SQLite data, caches, logs, and local credentials are runtime/build artifacts and must remain outside version control.
