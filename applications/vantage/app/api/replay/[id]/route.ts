import { NextResponse } from "next/server";
import { getSolari } from "@/lib/solari";
import { getRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redirect to a freshly minted replay link.
 *
 * Solari's presigned URL lives for 900 seconds — fifteen minutes — while the
 * recording itself is retained far longer. Baking the URL from run time into
 * the page would leave a dead link on any report older than that, so the
 * button points here and the URL is minted at click time instead.
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

  const solari = getSolari();
  try {
    const { url } = await solari.sessions.getReplayUrl(run.replay.sessionId);
    return NextResponse.redirect(url, 307);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `Solari could not produce the replay: ${err.message}`
            : "Solari could not produce the replay.",
      },
      { status: 502 },
    );
  } finally {
    await solari.close().catch(() => {});
  }
}
