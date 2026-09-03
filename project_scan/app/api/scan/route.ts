import { runScan } from "@/lib/server/scan";
import type { ScanEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(data: ScanEvent): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  if (!url) {
    return new Response("Missing url parameter", { status: 400 });
  }

  const scanId = crypto.randomUUID();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: ScanEvent) => {
        controller.enqueue(encoder.encode(sse(event)));
      };

      try {
        await runScan(scanId, url, emit);
      } catch (err) {
        emit({
          type: "log",
          message: err instanceof Error ? err.message : "Scan failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
