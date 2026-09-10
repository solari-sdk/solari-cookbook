"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StatusFeed from "./StatusFeed";
import TeardownReport from "./TeardownReport";
import type { AgentEvent, LlmProvider, RunStatus, Teardown } from "@/lib/types";

export interface DemoFixture {
  url: string;
  host: string;
  provider: LlmProvider;
  model: string;
  durationMs: number;
  events: AgentEvent[];
  report: Teardown;
  hasReplay: boolean;
}

/** How long a replayed run takes on screen. */
const REPLAY_MS = 14_000;

/**
 * Replays a captured run entirely in the browser.
 *
 * The live path needs a long-lived server: an in-memory run store, background
 * work that outlives the response, and an open SSE stream. None of that
 * survives on a serverless host, where every request gets its own instance. A
 * demo has no such need — the run already happened — so it is played back from
 * a static JSON file with no server involved at all.
 */
export default function DemoRunView({ fixture }: { fixture: DemoFixture }) {
  const [visible, setVisible] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>("running");
  const [elapsedMs, setElapsedMs] = useState(0);

  // The moment the run was originally captured — real data, so no clock read
  // is needed during render.
  const capturedAt = fixture.events[0]?.ts ?? 0;

  useEffect(() => {
    const origin = fixture.events[0]?.ts ?? 0;
    const last = fixture.events[fixture.events.length - 1]?.ts ?? origin;
    const scale = Math.min(1, REPLAY_MS / Math.max(1, last - origin));

    // Restamp onto a fresh clock so the feed's "+0.0s" column reflects this
    // playback rather than the date the run was captured.
    const begunAt = Date.now();
    const timers = fixture.events.map((event, index) => {
      const delay = Math.round((event.ts - origin) * scale);
      return setTimeout(() => {
        setVisible((shown) => [
          ...shown,
          { ...event, seq: index, ts: begunAt + delay },
        ]);
        if (index === fixture.events.length - 1) setStatus("done");
      }, delay);
    });

    const ticker = setInterval(() => setElapsedMs(Date.now() - begunAt), 100);
    const stop = setTimeout(() => clearInterval(ticker), REPLAY_MS + 400);

    return () => {
      timers.forEach(clearTimeout);
      clearInterval(ticker);
      clearTimeout(stop);
    };
  }, [fixture]);

  const done = status === "done";

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-faint">
            {done ? "Teardown complete" : "Agent running"}
            <span
              className="rounded border border-accent-dim px-1.5 py-0.5 text-[10px] tracking-wide text-accent normal-case"
              title="Replay of a run the agent completed earlier — not a live browse"
            >
              cached run
            </span>
          </p>
          <h1 className="mt-1 truncate font-mono text-sm text-muted">
            {fixture.url}
            <span className="text-faint"> · {fixture.model}</span>
          </h1>
        </div>
        {done && (
          <Link
            href="/"
            className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            ← run another
          </Link>
        )}
      </div>

      <StatusFeed
        events={visible}
        status={status}
        elapsedMs={done ? fixture.durationMs : elapsedMs}
        startedAt={capturedAt}
      />

      {done && (
        <div className="mt-4">
          <TeardownReport
            report={fixture.report}
            url={fixture.url}
            provider={fixture.provider}
            model={fixture.model}
            generatedAt={capturedAt}
            durationMs={fixture.durationMs}
            runId={`demo/${fixture.host}`}
            replay={
              fixture.hasReplay
                ? {
                    sessionId: `demo:${fixture.host}`,
                    url: `/demo/${fixture.host}/replay`,
                    expiresInSeconds: 0,
                    capturedAt,
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
