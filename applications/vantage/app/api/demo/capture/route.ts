import { NextResponse } from "next/server";
import {
  DEMO_HOSTS,
  captureFixture,
  captureRecording,
  hasRecording,
  normaliseHost,
} from "@/lib/demo";
import { getSolari } from "@/lib/solari";
import { getRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save a completed run as a demo fixture, session recording included.
 *
 * Capture already happens automatically when a run finishes. This exists to
 * backfill a run that completed before that did — or one whose recording
 * download failed — while the run is still in memory and Solari still holds
 * the recording (roughly a day).
 */
export async function POST(request: Request) {
  let payload: { runId?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof payload.runId !== "string") {
    return NextResponse.json({ error: "Missing 'runId'." }, { status: 400 });
  }

  const run = getRun(payload.runId);
  if (!run) {
    return NextResponse.json({ error: "Unknown run id." }, { status: 404 });
  }
  if (run.status !== "done" || !run.report) {
    return NextResponse.json(
      { error: "Only a completed run can be saved." },
      { status: 409 },
    );
  }

  const host = normaliseHost(run.url);
  if (!DEMO_HOSTS.includes(host as (typeof DEMO_HOSTS)[number])) {
    return NextResponse.json(
      { error: `${host} is not one of the demo hosts.` },
      { status: 400 },
    );
  }

  captureFixture({
    url: run.url,
    host,
    provider: run.provider,
    model: run.model,
    durationMs: run.durationMs ?? 0,
    events: run.events,
    report: run.report,
    capturedAt: Date.now(),
  });

  let recording = hasRecording(host);
  if (run.replay && !run.demo) {
    const solari = getSolari();
    try {
      const { url } = await solari.sessions.getReplayUrl(run.replay.sessionId);
      recording = (await captureRecording(host, url)) || recording;
    } catch {
      // Solari may have already aged the recording out.
    } finally {
      await solari.close().catch(() => {});
    }
  }

  return NextResponse.json({ host, fixture: true, recording });
}
