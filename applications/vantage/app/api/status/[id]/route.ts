import { getRun, subscribe } from "@/lib/store";
import type { StatusPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Comment frames keep proxies from idling the connection out. */
const HEARTBEAT_MS = 15_000;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const run = getRun(id);

  if (!run) {
    return new Response(JSON.stringify({ error: "Unknown run id." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (payload: StatusPayload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      // Replay first so a late-joining or reloading client sees the full log.
      write({ type: "state", status: run.status, url: run.url });
      for (const event of run.events) write({ type: "event", event });
      if (run.replay) write({ type: "replay", replay: run.replay });

      if (run.status === "done" && run.report) {
        write({ type: "done", report: run.report, durationMs: run.durationMs ?? 0 });
      } else if (run.status === "error") {
        write({ type: "error", error: run.error ?? "Run failed." });
      }

      const unsubscribe = subscribe(id, (payload) => {
        write(payload);
        if (payload.type === "done" || payload.type === "error") {
          // Give the frame a tick to flush before tearing the stream down.
          setTimeout(shutdown, 50);
        }
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          shutdown();
        }
      }, HEARTBEAT_MS);

      if (run.status === "done" || run.status === "error") {
        setTimeout(shutdown, 50);
      }

      request.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering so events arrive as they are produced.
      "x-accel-buffering": "no",
    },
  });
}
