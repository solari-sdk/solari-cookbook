import { NextResponse } from "next/server";
import { RUN_TIMEOUT_MS, normalizeUrl, runTeardown } from "@/lib/agent";
import { getProvider, isLlmProvider } from "@/lib/providers";
import {
  DEMO_HOSTS,
  captureFixture,
  captureRecording,
  hasRecording,
  normaliseHost,
  readFixture,
  scheduleReplay,
} from "@/lib/demo";
import { getSolari } from "@/lib/solari";
import {
  activeRun,
  appendEvent,
  completeRun,
  createRun,
  failRun,
  getRun,
  markRunning,
  setReplay,
} from "@/lib/store";
import type { LlmCredentials } from "@/lib/types";

// Solari drives a real Chromium over the wire — Node runtime only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RunRequest {
  url?: unknown;
  provider?: unknown;
  apiKey?: unknown;
  model?: unknown;
  /** Replay a captured run instead of browsing live. Needs no API key. */
  demo?: unknown;
}

/** How long a replayed run takes on screen. */
const DEMO_REPLAY_MS = 14_000;

export async function POST(request: Request) {
  let payload: RunRequest;
  try {
    payload = (await request.json()) as RunRequest;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof payload.url !== "string") {
    return NextResponse.json({ error: "Missing 'url'." }, { status: 400 });
  }

  let target: URL;
  try {
    target = normalizeUrl(payload.url);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid URL." },
      { status: 400 },
    );
  }

  // A demo replays a run the agent genuinely completed earlier, so it needs
  // no provider credentials. Falls through to a live run if nothing is cached.
  if (payload.demo === true) {
    const host = normaliseHost(target.toString());
    const fixture = readFixture(host);

    // No saved run for this host: fall through to a live one rather than
    // surfacing an internal cache miss. The live run captures the fixture, so
    // the next click replays instantly.
    if (!fixture && !isLlmProvider(payload.provider)) {
      return NextResponse.json(
        { error: "No model key set yet — open Settings to add one." },
        { status: 400 },
      );
    }

    if (fixture) {
      const inFlightDemo = activeRun();
      if (inFlightDemo) {
        return NextResponse.json(
          { error: "An agent run is already in progress. Let it finish first.", runId: inFlightDemo.id },
          { status: 429 },
        );
      }
      const run = createRun(fixture.url, fixture.provider, fixture.model, true);
      if (hasRecording(host)) {
        setReplay(run.id, {
          sessionId: `demo:${host}`,
          url: `/replay/${run.id}`,
          expiresInSeconds: 0,
          capturedAt: fixture.capturedAt,
        });
      }
      void replay(run.id, fixture);
      return NextResponse.json(
        { id: run.id, url: run.url, provider: run.provider, model: run.model, demo: true },
        { status: 202 },
      );
    }
  }

  if (!isLlmProvider(payload.provider)) {
    return NextResponse.json(
      { error: "No model key set yet — open Settings to add one." },
      { status: 400 },
    );
  }

  // Bring-your-own-key. The app holds no LLM credentials of its own, so a run
  // cannot start without one.
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "An API key for the selected provider is required." },
      { status: 400 },
    );
  }

  const provider = getProvider(payload.provider);
  const model =
    (typeof payload.model === "string" ? payload.model.trim() : "") ||
    provider!.defaultModel;

  const inFlight = activeRun();
  if (inFlight) {
    return NextResponse.json(
      {
        error: "An agent run is already in progress. Let it finish first.",
        runId: inFlight.id,
      },
      { status: 429 },
    );
  }

  const run = createRun(target.toString(), payload.provider, model, false);

  // Fire and forget: the client watches progress over SSE. The run is bounded
  // by its own abort deadline, so nothing can outlive RUN_TIMEOUT_MS. The key
  // lives only in this closure — it is never written to the run record.
  void execute(run.id, target.toString(), {
    provider: payload.provider,
    apiKey,
    model,
  });

  return NextResponse.json(
    { id: run.id, url: run.url, provider: run.provider, model: run.model },
    { status: 202 },
  );
}

/**
 * Play a captured run back onto a fresh timeline. The original gaps are
 * preserved, compressed into DEMO_REPLAY_MS so a recording stays watchable.
 */
async function replay(
  id: string,
  fixture: NonNullable<ReturnType<typeof readFixture>>,
): Promise<void> {
  markRunning(id);

  const startedAt = Date.now();
  for (const { event, delayMs } of scheduleReplay(fixture.events, DEMO_REPLAY_MS)) {
    // Sleep to the event's own offset rather than by the gap, so accumulated
    // scheduling drift never stretches the replay.
    const wait = delayMs - (Date.now() - startedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    appendEvent(id, event.level, event.phase, event.message);
  }
  completeRun(id, fixture.report);
}

/**
 * Hard watchdog for the whole run.
 *
 * The AbortController alone is not enough: it reaches the model SDKs, but
 * Playwright calls ignore AbortSignal entirely, so a browser operation that
 * wedges would leave the run "running" forever — blocking every later run
 * behind the one-at-a-time guard. This races the agent against a wall-clock
 * timer so the run always reaches a terminal state. Orphaned browser work
 * still cleans itself up via withBrowser's `finally` whenever it settles.
 */
function hardDeadline(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Run exceeded its ${ms / 1000}s ceiling and was stopped.`)),
      ms,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function execute(
  id: string,
  url: string,
  credentials: LlmCredentials,
): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  // A little slack past the abort so a cooperative cancel reports first.
  const watchdog = hardDeadline(RUN_TIMEOUT_MS + 15_000);

  markRunning(id);
  appendEvent(id, "info", "boot", `Agent started on ${url}`);

  try {
    const report = await Promise.race([
      watchdog.promise,
      runTeardown(
      url,
      credentials,
      (level, phase, message) => appendEvent(id, level, phase, message),
      controller.signal,
      (replay) => {
        if (replay) setReplay(id, replay);
      },
      ),
    ]);
    completeRun(id, report);

    // Seed the demo fixture from a genuine run, so a replay is always real
    // output the agent produced rather than authored content.
    const host = normaliseHost(url);
    if (DEMO_HOSTS.includes(host as (typeof DEMO_HOSTS)[number])) {
      const finished = getRun(id);
      captureFixture({
        url,
        host,
        provider: credentials.provider,
        model: credentials.model ?? "",
        durationMs: finished?.durationMs ?? 0,
        events: finished?.events ?? [],
        report,
        capturedAt: Date.now(),
      });

      // Store the session recording too, so the replay outlives Solari's
      // 900-second presigned URL and its one-day retention.
      if (finished?.replay) {
        const solari = getSolari();
        try {
          const { url: replayUrl } = await solari.sessions.getReplayUrl(
            finished.replay.sessionId,
          );
          await captureRecording(host, replayUrl);
        } catch {
          // The demo simply has no replay button.
        } finally {
          await solari.close().catch(() => {});
        }
      }
    }
  } catch (err) {
    const message =
      controller.signal.aborted && !(err instanceof Error && err.name === "DeadlineError")
        ? `Run hit the ${RUN_TIMEOUT_MS / 1000}s ceiling and was killed.`
        : err instanceof Error
          ? err.message
          : String(err);
    appendEvent(id, "error", "abort", message);
    failRun(id, message);
  } finally {
    clearTimeout(deadline);
    watchdog.cancel();
  }
}
