// ============================================================================
// Project Polished — Solari status endpoint (server-side)
// Returns whether a live Solari API key is configured + which mode the engine
// is running in. NEVER returns the key itself.
// ============================================================================

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const hasKey = Boolean(process.env.SOLARI_API_KEY);
  const liveMode = process.env.SOLARI_LIVE_MODE === 'true';

  return NextResponse.json({
    hasApiKey: hasKey,
    liveMode,
    // Mask the key for the UI — show only first 12 chars + last 4
    keyPreview: hasKey ? maskKey(process.env.SOLARI_API_KEY!) : null,
    sdkVersion: '0.4.2',
    timestamp: Date.now(),
  });
}

function maskKey(key: string): string {
  if (key.length <= 16) return '••••';
  return `${key.slice(0, 12)}••••${key.slice(-4)}`;
}
