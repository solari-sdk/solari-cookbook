import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { normaliseHost, readRecording } from "@/lib/demo";
import { getSolari } from "@/lib/solari";
import { getRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve the recorded session as a JSON array of rrweb events.
 *
 * Proxied rather than fetched straight from the browser for two reasons: the
 * presigned S3 URL lives only 900 seconds (so it is minted per request here),
 * and the bucket does not serve CORS headers for our origin.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const run = getRun(id);

  if (!run?.replay) {
    return NextResponse.json(
      { error: "No replay recorded for this run." },
      { status: 404 },
    );
  }

  // A replayed demo has no live Solari session — its recording was captured to
  // disk when the original run completed.
  if (run.demo) {
    const events = readRecording(normaliseHost(run.url));
    if (!events) {
      return NextResponse.json(
        { error: "No stored recording for this demo." },
        { status: 404 },
      );
    }
    return NextResponse.json({ events, sessionId: run.replay.sessionId });
  }

  const solari = getSolari();
  try {
    const { url } = await solari.sessions.getReplayUrl(run.replay.sessionId);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json(
        { error: `Replay download failed: HTTP ${response.status}` },
        { status: 502 },
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // The object is stored gzipped. `fetch` transparently decompresses when the
    // response carries `content-encoding: gzip`, but not when the gzip is the
    // body itself — so sniff the magic bytes instead of trusting headers.
    const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const text = (isGzip ? gunzipSync(buffer) : buffer).toString("utf8");

    const events: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // A truncated trailing line is expected on an interrupted recording.
      }
    }

    if (events.length === 0) {
      return NextResponse.json(
        { error: "The recording is empty." },
        { status: 404 },
      );
    }

    return NextResponse.json({ events, sessionId: run.replay.sessionId });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Could not load the replay: ${err.message}`
            : "Could not load the replay.",
      },
      { status: 502 },
    );
  } finally {
    await solari.close().catch(() => {});
  }
}
