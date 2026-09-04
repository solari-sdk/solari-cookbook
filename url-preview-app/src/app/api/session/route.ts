import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { createSession, detectMode, isPrivateOrLocalhost, getSession } from "@/lib/session-manager"
import { detectRepoSession } from "@/lib/repo-runner"
import { runSiteSession } from "@/lib/site-runner"

export async function POST(req: NextRequest) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const { url, mode: forcedMode } = await req.json().catch(() => ({}))
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "URL is required" }, { status: 400 })
  }
  try {
    new URL(url)
  } catch {
    return NextResponse.json({ error: "That doesn't look like a valid URL" }, { status: 400 })
  }
  if (forcedMode && forcedMode !== "repo" && forcedMode !== "site") {
    return NextResponse.json({ error: "mode must be 'repo' or 'site'" }, { status: 400 })
  }

  const mode = forcedMode ?? detectMode(url)
  if (mode === "site" && isPrivateOrLocalhost(url)) {
    return NextResponse.json({ error: "Private and local addresses are blocked in site mode" }, { status: 400 })
  }

  try {
    const sessionId = await createSession(userId, url, forcedMode)
    const session = await getSession(sessionId)
    if (session) {
      if (mode === "repo") detectRepoSession(session).catch(() => {})
      else runSiteSession(session).catch(() => {})
    }
    return NextResponse.json({ sessionId, mode })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
}
