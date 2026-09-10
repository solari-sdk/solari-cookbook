import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentEvent, LlmProvider, Teardown } from "./types";

/**
 * Demo mode: replay a previously captured real run.
 *
 * These are **not** hand-written reports. A fixture is only ever created by
 * `captureFixture`, which is called when a genuine run completes successfully,
 * so a demo replays output the agent actually produced — same events, same
 * timings, same teardown. That keeps a recorded walkthrough honest: it is a
 * cached run, not a mock-up.
 *
 * A host with no fixture yet simply falls through to a live run.
 */

const FIXTURE_DIR = join(process.cwd(), "demo-fixtures");

/** Hosts offered as one-click examples on the landing page. */
export const DEMO_HOSTS = [
  "vercel.com",
  "cal.com",
  "posthog.com",
  "supabase.com",
] as const;

export interface DemoFixture {
  url: string;
  host: string;
  provider: LlmProvider;
  model: string;
  /** Wall-clock duration of the original run. */
  durationMs: number;
  /** The original event log, timestamps included. */
  events: AgentEvent[];
  report: Teardown;
  capturedAt: number;
}

/**
 * Download the recording behind a presigned URL and store it locally.
 * Never throws — a missing recording only costs the demo its replay button.
 */
export async function captureRecording(host: string, url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    // The object is gzipped at rest; `fetch` only decompresses when the gzip
    // is a transfer encoding, so sniff the magic bytes.
    const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const text = (isGzip ? gunzipSync(buffer) : buffer).toString("utf8");
    if (!text.trim()) return false;
    writeRecording(host, text);
    return true;
  } catch {
    return false;
  }
}

export function normaliseHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.replace(/^www\./, "").toLowerCase();
  }
}

function fixturePath(host: string): string {
  // Hosts come from parsed URLs, but keep the filename defensive anyway.
  return join(FIXTURE_DIR, `${host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

/**
 * The rrweb recording that goes with a fixture, stored gzipped next to it.
 *
 * Solari's own copy is behind a presigned URL that expires in 900 seconds and
 * is retained only for a day, so a demo cannot depend on it. Capturing the
 * NDJSON locally makes the replay permanent and offline.
 */
function recordingPath(host: string): string {
  return join(FIXTURE_DIR, `${host.replace(/[^a-z0-9.-]/gi, "_")}.replay.ndjson.gz`);
}

export function hasRecording(host: string): boolean {
  return existsSync(recordingPath(host));
}

export function writeRecording(host: string, ndjson: string): void {
  try {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(recordingPath(host), gzipSync(Buffer.from(ndjson, "utf8")));
  } catch {
    // A read-only deploy just means no stored recording.
  }
}

/** Parsed rrweb events, or `null` when nothing is stored for this host. */
export function readRecording(host: string): unknown[] | null {
  try {
    const text = gunzipSync(readFileSync(recordingPath(host))).toString("utf8");
    const events: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Tolerate a truncated trailing line.
      }
    }
    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}

export function readFixture(host: string): DemoFixture | null {
  try {
    return JSON.parse(readFileSync(fixturePath(host), "utf8")) as DemoFixture;
  } catch {
    return null;
  }
}

export function listFixtures(): string[] {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Persist a completed run so it can be replayed later. Called on success only,
 * and only for the demo hosts — every other run stays ephemeral.
 */
export function captureFixture(fixture: DemoFixture): void {
  if (!DEMO_HOSTS.includes(fixture.host as (typeof DEMO_HOSTS)[number])) return;
  try {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(fixturePath(fixture.host), JSON.stringify(fixture, null, 2));
  } catch {
    // A read-only deploy just means no new fixtures; never break the run.
  }
}

/**
 * Re-time the captured events onto a fresh clock.
 *
 * The original gaps are preserved so the feed paces like the real thing, but
 * the whole thing is compressed to `targetMs` — a 50-second run is accurate
 * and unwatchable in a screen recording.
 */
export function scheduleReplay(
  events: AgentEvent[],
  targetMs: number,
): Array<{ event: AgentEvent; delayMs: number }> {
  if (events.length === 0) return [];

  const origin = events[0].ts;
  const span = Math.max(1, events[events.length - 1].ts - origin);
  const scale = Math.min(1, targetMs / span);
  const now = Date.now();

  return events.map((event, index) => {
    const delayMs = Math.round((event.ts - origin) * scale);
    return {
      // Restamp so the feed's "+0.0s" column reflects the replay, not the
      // original run's date.
      event: { ...event, seq: index, ts: now + delayMs },
      delayMs,
    };
  });
}
