import { getScan } from "@/lib/server/db";

const COLORS = { pass: "#34d399", warn: "#fbbf24", fail: "#f87171" };

export async function GET(_req: Request, ctx: RouteContext<"/og/[scanId]">) {
  const { scanId } = await ctx.params;
  let scan = null;
  try {
    scan = await getScan(scanId);
  } catch {
    return new Response("Unavailable", { status: 503 });
  }
  if (!scan) return new Response("Not found", { status: 404 });

  const color = COLORS[scan.verdict];
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#09090b"/>
  <text x="60" y="120" fill="#71717a" font-family="monospace" font-size="28">SiteScan</text>
  <text x="60" y="280" fill="${color}" font-family="monospace" font-size="96" font-weight="bold">${scan.verdict.toUpperCase()}</text>
  <text x="60" y="360" fill="#fafafa" font-family="monospace" font-size="40">${scan.hostname}</text>
  <text x="60" y="430" fill="#a1a1aa" font-family="sans-serif" font-size="28">${scan.findings.length} finding(s)</text>
</svg>`;

  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
  });
}
