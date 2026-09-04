import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession, extendSession, addLog } from "@/lib/session-manager"
import { getSandbox } from "@/lib/session-registry"
import { armWallClockCap } from "@/lib/repo-runner"

export async function POST(req: NextRequest) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const { sessionId } = await req.json().catch(() => ({}))
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 })

  const session = await getSession(sessionId)
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  try {
    const newExpiry = await extendSession(sessionId)

    // Re-arm the wall-clock timer against the new expiry.
    const sandbox = getSandbox(sessionId)
    if (sandbox) {
      const fresh = await getSession(sessionId)
      if (fresh) armWallClockCap(fresh, sandbox)
    }

    await addLog(sessionId, "info", `Extended by 15 minutes, now expires at ${newExpiry.toISOString()}`, "extend")
    return NextResponse.json({ expiresAt: newExpiry.toISOString() })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
}
