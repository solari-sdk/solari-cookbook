import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sessions, users } from "@/lib/schema"
import { sql, desc } from "drizzle-orm"

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret")
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const totalSessions = await db.select({ count: sql<number>`count(*)` }).from(sessions)
  const activeSessions = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(sql`${sessions.status} IN ('pending', 'detecting', 'awaiting_confirm', 'running')`)
  const failedSessions = await db.select({ count: sql<number>`count(*)` }).from(sessions).where(sql`${sessions.status} = 'failed'`)
  const totalCost = await db.select({ sum: sql<number>`coalesce(sum(${sessions.costCents}), 0)` }).from(sessions)
  const usersOverQuota = await db.select().from(users).where(sql`${users.dailyMinutesUsed} >= 120`)

  const recentJobs = await db
    .select({
      id: sessions.id,
      mode: sessions.mode,
      status: sessions.status,
      inputUrl: sessions.inputUrl,
      costCents: sessions.costCents,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .orderBy(desc(sessions.createdAt))
    .limit(50)

  return NextResponse.json({
    totalSessions: totalSessions[0]?.count ?? 0,
    activeSessions: activeSessions[0]?.count ?? 0,
    failedSessions: failedSessions[0]?.count ?? 0,
    totalCostCents: totalCost[0]?.sum ?? 0,
    usersOverQuota: usersOverQuota.length,
    recentJobs,
  })
}
