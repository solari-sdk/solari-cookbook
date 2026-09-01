# Server scaling design

The current FastAPI + SQLite server mode is deliberately small and single-node. This document defines a future scale-out boundary without claiming PostgreSQL, Redis, S3, workers, or scheduling are implemented.

## Separation of concerns

A larger deployment should separate:

1. **API/web process** — validation, read queries, case/review commands, job submission, health/readiness.
2. **Collector workers** — network acquisition and deterministic normalization.
3. **Sandbox/enrichment workers** — bounded transformations and analyzers, especially remote Solari Sandbox jobs.
4. **Scheduler** — creates due collection jobs from source cadence; does not perform collection itself.
5. **Relational store** — normalized events/entities/cases/jobs and durable audit state.
6. **Artifact store** — content-addressed evidence bytes and checksums.
7. **Queue/cache** — durable work dispatch, lease/visibility timeout, retry state, and bounded transient cache where needed.

## Horizontal worker rules

- Jobs have deterministic IDs/idempotency keys so retrying or processing a duplicate message cannot silently create duplicate observations.
- A worker leases one job at a time from the queue and records start/finish/error/attempt state durably.
- Concurrency is bounded per source and globally; source quotas/rate limits win over available worker count.
- Scale-out changes worker count, not source cadence or evidence semantics.
- A dead worker's lease expires so another worker can retry under the same job ID and attempt policy.
- Circuit breakers and cooldowns are source-scoped/shared through durable state rather than process-local memory in a multi-worker deployment.
- Artifact writes are content-addressed and safe under concurrent duplicate uploads.

## Technology candidates

PostgreSQL is the preferred relational candidate if SQLite becomes a concurrency/volume constraint. Redis is a possible queue/cache candidate but is not required if a durable database-backed queue is sufficient. S3-compatible object storage is a possible artifact backend. These are architectural candidates, not current dependencies.

## Migration trigger

Do not add distributed infrastructure for the demo by default. Move beyond SQLite/in-process collection only when measured volume/concurrency, collaboration requirements, or deployment topology demonstrate the need. Add migration/load/failure tests before advertising a scaled deployment.
