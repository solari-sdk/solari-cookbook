import type { Severity } from "@/lib/types";

const CONFIG: Record<Severity, { bg: string; text: string }> = {
  critical: { bg: "color-mix(in srgb, var(--danger) 18%, transparent)", text: "var(--danger)" },
  high: { bg: "color-mix(in srgb, #ff9500 18%, transparent)", text: "#ff9500" },
  medium: { bg: "color-mix(in srgb, var(--warning) 18%, transparent)", text: "var(--warning)" },
  low: { bg: "color-mix(in srgb, var(--accent) 15%, transparent)", text: "var(--accent)" },
  info: { bg: "color-mix(in srgb, var(--text-secondary) 15%, transparent)", text: "var(--text-secondary)" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const c = CONFIG[severity];
  return (
    <span
      className="inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ background: c.bg, color: c.text }}
    >
      {severity}
    </span>
  );
}
