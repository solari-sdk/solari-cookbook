# Data and evidence model

The operations center separates acquisition, normalization, evidence, and inference.

An acquisition records where and how content was obtained, request/final URLs, start/completion time, status, HTTP/content metadata where applicable, content hash, and safe failure metadata. A normalized event uses a deterministic ID, source/source-record identity, category, title/summary, observation/update times, optional geospatial point, severity, quality score, source-specific properties, and evidence references.

Evidence references identify the acquisition or source location that supports a field or observation and classify the relationship as observed, transformed, or inferred. Observed source facts must not be silently promoted from inferred values. Transformations should retain enough provenance to reproduce or explain the result.

Portable cases extend the same domain with entities, typed relationships, case metadata, provenance steps, and saved views. Static mode stores these object families in separate IndexedDB stores; server mode persists normalized acquisitions/events in SQLite today and can evolve without changing the portable case semantics.

Coordinates are WGS84 latitude/longitude degrees. Latitude is bounded to -90..90 and longitude to -180..180. Precision/uncertainty should be retained rather than implying false exactness.
