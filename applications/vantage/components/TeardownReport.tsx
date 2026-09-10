"use client";

import { useMemo, useState } from "react";
import { slugify, teardownToMarkdown } from "@/lib/markdown";
import { getProvider } from "@/lib/providers";
import type { LlmProvider, SessionReplay, Teardown } from "@/lib/types";

const CONFIDENCE_STYLES: Record<Teardown["confidence"], string> = {
  high: "border-ok/40 text-ok",
  medium: "border-warn/40 text-warn",
  low: "border-danger/40 text-danger",
};

const SEVERITY_STYLES = {
  high: "border-danger/40 text-danger",
  medium: "border-warn/40 text-warn",
  low: "border-border-strong text-faint",
} as const;

export default function TeardownReport({
  report,
  url,
  provider,
  model,
  generatedAt,
  durationMs,
  replay,
  runId,
}: {
  report: Teardown;
  url: string;
  runId: string;
  provider: LlmProvider;
  model: string;
  generatedAt: number;
  durationMs?: number;
  replay?: SessionReplay;
}) {
  const providerLabel = getProvider(provider)?.label ?? provider;
  const markdown = useMemo(
    () =>
      teardownToMarkdown(report, {
        url,
        generatedAt,
        durationMs,
        provider: providerLabel,
        model,
      }),
    [report, url, generatedAt, durationMs, providerLabel, model],
  );
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${slugify(report.company)}-teardown.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }

  const signalsByCategory = groupBy(report.techStack.signals, (s) => s.category);

  return (
    <article className="space-y-4">
      {/* Masthead */}
      <header className="glass rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="display text-2xl">
                {report.company}
              </h1>
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${CONFIDENCE_STYLES[report.confidence]}`}
              >
                {report.confidence} confidence
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
              {report.headline}
            </p>
            <p className="mt-3 font-mono text-xs text-faint">
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline decoration-border-strong underline-offset-4 hover:text-muted"
              >
                {hostOf(url)}
              </a>
              {durationMs ? ` · analysed in ${(durationMs / 1000).toFixed(1)}s` : ""}
              {` · ${providerLabel} / ${model}`}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex gap-2">
              <button
                onClick={copy}
                className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
              >
                {copied ? "copied ✓" : "copy md"}
              </button>
              {replay && (
                <a
                  href={
                    runId.startsWith("demo/")
                      ? `/${runId}/replay`
                      : `/replay/${runId}`
                  }
                  target="_blank"
                  rel="noreferrer noopener"
                  title="Replays the recorded browser session"
                  className="glass-soft rounded-lg px-3 py-2 font-mono text-xs text-foreground transition-colors hover:border-accent"
                >
                  ▶ watch agent replay
                </a>
              )}
              <button
                onClick={download}
                className="rounded-lg bg-foreground px-3 py-2 font-mono text-xs text-background transition-opacity hover:opacity-90"
              >
                export .md
              </button>
            </div>
            {replay && (
              <p className="font-mono text-[10px] text-faint">
                Replay available for 24 hours
              </p>
            )}
          </div>
        </div>
      </header>

      {/* Positioning */}
      <Card title="Positioning" index="01">
        <p className="leading-relaxed text-muted">{report.positioning.summary}</p>
        <Field label="Target customer" value={report.positioning.targetCustomer} />
        <div className="grid gap-5 sm:grid-cols-2">
          <BulletList label="Value props" items={report.positioning.valueProps} />
          <BulletList
            label="Claimed differentiators"
            items={report.positioning.differentiators}
          />
        </div>
      </Card>

      {/* Pricing */}
      <Card title="Pricing" index="02">
        <p className="leading-relaxed text-muted">{report.pricing.summary}</p>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Model" value={report.pricing.model} />
          <Field label="Free tier" value={report.pricing.freeTier} />
        </div>
        {report.pricing.tiers.length > 0 && (
          <div className="thin-scroll -mx-1 overflow-x-auto">
            <table className="w-full min-w-[30rem] border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left font-mono text-[11px] uppercase tracking-wide text-faint">
                  <th className="border-b border-border px-3 py-2 font-normal">Tier</th>
                  <th className="border-b border-border px-3 py-2 font-normal">Price</th>
                  <th className="border-b border-border px-3 py-2 font-normal">Notes</th>
                </tr>
              </thead>
              <tbody>
                {report.pricing.tiers.map((tier) => (
                  <tr key={tier.name} className="align-top">
                    <td className="border-b border-border px-3 py-2.5 font-medium">
                      {tier.name}
                    </td>
                    <td className="border-b border-border px-3 py-2.5 font-mono text-accent">
                      {tier.price}
                    </td>
                    <td className="border-b border-border px-3 py-2.5 text-muted">
                      {tier.notes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Tech stack */}
      <Card title="Tech stack signals" index="03">
        <p className="leading-relaxed text-muted">{report.techStack.summary}</p>
        {report.techStack.signals.length === 0 ? (
          <Empty>Nothing identifiable in the page assets.</Empty>
        ) : (
          <div className="space-y-3">
            {Object.entries(signalsByCategory).map(([category, signals]) => (
              <div key={category} className="flex flex-wrap items-baseline gap-2">
                <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-wide text-faint">
                  {category}
                </span>
                {signals.map((signal) => (
                  <span
                    key={signal.name}
                    title={signal.evidence}
                    className="glass-soft rounded-md px-2 py-1 font-mono text-xs text-foreground"
                  >
                    {signal.name}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Complaints */}
      <Card title="What users complain about" index="04">
        <p className="leading-relaxed text-muted">{report.complaints.summary}</p>
        {report.complaints.items.length === 0 ? (
          <Empty>No complaints surfaced in public sources during this run.</Empty>
        ) : (
          <ul className="space-y-2.5">
            {report.complaints.items.map((item, i) => (
              <li
                key={i}
                className="glass-soft flex items-start gap-3 rounded-lg p-3"
              >
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${SEVERITY_STYLES[item.severity]}`}
                >
                  {item.severity}
                </span>
                <div className="min-w-0">
                  <p className="text-sm leading-relaxed">{item.complaint}</p>
                  <p className="mt-1 font-mono text-[11px] text-faint">{item.source}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Recent moves */}
      <Card title="Recent moves" index="05">
        <p className="leading-relaxed text-muted">{report.recentMoves.summary}</p>
        {report.recentMoves.items.length === 0 ? (
          <Empty>No dated activity found.</Empty>
        ) : (
          <ol className="relative space-y-4 border-l border-border pl-5">
            {report.recentMoves.items.map((item, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[1.4rem] top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
                <p className="font-mono text-[11px] uppercase tracking-wide text-faint">
                  {item.when}
                </p>
                <p className="mt-1 text-sm leading-relaxed">{item.move}</p>
                <p className="mt-1 font-mono text-[11px] text-faint">{item.source}</p>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* Opportunities */}
      <Card title="Opportunities" index="06" accent>
        <p className="leading-relaxed text-muted">{report.opportunities.summary}</p>
        <div className="space-y-3">
          {report.opportunities.items.map((item, i) => (
            <div
              key={i}
              className="glass-soft rounded-lg p-4"
            >
              <h4 className="text-sm font-medium text-foreground">
                <span className="mr-2 font-mono text-accent">{i + 1}.</span>
                {item.gap}
              </h4>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex gap-3">
                  <dt className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-wide text-faint">
                    why
                  </dt>
                  <dd className="text-muted">{item.why}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-20 shrink-0 font-mono text-[11px] uppercase tracking-wide text-faint">
                    wedge
                  </dt>
                  <dd className="text-foreground">{item.howToExploit}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </Card>

      {report.gaps.length > 0 && (
        <section className="rounded-xl border border-dashed border-border p-5">
          <h3 className="font-mono text-[11px] uppercase tracking-wide text-faint">
            Not established by this run
          </h3>
          <ul className="mt-2 space-y-1">
            {report.gaps.map((gap, i) => (
              <li key={i} className="text-sm text-faint">
                — {gap}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- */

function Card({
  title,
  index,
  accent,
  children,
}: {
  title: string;
  index: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`glass rounded-xl p-6 ${
        accent ? "!border-accent-dim" : ""
      }`}
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="font-mono text-[11px] text-faint">{index}</span>
        <h3 className="text-sm font-medium tracking-tight">{title}</h3>
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="space-y-5 text-sm">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-faint">
        {label}
      </p>
      <p className="mt-1 leading-relaxed">{value}</p>
    </div>
  );
}

function BulletList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-faint">
        {label}
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 leading-relaxed text-muted">
            <span className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-border-strong" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs text-faint">{children}</p>;
}

function groupBy<T, K extends string>(
  items: T[],
  key: (item: T) => K,
): Record<K, T[]> {
  return items.reduce(
    (acc, item) => {
      const k = key(item);
      (acc[k] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
