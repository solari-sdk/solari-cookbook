# Retention and cleanup policy

This policy defines the development/demo defaults. A future deployed organization may choose different durations, but those values must be explicit rather than silently inferred from these examples.

## Remote Solari resources

- Browser, Sandbox, and Desktop sessions are ephemeral execution resources, not durable evidence stores.
- Code must explicitly close/kill remote resources on success and failure according to the relevant SDK lifecycle.
- A remote recording or screenshot needed as evidence must be copied into the project's artifact/evidence layer before the remote session is destroyed.
- Idle provider timeouts are a safety net, not the primary cleanup mechanism.

## Server-mode local data

- Normalized events, event-history snapshots, cases, entities, and relationships remain until an explicit cleanup/retention operation removes them; no hidden age-based deletion is currently performed.
- Registered direct API/feed collectors retain the exact response bytes consumed by the collector in the immutable SHA-256 raw archive before a successful collection is accepted. Acquisition metadata carries safe digest/size/status/content-type references; request URLs, authorization headers, cookies, and credentials are not duplicated into raw-archive metadata.
- The default raw archive is `data/raw-archive/`; `SOLARI_RAW_ARCHIVE_DIR` may point it at another operator-controlled local path. No automatic age-based raw-object deletion is currently performed.
- Content-addressed evidence artifacts remain until an explicit artifact cleanup policy removes them. Identical bytes share one stored object by SHA-256.
- Runtime SQLite databases, raw archives, artifact directories, exports, logs, and generated files are local/runtime state and are excluded from source control.
- Direct-feed raw retention is documented in `docs/raw-acquisition-retention.md`. Browser/Sandbox/Desktop artifacts continue through the evidence artifact catalog because their lifecycle and media semantics differ from direct HTTP feed capture.

## Static/no-hosting mode

- Persistent analyst state remains in IndexedDB/Cache Storage until the user clears browser site data or uses the explicit purge action.
- Memory-only privacy mode intentionally retains investigation state only for the active page/session lifecycle.
- The service-worker cache contains application-shell assets, not provider credentials.
- The purge action removes the application IndexedDB database and Cache Storage entries and clears the in-memory provider-key field in the active UI flow.

## Portable cases

- Exported portable cases are user-controlled files outside application retention once downloaded.
- Secret/session scanning occurs before export; provider/API credentials and authenticated session material must not be intentionally placed in a bundle.
- Encrypted `.solari-case` files do not contain the passphrase/key used to encrypt them.

## Cleanup implementation requirements

Future automated retention jobs must be dry-run/reportable before deletion, operate on explicit object classes, preserve case/evidence holds if those are introduced, record counts and failure state, and have tests proving that unrelated evidence is not removed. Remote-resource cleanup remains immediate and unconditional rather than age-based.
