import { getScan } from "@/lib/server/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/scans/[id]">) {
  const { id } = await ctx.params;
  try {
    const scan = await getScan(id);
    if (!scan) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(scan);
  } catch {
    return Response.json({ error: "Database unavailable" }, { status: 503 });
  }
}
