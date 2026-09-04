import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { db } from "@/lib/db"
import { users } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { DAILY_MINUTES_LIMIT } from "@/lib/session-manager"

export async function GET(req: NextRequest) {
  const userId = getUserId(req)
  if (!userId) return NextResponse.json({ user: null })

  const user = await db.select().from(users).where(eq(users.id, userId)).get()
  if (!user) return NextResponse.json({ user: null })

  return NextResponse.json({
    user: {
      email: user.email,
      dailyMinutesUsed: user.dailyMinutesUsed ?? 0,
      dailyMinutesLimit: DAILY_MINUTES_LIMIT,
    },
  })
}
