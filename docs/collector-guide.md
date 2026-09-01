# Public source adapter guide

Use the least-complex lawful acquisition method. Prefer documented public APIs/feeds. Use Solari Browser only when rendering, browser state, screenshots, or browser-native interaction adds real value; use Solari Desktop only for legitimate GUI-only workflows; use Solari Sandbox for untrusted parsing/transformation when isolation adds value.

Every adapter must document provider/canonical URL, acquisition method, authentication requirement, update cadence, geographic/category scope, raw format, normalization mapping, provenance retained, deterministic identity strategy, health-check behavior, rate/terms considerations, known limitations, and last live-test state in `sources.md`.

Collectors must fail visibly, bound timeouts/retries, preserve acquisition metadata, avoid executing source-controlled code on the host, and produce typed normalized records. Add fixture coverage for deterministic parsing before adding live smoke tests. A source being technically reachable is not sufficient justification for collection.
