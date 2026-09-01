# Static / no-hosting architecture

```text
+---------------------- Canonical analyst frontend ----------------------+
|                                                                        |
|  static-console/                                                       |
|  HTML + CSS + ES modules                                               |
|        |                                                               |
|        +--> Local/static runtime                                       |
|        |      IndexedDB / memory-only mode                             |
|        |      Web Crypto case encryption                              |
|        |      public CORS sources / optional narrow broker             |
|        |      service-worker offline shell                             |
|        |                                                               |
|        +--> FastAPI-mounted runtime                                    |
|               same checked-in frontend at /workspace/                  |
|               server-runtime.js normalizes API rows                    |
|               /api/v1 events/entities/relationships/evidence/etc.      |
|               into the same browser workspace stores                  |
|               optional server collector actions                       |
|                                                                        |
+------------------------------------------------------------------------+
                           portable `.solari-case`
                                  |
                                  v
                   another browser / deployment mode

+---------------------- FastAPI operator surfaces -----------------------+
| /server-dashboard preserves advanced server-only operational views     |
| while the default / route redirects to the canonical /workspace/.      |
+------------------------------------------------------------------------+
```

The canonical analyst interface is now one backend-independent frontend. The same files in `static-console/` run unchanged on a static host and are mounted unchanged by FastAPI at `/workspace/`. Static/local mode performs no FastAPI API probe and retains the no-application-server property. FastAPI mode activates only on the server workspace mount and synchronizes normalized server records into the same IndexedDB/memory workspace contract.

The richer historical server-operations dashboard remains available at `/server-dashboard` because it exposes server-only execution, queue, Solari, workflow, globe, and debugging surfaces that should not be discarded merely to remove frontend duplication. It is an advanced operator surface rather than a second analyst frontend.

The service worker caches only the application shell and explicitly leaves `/api/` requests outside the shell cache. This prevents dynamic server API responses from being mistaken for offline application assets.

Direct Solari calls remain intentionally outside the browser-only runtime. Current official client examples are process-environment clients and do not establish a browser-targeted credential/CORS model. Static mode therefore uses lawful public CORS sources plus optional narrow broker delegation; server mode can use the existing controlled provider integrations without exposing durable provider credentials to browser storage.
