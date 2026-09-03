"use client";

import type { Verdict } from "@/lib/types";

const CONFIG: Record<Verdict, { bg: string; text: string; label: string }> = {
  pass: { bg: "color-mix(in srgb, var(--success) 15%, transparent)", text: "var(--success)", label: "Pass" },
  warn: { bg: "color-mix(in srgb, var(--warning) 15%, transparent)", text: "var(--warning)", label: "Warn" },
  fail: { bg: "color-mix(in srgb, var(--danger) 15%, transparent)", text: "var(--danger)", label: "Fail" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const c = CONFIG[verdict];
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: c.bg, color: c.text }}
    >
      {c.label}
    </span>
  );
}
