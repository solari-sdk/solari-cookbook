// ============================================================================
// Project Polished — Solari run endpoint (server-side proxy)
// Accepts a request to kick off a real Solari agent run against a repo URL.
// When SOLARI_LIVE_MODE=true and a real SDK call is wired in, this is the
// integration point. Otherwise it returns a friendly simulated acknowledgement.
// ============================================================================

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RunRequestBody {
  repoUrl: string;
  stages?: string[];
}

export async function POST(request: Request) {
  let body: RunRequestBody;
  try {
    body = (await request.json()) as RunRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  if (!body.repoUrl || !/^https?:\/\/github\.com\//i.test(body.repoUrl)) {
    return NextResponse.json(
      { ok: false, error: 'repoUrl must be a GitHub URL' },
      { status: 400 },
    );
  }

  const apiKey = process.env.SOLARI_API_KEY;
  const liveMode = process.env.SOLARI_LIVE_MODE === 'true';

  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: 'SOLARI_API_KEY not configured. Add it to .env.local',
      },
      { status: 503 },
    );
  }

  // -----------------------------------------------------------------------
  // LIVE MODE INTEGRATION POINT
  // -----------------------------------------------------------------------
  // When SOLARI_LIVE_MODE=true, this is where you'd call the real Solari SDK:
  //
  //   import { Solari } from '@solari/sdk';
  //   const client = new Solari({ apiKey });
  //   const session = await client.sessions.create({
  //     repoUrl: body.repoUrl,
  //     capabilities: ['browser', 'sandbox', 'desktop'],
  //   });
  //   await client.sessions.run(session.id, body.stages ?? defaultStages);
  //   return NextResponse.json({ ok: true, sessionId: session.id });
  //
  // For the bounty demo, we run in simulated mode (liveMode=false) which means
  // the front-end agent engine orchestrates the visible 6-stage pipeline and
  // only uses this endpoint to log the real key presence for status display.
  // -----------------------------------------------------------------------

  if (liveMode) {
    return NextResponse.json({
      ok: true,
      mode: 'live',
      message: 'Live Solari API call would be made here. Wire in @solari/sdk to enable.',
      repoUrl: body.repoUrl,
      // NOTE: Do NOT echo the key back. Ever.
    });
  }

  return NextResponse.json({
    ok: true,
    mode: 'simulated',
    message: 'Agent pipeline will run in simulated demo mode (SOLARI_LIVE_MODE=false).',
    repoUrl: body.repoUrl,
    keyPreview: maskKey(apiKey),
  });
}

function maskKey(key: string): string {
  if (key.length <= 16) return '••••';
  return `${key.slice(0, 12)}••••${key.slice(-4)}`;
}
