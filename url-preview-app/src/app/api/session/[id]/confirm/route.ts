import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession } from "@/lib/session-manager"
import { runRepoSession } from "@/lib/repo-runner"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const { id } = await params
  const session = await getSession(id)
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (session.mode !== "repo") {
    return NextResponse.json({ error: "Only repo sessions need confirming" }, { status: 400 })
  }
  if (session.status !== "awaiting_confirm") {
    return NextResponse.json({ error: `Session is ${session.status}, not awaiting confirmation` }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const port = body.port !== undefined ? Number(body.port) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return NextResponse.json({ error: "port must be a valid port number" }, { status: 400 })
  }

  runRepoSession(id, {
    installCmd: typeof body.installCmd === "string" ? body.installCmd : undefined,
    buildCmd: typeof body.buildCmd === "string" ? body.buildCmd : undefined,
    startCmd: typeof body.startCmd === "string" ? body.startCmd : undefined,
    port,
  }).catch(() => {})

  return NextResponse.json({ status: "running" })
}
