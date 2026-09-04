import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession, killSession } from "@/lib/session-manager"

export async function POST(req: NextRequest) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const { sessionId } = await req.json().catch(() => ({}))
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 })

  const session = await getSession(sessionId)
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  await killSession(sessionId)
  return NextResponse.json({ ok: true })
}
