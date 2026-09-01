# Durable local background jobs

The operations center includes an optional durable **single-host** background job path backed by the same local SQLite database used by the demo. It is intentionally not described as a distributed queue: Redis/PostgreSQL or another multi-host coordination layer should only be introduced if deployment requirements justify it.

## Components

- `app.task_queue` owns durable queued tasks, worker heartbeats, interval schedules, bounded payload/result storage, retry state, claim timestamps, completion timestamps, and queue metrics.
- `python -m app.worker` is the long-running worker process. It atomically claims one task at a time and currently supports registered public-source collection and the existing bounded declarative workflow engine.
- `python -m app.scheduler` is the long-running interval scheduler. It turns due schedule slots into durable queue entries using a unique schedule-slot deduplication key.
- `/api/v1/queue/tasks`, `/api/v1/queue/metrics`, and `/api/v1/schedules` expose read-only operations telemetry. `/api/v1/jobs/metrics` and its SSE stream include queue metrics alongside completed synchronous job-execution metrics.

## Safety and bounds

Task and schedule payloads are JSON objects capped at 64 KiB. Result summaries are capped at 64 KiB. Task priorities are bounded, attempts are capped at ten, retry delays are capped at one hour, scheduler intervals are limited to 60 seconds through 31 days, and read APIs cap result counts.

The workflow task kind does not accept arbitrary code or expressions. It reuses the same allowlisted actions and step-count/input-count limits as the interactive workflow API. Collection tasks accept only source IDs already present in the public source registry.

SQLite task claiming uses `BEGIN IMMEDIATE` to serialize the short claim transaction. This makes the local worker durable across process restarts without implying multi-host/distributed guarantees.

## Run a worker

```bash
python -m app.worker
```

For a single claim attempt, useful for supervised environments and tests:

```bash
python -m app.worker --once
```

The worker publishes an `idle`, `running`, or `stopping` heartbeat. A worker is considered active for queue-utilization telemetry when its heartbeat is no more than 30 seconds old.

## Add and run a public-source schedule

For example, schedule the registered USGS earthquake collector every hour:

```bash
python -m app.scheduler --add-collection usgs-earthquakes --interval-seconds 3600
python -m app.scheduler
```

The scheduler advances overdue schedules to their next future slot instead of replaying every missed interval. Every scheduled slot has a durable deduplication key, so re-evaluating the same slot cannot enqueue a duplicate task.

## Schedule a bounded workflow

Create a small JSON file containing the same `playbook`, `inputs`, and optional `approvals` fields accepted by the workflow API, then run:

```bash
python -m app.scheduler --add-workflow ./workflow.json --interval-seconds 3600
```

The scheduler validates the playbook before storing it. The worker validates it again before execution.

## Telemetry semantics

`/api/v1/queue/metrics` reports:

- pending queue depth and running/succeeded/failed task counts;
- active and busy worker counts plus current utilization ratio;
- age of the oldest pending task;
- average queue wait time from task creation to first claim;
- average end-to-end task runtime from first start to terminal completion;
- timing sample counts and the active-worker heartbeat window.

These metrics apply to the local durable queue. They do **not** claim distributed-queue latency, remote worker capacity, or provider-side Solari resource utilization.

## Process supervision

For production-like local/server deployments, run the API, worker, and scheduler as separate supervised processes. A system service, container supervisor, or equivalent should restart worker/scheduler processes after failure. Do not put secrets into task payloads or schedule definitions; provider credentials remain in the established environment/secret boundary.
