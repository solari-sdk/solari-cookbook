import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession, updateSession } from "@/lib/session-manager"

export async function POST(req: NextRequest) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const { sessionId } = await req.json().catch(() => ({}))
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 })

  const session = await getSession(sessionId)
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (session.status !== "running") {
    return NextResponse.json({ error: "Session is not running" }, { status: 400 })
  }

  await updateSession(sessionId, { lastHeartbeat: new Date() })
  return NextResponse.json({ ok: true })
}
