import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  EventLevel,
  LlmProvider,
  RunRecord,
  SessionReplay,
  StatusPayload,
  Teardown,
} from "./types";

type Subscriber = (payload: StatusPayload) => void;

interface Store {
  runs: Map<string, RunRecord>;
  subscribers: Map<string, Set<Subscriber>>;
}

/**
 * Stateless by design: reports live in process memory only, keyed by run id.
 * Hung off `globalThis` so the dev server's module reloads don't orphan an
 * in-flight run's subscribers.
 */
const globalRef = globalThis as typeof globalThis & { __ciaStore?: Store };

const store: Store =
  globalRef.__ciaStore ??
  (globalRef.__ciaStore = { runs: new Map(), subscribers: new Map() });

/** Runs older than this are dropped on the next write. */
const RUN_TTL_MS = 60 * 60 * 1000;

function prune(): void {
  const cutoff = Date.now() - RUN_TTL_MS;
  for (const [id, run] of store.runs) {
    if (run.createdAt < cutoff) {
      store.runs.delete(id);
      store.subscribers.delete(id);
    }
  }
}

export function createRun(
  url: string,
  provider: LlmProvider,
  model: string,
  demo = false,
): RunRecord {
  prune();
  const run: RunRecord = {
    id: randomUUID(),
    url,
    provider,
    model,
    demo,
    status: "queued",
    createdAt: Date.now(),
    events: [],
  };
  store.runs.set(run.id, run);
  return run;
}

export function getRun(id: string): RunRecord | undefined {
  return store.runs.get(id);
}

/** True while any run is still in flight — enforces one-run-at-a-time. */
export function activeRun(): RunRecord | undefined {
  for (const run of store.runs.values()) {
    if (run.status === "queued" || run.status === "running") {
      // A crashed run must not wedge the app forever.
      if (Date.now() - run.createdAt > 2 * 60 * 1000) {
        run.status = "error";
        run.error = "Run abandoned.";
        continue;
      }
      return run;
    }
  }
  return undefined;
}

function publish(id: string, payload: StatusPayload): void {
  const subs = store.subscribers.get(id);
  if (!subs) return;
  for (const send of subs) {
    try {
      send(payload);
    } catch {
      // A dead client must never break the run.
    }
  }
}

export function markRunning(id: string): void {
  const run = store.runs.get(id);
  if (!run) return;
  run.status = "running";
  publish(id, { type: "state", status: run.status, url: run.url });
}

export function appendEvent(
  id: string,
  level: EventLevel,
  phase: string,
  message: string,
): void {
  const run = store.runs.get(id);
  if (!run) return;
  const event: AgentEvent = {
    seq: run.events.length,
    ts: Date.now(),
    level,
    phase,
    message,
  };
  run.events.push(event);
  publish(id, { type: "event", event });
}

/**
 * Attach the session replay. Called as soon as the browser session is released,
 * so it lands whether the run went on to succeed or fail.
 */
export function setReplay(id: string, replay: SessionReplay): void {
  const run = store.runs.get(id);
  if (!run) return;
  run.replay = replay;
  publish(id, { type: "replay", replay });
}

export function completeRun(id: string, report: Teardown): void {
  const run = store.runs.get(id);
  if (!run) return;
  run.status = "done";
  run.report = report;
  run.finishedAt = Date.now();
  run.durationMs = run.finishedAt - run.createdAt;
  publish(id, { type: "done", report, durationMs: run.durationMs });
}

export function failRun(id: string, error: string): void {
  const run = store.runs.get(id);
  if (!run) return;
  run.status = "error";
  run.error = error;
  run.finishedAt = Date.now();
  run.durationMs = run.finishedAt - run.createdAt;
  publish(id, { type: "error", error });
}

/** Returns an unsubscribe function. Callers must always call it on close. */
export function subscribe(id: string, send: Subscriber): () => void {
  let subs = store.subscribers.get(id);
  if (!subs) {
    subs = new Set();
    store.subscribers.set(id, subs);
  }
  subs.add(send);
  return () => {
    subs?.delete(send);
    if (subs && subs.size === 0) store.subscribers.delete(id);
  };
}
