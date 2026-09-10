"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent, EventLevel, RunStatus } from "@/lib/types";

/** Gap between revealed lines, so the log reads as a terminal rather than a dump. */
const LINE_INTERVAL_MS = 600;

/**
 * Dot colour per level. Completed steps are a static green; a warning or a
 * failure keeps its own colour, because losing that signal to a uniform palette
 * would hide the one line you actually need to read.
 */
const LEVEL_STYLES: Record<EventLevel, { dot: string; text: string }> = {
  info: { dot: "bg-ok/70", text: "text-muted" },
  ok: { dot: "bg-ok", text: "text-foreground" },
  warn: { dot: "bg-warn", text: "text-warn" },
  error: { dot: "bg-danger", text: "text-danger" },
};

function clock(ts: number, origin: number): string {
  const s = Math.max(0, (ts - origin) / 1000);
  return `+${s.toFixed(1)}s`.padStart(7, " ");
}

export default function StatusFeed({
  events,
  status,
  elapsedMs,
  startedAt,
}: {
  events: AgentEvent[];
  status: RunStatus;
  elapsedMs: number;
  startedAt: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const origin = events[0]?.ts ?? startedAt;
  const live = status === "queued" || status === "running";

  // Anything already present at mount is backlog — a reload of a finished run
  // should not re-type 22 lines at you. Only new arrivals are paced.
  const [visible, setVisible] = useState(() => events.length);

  useEffect(() => {
    if (visible >= events.length) return;

    // A settled run has nothing left to pace; show the rest at once.
    const delay = live ? LINE_INTERVAL_MS : 0;
    const timer = setTimeout(() => {
      setVisible((count) => Math.min(count + 1, events.length));
    }, delay);
    return () => clearTimeout(timer);
  }, [visible, events.length, live]);

  const shown = events.slice(0, visible);
  const draining = visible < events.length;
  // The most recent revealed line is the step in flight.
  const currentSeq = live || draining ? shown[shown.length - 1]?.seq : undefined;

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible, status]);

  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-[#07090b]">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              live || draining
                ? "bg-ok pulse-dot"
                : status === "done"
                  ? "bg-ok"
                  : "bg-danger"
            }`}
          />
          <h2 className="font-mono text-xs tracking-wide text-muted uppercase">
            Agent activity
          </h2>
        </div>
        <span className="font-mono text-xs tabular-nums text-faint">
          {(elapsedMs / 1000).toFixed(1)}s · {events.length} events
        </span>
      </header>

      <div
        ref={scrollRef}
        className="thin-scroll max-h-[26rem] min-h-[11rem] overflow-y-auto px-4 py-3"
        role="log"
        aria-live="polite"
      >
        {shown.length === 0 ? (
          <p className="flex items-center gap-2.5 font-mono text-xs text-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-ok pulse-dot" />
            Waiting for the agent to boot…
          </p>
        ) : (
          <ol className="space-y-1.5">
            {shown.map((event) => {
              const style = LEVEL_STYLES[event.level];
              const isCurrent = event.seq === currentSeq;
              return (
                <li
                  key={event.seq}
                  className="rise flex items-start gap-3 font-mono text-xs leading-relaxed"
                >
                  <span className="shrink-0 tabular-nums text-faint">
                    {clock(event.ts, origin)}
                  </span>
                  <span
                    className={`mt-[0.35rem] h-1.5 w-1.5 shrink-0 rounded-full ${style.dot} ${
                      isCurrent ? "pulse-dot" : ""
                    }`}
                  />
                  <span className="w-[7.25rem] shrink-0">
                    <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] tracking-wide text-faint uppercase">
                      {event.phase}
                    </span>
                  </span>
                  <span className={`min-w-0 flex-1 ${style.text}`}>
                    {event.message}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {(live || draining) && shown.length > 0 && (
          <p className="mt-2 flex items-center gap-3 font-mono text-xs text-faint">
            <span className="w-[3.4rem] shrink-0" />
            <span className="caret">▍</span>
          </p>
        )}
      </div>
    </section>
  );
}
