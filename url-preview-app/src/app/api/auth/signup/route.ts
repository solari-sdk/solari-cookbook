import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { db } from "@/lib/db"
import { users } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { hashPassword, createSessionToken, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE } from "@/lib/auth"

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}))

  if (typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 })
  }
  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const existing = await db.select().from(users).where(eq(users.email, normalizedEmail)).get()
  if (existing) {
    return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 })
  }

  const id = randomUUID()
  await db.insert(users).values({
    id,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    dailyMinutesUsed: 0,
    dailyMinutesResetAt: new Date(),
    createdAt: new Date(),
  })

  const res = NextResponse.json({ email: normalizedEmail })
  res.cookies.set(SESSION_COOKIE, createSessionToken(id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: "/",
  })
  return res
}
