/**
 * Reverse proxy into a repo-mode sandbox's exposed port.
 *
 * Solari's `*.preview.getsolari.com` URLs are reachable by anyone who has
 * them for as long as the sandbox lives — nothing about the URL ties a
 * request back to our session auth. So the client never sees the raw
 * preview URL: the iframe points here, we check session ownership on every
 * request, and only then fetch the real preview URL server-side.
 */
import { NextRequest, NextResponse } from "next/server"
import { getUserId } from "@/lib/auth"
import { getSession } from "@/lib/session-manager"

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "upgrade",
  "host",
])

async function proxy(req: NextRequest, ctx: { params: Promise<{ id: string; path?: string[] }> }) {
  const userId = getUserId(req)
  if (!userId) return new NextResponse("Sign in required", { status: 401 })

  const { id, path } = await ctx.params
  const session = await getSession(id)
  if (!session || session.userId !== userId) {
    return new NextResponse("Not found", { status: 404 })
  }
  if (session.mode !== "repo" || !session.previewUrl || session.status !== "running" || !session.serverReady) {
    return new NextResponse("This session has no live preview right now", { status: 409 })
  }

  const subpath = (path ?? []).join("/")
  const search = req.nextUrl.search
  const target = `${session.previewUrl.replace(/\/$/, "")}/${subpath}${search}`

  const headers = new Headers(req.headers)
  headers.delete("host")
  headers.delete("cookie") // don't leak our app's session cookie into the sandbox

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  }
  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = await req.arrayBuffer()
  }

  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch {
    return new NextResponse("The preview server isn't reachable right now", { status: 502 })
  }

  const outHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value)
  })

  return new NextResponse(upstream.body, { status: upstream.status, headers: outHeaders })
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD }
