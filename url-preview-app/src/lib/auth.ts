import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "crypto"
import { NextRequest } from "next/server"

const COOKIE_NAME = "session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000 // 30 days

function authSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is not set")
  return secret
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString("hex")}:${hash.toString("hex")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":")
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, "hex")
  const expected = Buffer.from(hashHex, "hex")
  const actual = scryptSync(password, salt, 64)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function sign(payload: string): string {
  return createHmac("sha256", authSecret()).update(payload).digest("hex")
}

// Signed, stateless session token: "<userId>.<expiresAtMs>.<hmac>"
export function createSessionToken(userId: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = `${userId}.${expiresAt}`
  return `${payload}.${sign(payload)}`
}

export function verifySessionToken(token: string): string | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [userId, expiresAtStr, sig] = parts
  const payload = `${userId}.${expiresAtStr}`
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
  return userId
}

export const SESSION_COOKIE = COOKIE_NAME
export const SESSION_COOKIE_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000)

// Every route that touches a session must own it — there is no anonymous
// mode. Returns null rather than throwing so callers can return a plain 401.
export function getUserId(req: NextRequest): string | null {
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifySessionToken(token)
}
