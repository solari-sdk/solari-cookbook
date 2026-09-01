# Raw acquisition retention

Server-mode public-source collections retain the exact response bytes consumed by each registered collector before normalized events are accepted for persistence.

## Runtime boundary

`app.sources.registry` exposes each registered source through `RawCapturingAdapter`. The proxy leaves the source module itself independently unit-testable, but server/worker/CLI callers that use the registry receive the evidence-preserving wrapper.

For each collection the wrapper:

1. serializes same-source collection through a per-adapter lock;
2. temporarily intercepts that module's imported `urllib.request.urlopen` boundary;
3. records only bytes actually consumed through the response object's read interface;
4. restores the original network function even when the collector raises;
5. refuses to accept a successful registered collection if no response bytes were captured;
6. verifies a single captured response against `AcquisitionEnvelope.content_sha256` when the collector supplied that digest; and
7. stores each response as an immutable SHA-256-addressed raw object.

The capture scope is deliberately described as **bytes consumed by the collector**. A bounded collector that intentionally reads only a maximum response size does not imply that the archive contains a byte-for-byte copy of a larger remote representation it refused to ingest.

## Storage

The default archive root is `data/raw-archive/`, which is runtime state excluded by the repository `.gitignore`. Operators may set `SOLARI_RAW_ARCHIVE_DIR` to another local path. No archive path or source body is committed to Git.

Object bytes are stored once by SHA-256 under the existing `RawArchive` content-addressed layout. Per-response metadata uses a capture identifier derived from the parent acquisition ID and response index, so multiple response bodies — including byte-identical responses — can remain independently attributable without duplicating object bytes.

The persisted acquisition metadata contains only safe lookup information:

- raw object SHA-256;
- retained byte size;
- response index;
- HTTP status when available; and
- content type when available.

Raw-capture metadata intentionally does **not** duplicate request URLs, authorization headers, cookies, API keys, or other session material. Credential-bearing source configuration remains environment/user supplied.

## Integrity and failure semantics

For a successful one-response collector, the captured object digest must equal the collector's `content_sha256` when that field is populated. Archive integrity or digest disagreement fails the collection instead of silently persisting normalized observations without defensible raw evidence.

Multiple-response collectors retain each consumed response separately. Because one acquisition-level content digest cannot truthfully describe several independent response bodies, per-object SHA-256 values in `raw_archive_objects` are authoritative for those captures.

The raw archive is immutable: existing object bytes are verified before reuse, and metadata for a given capture/object pair cannot be rewritten with different values.

## Retention and disclosure boundary

Raw source bodies are operational evidence, not source-code assets. They remain local runtime state until an explicit retention/cleanup operation removes them. They must still be treated as untrusted third-party content and must never be rendered as active HTML/script merely because they were retained.

Solari Browser/Sandbox/Desktop evidence continues through the artifact catalog rather than this direct-feed wrapper. Static/no-hosting mode retains its own local acquisition/artifact state in IndexedDB and portable case bundles.
