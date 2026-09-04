import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession } from "@/lib/session-manager"
import { db } from "@/lib/db"
import { downloads, clipboardEvents, screenshots } from "@/lib/schema"
import { eq } from "drizzle-orm"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const { id } = await params
  const session = await getSession(id)
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (session.mode !== "site") {
    return NextResponse.json({ error: "Only site sessions have a behaviour report" }, { status: 400 })
  }

  const [dl, clip, shots] = await Promise.all([
    db.select().from(downloads).where(eq(downloads.sessionId, id)),
    db.select().from(clipboardEvents).where(eq(clipboardEvents.sessionId, id)),
    db.select({ kind: screenshots.kind }).from(screenshots).where(eq(screenshots.sessionId, id)),
  ])

  return NextResponse.json({
    downloads: dl,
    clipboardEvents: clip,
    screenshotKinds: [...new Set(shots.map((s) => s.kind))],
  })
}
