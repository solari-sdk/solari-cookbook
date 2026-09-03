"use client";

import { useState } from "react";
import type { Finding } from "@/lib/types";
import { SeverityBadge } from "./SeverityBadge";

export function FindingsList({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState<string | null>(null);

  if (findings.length === 0) {
    return (
      <div
        className="mac-card flex flex-col items-center justify-center px-6 py-12 text-center"
      >
        <div
          className="mb-3 flex h-10 w-10 items-center justify-center rounded-full text-lg"
          style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
        >
          ✓
        </div>
        <p className="text-[15px] font-semibold tracking-[-0.01em]">No findings yet</p>
        <p className="mt-1 max-w-xs text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Run a scan to see security issues discovered across passive checks, browser crawl, and AI review.
        </p>
      </div>
    );
  }

  const order = ["critical", "high", "medium", "low", "info"] as const;
  const sorted = [...findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );

  return (
    <ul className="mac-card overflow-hidden">
      {sorted.map((f, i) => {
        const expanded = open === f.id;
        return (
          <li
            key={f.id}
            className="mac-list-row border-b last:border-b-0"
            style={{ borderColor: "var(--border-hairline)", animationDelay: `${i * 30}ms` }}
          >
            <button
              type="button"
              className="flex w-full items-start gap-3 px-4 py-3 text-left"
              onClick={() => setOpen(expanded ? null : f.id)}
              aria-expanded={expanded}
            >
              <SeverityBadge severity={f.severity} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium leading-snug">{f.title}</p>
                <p className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {f.url ?? f.category}
                </p>
              </div>
              <span
                className="shrink-0 text-[10px] font-medium uppercase tracking-wide"
                style={{ color: "var(--text-tertiary)" }}
              >
                {f.source}
              </span>
              <span
                className="shrink-0 text-[11px] transition-transform duration-150"
                style={{
                  color: "var(--text-tertiary)",
                  transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                }}
              >
                ›
              </span>
            </button>
            {expanded && (
              <div
                className="mac-fade-in space-y-2 border-t px-4 py-3 pl-[4.5rem] text-[13px]"
                style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
              >
                <p>{f.detail}</p>
                {f.evidence && (
                  <pre
                    className="overflow-x-auto rounded-md p-2.5 font-mono text-[11px] leading-relaxed"
                    style={{ background: "var(--bg-primary)", color: "var(--text-tertiary)" }}
                  >
                    {f.evidence}
                  </pre>
                )}
                <p>
                  <span className="font-medium" style={{ color: "var(--success)" }}>
                    Fix:{" "}
                  </span>
                  {f.remediation}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
