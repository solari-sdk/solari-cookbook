"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { eventWithTime } from "@rrweb/types";
import "rrweb-player/dist/style.css";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; events: number; durationMs: number }
  | { phase: "error"; message: string };

/**
 * Plays a recorded Solari session.
 *
 * The recording is an rrweb event log — a stream of DOM snapshots and
 * mutations, not a video — so it is replayed by rebuilding the pages in an
 * iframe rather than decoded by the browser's media pipeline.
 */
export default function ReplayPlayer({
  runId,
  targetUrl,
  eventsUrl,
  backHref,
}: {
  runId: string;
  targetUrl: string;
  /** Overrides the API route — demos read a static file, with no server state. */
  eventsUrl?: string;
  backHref?: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Typed loosely: rrweb-player is a Svelte component with no React types.
    let player: { $destroy?: () => void } | null = null;

    async function boot() {
      const mount = mountRef.current;
      if (!mount) return;

      try {
        const source = eventsUrl ?? `/api/replay/${runId}/events`;
        const response = await fetch(source, {
          cache: eventsUrl ? "force-cache" : "no-store",
        });
        // The API wraps events in an object; a static file is the bare array.
        const payload = (await response.json()) as
          | eventWithTime[]
          | { events?: eventWithTime[]; error?: string };
        const data = Array.isArray(payload) ? { events: payload } : payload;

        if (!response.ok || !data.events) {
          if (!cancelled) {
            setState({
              phase: "error",
              message: data.error ?? "Could not load the recording.",
            });
          }
          return;
        }
        if (cancelled) return;

        const events = data.events;
        if (events.length < 2) {
          setState({
            phase: "error",
            message: "The recording is too short to replay.",
          });
          return;
        }

        // Client-only: the player touches `document` at construction time.
        const { default: RrwebPlayer } = await import("rrweb-player");
        if (cancelled) return;

        mount.innerHTML = "";
        const width = mount.clientWidth || 960;

        player = new RrwebPlayer({
          target: mount,
          props: {
            events,
            width,
            height: Math.round((width * 720) / 1280),
            autoPlay: false,
            showController: true,
            // The agent opens several pages back to back, so there are long
            // gaps with no DOM activity between them.
            skipInactive: true,
          },
        }) as unknown as { $destroy?: () => void };

        setState({
          phase: "ready",
          events: events.length,
          durationMs:
            events[events.length - 1].timestamp - events[0].timestamp,
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            message:
              err instanceof Error ? err.message : "Could not start the player.",
          });
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
      try {
        player?.$destroy?.();
      } catch {
        // Player already torn down.
      }
    };
  }, [runId, eventsUrl]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            Session replay
          </p>
          <h1 className="display mt-2 truncate text-2xl">{targetUrl}</h1>
          {state.phase === "ready" && (
            <p className="mt-2 font-mono text-[11px] text-faint">
              {state.events} events · {(state.durationMs / 1000).toFixed(1)}s of
              browsing
            </p>
          )}
        </div>
        <Link
          href={backHref ?? `/report/${runId}`}
          className="glass-soft rounded-lg px-3 py-2 font-mono text-xs text-foreground transition-colors hover:border-accent"
        >
          ← back to report
        </Link>
      </div>

      <div className="glass overflow-hidden rounded-xl p-3">
        {state.phase === "loading" && (
          <p className="flex items-center gap-2 px-2 py-16 font-mono text-xs text-faint">
            <span className="h-1 w-1 rounded-full bg-accent pulse-dot" />
            Rebuilding the session…
          </p>
        )}
        {state.phase === "error" && (
          <div className="px-2 py-14">
            <p className="font-mono text-xs text-danger">{state.message}</p>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">
              Recordings are kept by Solari for a limited window, and the run
              itself only lives in this server&rsquo;s memory for an hour.
            </p>
          </div>
        )}
        <div ref={mountRef} className="replay-mount" />
      </div>

      <p className="mt-4 font-mono text-[11px] leading-relaxed text-faint">
        This is a DOM recording, not a video: the pages are rebuilt from
        snapshots and mutations, so text stays selectable and the timeline is
        scrubbable. Inactive gaps between pages are skipped automatically.
      </p>
    </div>
  );
}
