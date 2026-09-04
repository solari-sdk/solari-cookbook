import { NextRequest } from "next/server"
import { getUserId } from "@/lib/auth"
import { db } from "@/lib/db"
import { logEntries, sessions } from "@/lib/schema"
import { eq } from "drizzle-orm"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req)
  if (!userId) return new Response("Sign in required", { status: 401 })

  const { id } = await params
  const owner = await db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.id, id)).get()
  if (!owner || owner.userId !== userId) {
    return new Response("Not found", { status: 404 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let lastId = 0
      let closed = false

      const sendEntries = async () => {
        const entries = await db.select().from(logEntries).where(eq(logEntries.sessionId, id))
        for (const entry of entries) {
          if (entry.id > lastId) {
            const data = JSON.stringify({
              id: entry.id,
              timestamp: entry.timestamp,
              level: entry.level,
              phase: entry.phase,
              message: entry.message,
            })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            lastId = entry.id
          }
        }
      }

      await sendEntries()

      const interval = setInterval(async () => {
        if (closed) return
        try {
          await sendEntries()
          const s = await db.select().from(sessions).where(eq(sessions.id, id)).get()
          if (s) {
            controller.enqueue(
              encoder.encode(
                `event: session\ndata: ${JSON.stringify({
                  status: s.status,
                  detectedFramework: s.detectedFramework,
                  detectedPkgManager: s.detectedPkgManager,
                  detectedPort: s.detectedPort,
                  installCmd: s.installCmd,
                  buildCmd: s.buildCmd,
                  startCmd: s.startCmd,
                  isStatic: s.isStatic,
                  serverReady: s.serverReady,
                  outOfScopeReason: s.outOfScopeReason,
                  errorSummary: s.errorSummary,
                  expiresAt: s.expiresAt,
                  extendCount: s.extendCount,
                })}\n\n`,
              ),
            )
            if (s.status === "done" || s.status === "failed" || s.status === "killed") {
              clearInterval(interval)
              closed = true
              controller.close()
            }
          }
        } catch {
          clearInterval(interval)
          closed = true
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
      }, 750)

      req.signal.addEventListener("abort", () => {
        clearInterval(interval)
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
