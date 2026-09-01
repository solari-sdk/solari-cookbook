# Known limitations

- Live Solari Browser, Sandbox, and Desktop integration tests require an evaluator/operator-provided `SOLARI_API_KEY`; this repository does not contain one.
- Direct browser-side calls from the static console to Solari are not claimed until provider CORS/browser-client behavior is verified.
- Static and FastAPI modes currently share domain semantics and portable-case concepts, but they do not yet use one identical client implementation or one fully identical serialized event shape.
- The static console currently has one direct public CORS adapter (USGS earthquakes); other server adapters have not yet been promoted to static adapters.
- The static world view is dependency-free and intentionally simple; it is not yet a tiled interactive GIS with clustering, heatmaps, polygon layers, or 3D globe support.
- Portable-case v2 integrity covers logical JSON members. Binary artifacts/screenshots/acquisition bodies are not yet packed as a full content-addressed case archive.
- Secret/session scanning is a defensive pattern check, not a substitute for the repository's pending full current-tree and Git-history secret scans.
- Memory-only privacy mode prevents persistence of new workspace records, but browser/OS memory inspection is outside the application's security boundary.
- IndexedDB/OPFS/service-worker behavior varies by browser and origin; browser acceptance testing remains required.
- Cross-platform root updater scripts exist, but fresh-checkout/repeat acceptance tests on all three supported operating systems remain outstanding.
- The server query layer currently uses bounded `LIKE` search rather than a dedicated full-text index.
- Event first/last-seen and history are implemented, but cross-source entity correlation, graph intelligence, warning lists, workflow automation, and rich case management remain backlog work.
- Final public-release, privacy/proprietary-material, current-tree secret, and Git-history secret reviews remain required before submission readiness can be claimed.
