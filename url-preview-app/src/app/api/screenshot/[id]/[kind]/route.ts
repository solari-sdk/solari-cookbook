import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession } from "@/lib/session-manager"
import { db } from "@/lib/db"
import { screenshots } from "@/lib/schema"
import { eq, and, desc } from "drizzle-orm"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const userId = getUserId(req)
  if (!userId) return new NextResponse("Sign in required", { status: 401 })

  const { id, kind } = await params
  if (kind !== "load" && kind !== "settle") return new NextResponse("Not found", { status: 404 })

  const session = await getSession(id)
  if (!session || session.userId !== userId) return new NextResponse("Not found", { status: 404 })

  const shot = await db
    .select()
    .from(screenshots)
    .where(and(eq(screenshots.sessionId, id), eq(screenshots.kind, kind)))
    .orderBy(desc(screenshots.takenAt))
    .get()
  if (!shot) return new NextResponse("Not found", { status: 404 })

  return new NextResponse(new Uint8Array(shot.data), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" },
  })
}
