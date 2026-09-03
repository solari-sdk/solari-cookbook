"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startScan } from "@/lib/scan-client";
import type { Finding, ScanEvent, ScanStep, StoredScan } from "@/lib/types";
import { FindingsList } from "./FindingsList";
import { VerdictBadge } from "./VerdictBadge";
import { VerifyDomain } from "./VerifyDomain";

const STEPS: ScanStep[] = ["validate", "passive", "crawl", "collect", "agent", "done"];

const STEP_LABELS: Record<ScanStep, string> = {
  validate: "Validating",
  passive: "Passive scan",
  crawl: "Browser crawl",
  collect: "Collecting",
  agent: "AI review",
  done: "Complete",
};

const STEP_PROGRESS: Record<ScanStep, number> = {
  validate: 8,
  passive: 28,
  crawl: 52,
  collect: 68,
  agent: 88,
  done: 100,
};

export function ScanApp({
  initialUrl = "",
  initialScan,
}: {
  initialUrl?: string;
  initialScan?: StoredScan | null;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<ScanStep | null>(initialScan ? "done" : null);
  const [logs, setLogs] = useState<string[]>([]);
  const [findings, setFindings] = useState<Finding[]>(initialScan?.findings ?? []);
  const [reasoning, setReasoning] = useState(initialScan ? "" : "");
  const [tools, setTools] = useState<{ name: string; detail: string; done: boolean }[]>([]);
  const [result, setResult] = useState<StoredScan | null>(initialScan ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const reasoningRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();

  const progress = step ? STEP_PROGRESS[step] : scanning ? 4 : 0;
  const canScan = !scanning && url.trim().length > 0;

  useEffect(() => {
    reasoningRef.current?.scrollTo(0, reasoningRef.current.scrollHeight);
  }, [reasoning]);

  useEffect(() => () => stopRef.current?.(), []);

  const onEvent = useCallback((event: ScanEvent) => {
    if (event.type === "status") setStep(event.step);
    if (event.type === "log") setLogs((l) => [...l, event.message]);
    if (event.type === "finding") setFindings((f) => [...f, event.finding]);
    if (event.type === "reasoning") setReasoning((r) => r + event.delta);
    if (event.type === "tool") {
      setTools((t) => {
        const idx = t.findIndex((x) => x.name === event.name && !x.done);
        if (idx >= 0 && event.done) {
          const next = [...t];
          next[idx] = event;
          return next;
        }
        return [...t, event];
      });
    }
    if (event.type === "done") {
      setResult(event.payload);
      setFindings(event.payload.findings);
      setStep("done");
      setScanning(false);
      window.history.replaceState(null, "", `/s/${event.scanId}`);
    }
  }, []);

  const handleScan = useCallback(() => {
    if (scanning || !url.trim()) return;
    stopRef.current?.();
    setScanning(true);
    setError(null);
    setStep(null);
    setLogs([]);
    setFindings([]);
    setReasoning("");
    setTools([]);
    setResult(null);
    setShowLogs(false);

    stopRef.current = startScan(url, onEvent, (err) => {
      setError(err.message);
      setScanning(false);
    });
  }, [scanning, url, onEvent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !scanning && url.trim()) {
        e.preventDefault();
        handleScan();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleScan, scanning, url]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">SiteScan</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Pre-production security scan powered by{" "}
          <a
            href="https://docs.getsolari.com/"
            className="transition-opacity hover:opacity-80"
            style={{ color: "var(--accent)" }}
          >
            Solari
          </a>
        </p>
      </header>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="scan-url" className="mac-section-label">
            Target URL
          </label>
          <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            <span className="kbd">⌘</span>+<span className="kbd">L</span> focus ·{" "}
            <span className="kbd">⌘</span>+<span className="kbd">↵</span> scan
          </span>
        </div>
        <div className="search-bar flex gap-2">
          <input
            ref={inputRef}
            id="scan-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://staging.yourapp.com"
            disabled={scanning}
            onKeyDown={(e) => e.key === "Enter" && canScan && handleScan()}
            className="mac-input min-w-0 flex-1 px-4 py-2.5"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={handleScan}
            disabled={!canScan}
            className="mac-btn-primary shrink-0 px-5 py-2.5"
          >
            {scanning ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-white"
                  style={{ animation: "pulse-dot 1s ease infinite" }}
                />
                Scanning
              </span>
            ) : (
              "Scan"
            )}
          </button>
        </div>
      </section>

      {hostname && <VerifyDomain hostname={hostname} />}

      {error && (
        <div className="mac-card px-4 py-3 text-[13px]" style={{ color: "var(--danger)" }} role="alert">
          {error}
        </div>
      )}

      {(scanning || (step && step !== "done")) && (
        <section className="mac-card mac-fade-in space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium">
              {scanning && !step ? "Starting scan…" : step ? STEP_LABELS[step] : "Scanning"}
              {scanning && step !== "done" && (
                <span style={{ color: "var(--text-secondary)" }}> — still working</span>
              )}
            </p>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
              {progress}%
            </span>
          </div>

          <div
            className="relative h-[3px] overflow-hidden rounded-full"
            style={{ background: "color-mix(in srgb, var(--text-tertiary) 20%, transparent)" }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
              style={{ width: `${progress}%`, background: "var(--accent)" }}
            />
            {scanning && step !== "done" && (
              <div className="scan-progress-bar absolute inset-y-0 w-1/4 rounded-full bg-white/40" />
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {STEPS.filter((s) => s !== "done").map((s) => {
              const currentIdx = STEPS.indexOf(step ?? "validate");
              const thisIdx = STEPS.indexOf(s);
              const active = step === s;
              const done = currentIdx > thisIdx;
              return (
                <span
                  key={s}
                  className="scan-step rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                  style={{
                    background: active
                      ? "var(--accent)"
                      : done
                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                        : "color-mix(in srgb, var(--text-tertiary) 12%, transparent)",
                    color: active ? "#fff" : done ? "var(--accent)" : "var(--text-tertiary)",
                  }}
                >
                  {STEP_LABELS[s]}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {result && (
        <section className="mac-card mac-fade-in space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={result.verdict} />
            <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              {result.confidence}% confidence
            </span>
            <span className="text-[13px]" style={{ color: "var(--text-tertiary)" }}>
              · {(result.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {result.summary}
          </p>
          {result.priorityFixes.length > 0 && (
            <ol
              className="list-decimal space-y-1 pl-5 text-[13px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {result.priorityFixes.map((fix, i) => (
                <li key={i}>{fix}</li>
              ))}
            </ol>
          )}
          {result.replayUrl && (
            <a
              href={result.replayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-[13px] transition-opacity hover:opacity-80"
              style={{ color: "var(--accent)" }}
            >
              Watch browser replay →
            </a>
          )}
        </section>
      )}

      {(logs.length > 0 || reasoning || tools.length > 0) && (
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setShowLogs((v) => !v)}
            className="mac-section-label flex items-center gap-1 transition-opacity hover:opacity-70"
          >
            Activity {showLogs ? "▾" : "▸"}
            <span style={{ color: "var(--text-tertiary)", fontWeight: 400 }}>
              ({logs.length + tools.length} events)
            </span>
          </button>

          {showLogs && (
            <div className="mac-card mac-fade-in space-y-3 p-3">
              {logs.length > 0 && (
                <pre
                  className="max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  {logs.join("\n")}
                </pre>
              )}
              {reasoning && (
                <div>
                  <p className="mac-section-label mb-1.5">AI reasoning</p>
                  <pre
                    ref={reasoningRef}
                    className="max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {reasoning}
                  </pre>
                </div>
              )}
              {tools.length > 0 && (
                <ul className="space-y-1 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {tools.map((t, i) => (
                    <li key={`${t.name}-${t.detail}-${i}`}>
                      <span style={{ color: t.done ? "var(--text-secondary)" : "var(--warning)" }}>
                        {t.done ? "✓" : "…"}
                      </span>{" "}
                      <span className="font-medium">{t.name}</span> {t.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="mac-section-label">Findings</h2>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {findings.length}
          </span>
        </div>
        <FindingsList findings={findings} />
      </section>
    </div>
  );
}
