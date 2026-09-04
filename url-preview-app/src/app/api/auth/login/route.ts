import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { users } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { verifyPassword, createSessionToken, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE } from "@/lib/auth"

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}))

  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const user = await db.select().from(users).where(eq(users.email, normalizedEmail)).get()
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Wrong email or password" }, { status: 401 })
  }

  const res = NextResponse.json({ email: user.email })
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: "/",
  })
  return res
}
