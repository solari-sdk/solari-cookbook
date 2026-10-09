// Serving files: artifacts (with byte ranges, so the video can seek) and, in
// production, the built web app with its client-side routes.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, normalize, sep } from "node:path"
import { Readable } from "node:stream"

/** Serves a file, honouring a single byte range. */
export function fileResponse(path: string, type: string, range?: string): Response {
  const size = statSync(path).size
  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      },
    })
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
  })
}

const DIST = join(import.meta.dirname, "..", "web", "dist")
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

/** A file from web/dist, or index.html for client-side routes such as /c/<token>. */
export function webApp(urlPath: string): Response {
  if (!existsSync(DIST)) {
    return new Response("The web app is not built. Run `pnpm run build`, or use `pnpm run dev:api` and `pnpm run dev:web` for development.", {
      status: 503,
    })
  }
  const path = normalize(join(DIST, decodeURIComponent(urlPath)))
  if (path.startsWith(DIST + sep) && existsSync(path) && statSync(path).isFile()) {
    return fileResponse(path, TYPES[extname(path)] ?? "application/octet-stream")
  }
  return new Response(readFileSync(join(DIST, "index.html"), "utf8"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}
