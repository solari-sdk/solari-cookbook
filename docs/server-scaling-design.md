# Server scaling design

The current FastAPI + SQLite server mode is deliberately small and single-node. This document defines a future scale-out boundary without claiming PostgreSQL, Redis, S3, distributed workers, or distributed scheduling are implemented.

## Current deployment decision

The public showcase currently targets a reproducible single-host server mode plus the independent browser-only static mode. Repository QA includes retained-data coverage at 5,000 normalized events and 300 content-addressed artifacts, and the durable SQLite queue already exposes queue depth, wait/run timing, worker heartbeat/utilization, retry state, and schedule-slot deduplication.

There is currently no repository evidence of a multi-host deployment requirement, sustained SQLite write-lock contention, or a need for cross-host cache/queue coordination. Adding PostgreSQL, Redis, or a second migration stack solely to increase technology count would add operational state without solving a demonstrated problem. Those components are therefore conditional scale-out work, not current implementation blockers.

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

## Explicit reopen triggers

Re-open the PostgreSQL work only when at least one of these becomes true and is evidenced by a deployment/test requirement:
- multiple application/worker hosts need concurrent writes to the same relational state;
- measured SQLite lock/contention or data-volume behavior violates an agreed operational target; or
- shared-team availability/recovery requirements require a separately operated relational service.

Re-open Redis or another distributed queue/cache only when:
- workers/schedulers must coordinate across hosts/process domains that cannot share the current SQLite queue safely;
- a durable visibility/lease model is required beyond the existing single-host queue; or
- measured cache/dispatch behavior demonstrates a bottleneck that the relational queue cannot satisfy.

Re-open a broader database migration framework when:
- more than one database backend must be supported concurrently;
- rolling/zero-downtime deployments require independently orchestrated schema transitions; or
- the existing bootstrap plus explicit versioned migrations can no longer express a safe, testable upgrade path.

Distributed-queue capacity/timing telemetry becomes required when a distributed queue is actually introduced. Provider cost telemetry becomes required only when the provider publishes a documented per-job/source billing or cost interface that can be recorded without estimation or guesswork.

## Migration rule

Do not add distributed infrastructure for the demo by default. Move beyond SQLite/single-host execution only when measured volume/concurrency, collaboration requirements, or deployment topology demonstrate the need. Add migration/load/failure tests before advertising a scaled deployment, and preserve the same provenance, idempotency, retry, evidence, and source-rate-limit semantics across the migration.
