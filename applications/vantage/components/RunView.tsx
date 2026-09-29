"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import StatusFeed from "./StatusFeed";
import TeardownReport from "./TeardownReport";
import { ACTIVE_RUN_KEY } from "@/lib/storage-keys";
import type {
  AgentEvent,
  LlmProvider,
  RunStatus,
  SessionReplay,
  StatusPayload,
  Teardown,
} from "@/lib/types";

export interface RunSnapshot {
  id: string;
  url: string;
  provider: LlmProvider;
  model: string;
  status: RunStatus;
  createdAt: number;
  events: AgentEvent[];
  report?: Teardown;
  error?: string;
  durationMs?: number;
  replay?: SessionReplay;
  demo?: boolean;
}

export default function RunView({ initial }: { initial: RunSnapshot }) {
  const [status, setStatus] = useState<RunStatus>(initial.status);
  const [events, setEvents] = useState<AgentEvent[]>(initial.events);
  const [report, setReport] = useState<Teardown | undefined>(initial.report);
  const [error, setError] = useState<string | undefined>(initial.error);
  const [durationMs, setDurationMs] = useState<number | undefined>(initial.durationMs);
  const [replay, setReplay] = useState<SessionReplay | undefined>(initial.replay);
  // Seeded from the server's own measurement; the ticker below takes over
  // while the run is live.
  const [elapsedMs, setElapsedMs] = useState(initial.durationMs ?? 0);
  const [streamLost, setStreamLost] = useState(false);

  const live = status === "queued" || status === "running";
  const finishedRef = useRef(false);

  // Elapsed clock, only while the run is actually moving.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - initial.createdAt), 100);
    return () => clearInterval(timer);
  }, [live, initial.createdAt]);

  // Release the client-side single-flight lock once the run settles.
  useEffect(() => {
    if (live) return;
    try {
      if (sessionStorage.getItem(ACTIVE_RUN_KEY) === initial.id) {
        sessionStorage.removeItem(ACTIVE_RUN_KEY);
      }
    } catch {}
  }, [live, initial.id]);

  useEffect(() => {
    if (!live || finishedRef.current) return;

    const source = new EventSource(`/api/status/${initial.id}`);

    source.onmessage = (message) => {
      let payload: StatusPayload;
      try {
        payload = JSON.parse(message.data) as StatusPayload;
      } catch {
        return;
      }

      switch (payload.type) {
        case "state":
          setStatus(payload.status);
          break;
        case "replay":
          setReplay(payload.replay);
          break;
        case "event":
          setEvents((prev) =>
            prev.some((e) => e.seq === payload.event.seq)
              ? prev
              : [...prev, payload.event],
          );
          break;
        case "done":
          finishedRef.current = true;
          setReport(payload.report);
          setDurationMs(payload.durationMs);
          setElapsedMs(payload.durationMs);
          setStatus("done");
          source.close();
          break;
        case "error":
          finishedRef.current = true;
          setError(payload.error);
          setStatus("error");
          source.close();
          break;
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects; only surface it if the run never settles.
      if (!finishedRef.current) setStreamLost(true);
    };

    return () => source.close();
    // Only ever open one stream per run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-faint">
            {live ? "Agent running" : status === "done" ? "Teardown complete" : "Run failed"}
            {initial.demo && (
              <span
                className="rounded border border-accent-dim px-1.5 py-0.5 text-[10px] tracking-wide text-accent normal-case"
                title="Replay of a run the agent completed earlier — not a live browse"
              >
                cached run
              </span>
            )}
          </p>
          <h1 className="mt-1 truncate font-mono text-sm text-muted">
            {initial.url}
            <span className="text-faint"> · {initial.model}</span>
          </h1>
        </div>
        {!live && (
          <Link
            href="/"
            className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            ← run another
          </Link>
        )}
      </div>

      <StatusFeed
        events={events}
        status={status}
        elapsedMs={elapsedMs}
        startedAt={initial.createdAt}
      />

      {streamLost && live && (
        <p className="mt-3 font-mono text-xs text-warn">
          Live connection dropped — reconnecting. Reload if the feed stays frozen.
        </p>
      )}

      {status === "error" && (
        <section className="glass mt-4 rounded-xl !border-danger/40 p-6">
          <h2 className="font-mono text-xs uppercase tracking-wide text-danger">
            Run failed
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {error ?? "The agent stopped without producing a report."}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link
              href="/"
              className="rounded-lg bg-foreground px-3 py-2 font-mono text-xs text-background transition-opacity hover:opacity-90"
            >
              try another URL
            </Link>
            {replay && (
              <a
                href={`/replay/${initial.id}`}
                target="_blank"
                rel="noreferrer noopener"
                title="Replays the recorded browser session"
                className="glass-soft rounded-lg px-3 py-2 font-mono text-xs text-foreground transition-colors hover:border-accent"
              >
                ▶ watch agent replay
              </a>
            )}
          </div>
          {replay && (
            <p className="mt-2 font-mono text-[10px] text-faint">
              Replay available for 24 hours
            </p>
          )}
        </section>
      )}

      {report && (
        <div className="mt-4">
          <TeardownReport
            report={report}
            url={initial.url}
            provider={initial.provider}
            model={initial.model}
            generatedAt={initial.createdAt}
            durationMs={durationMs}
            replay={replay}
            runId={initial.id}
          />
        </div>
      )}
    </div>
  );
}
