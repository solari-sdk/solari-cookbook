/**
 * Approval handoff — show a person a screenshot, take their yes or no.
 *
 * Most agent pauses do not need a human at the wheel; they need one decision.
 * The agent works up to the last safe moment before a consequential click,
 * takes its own `page.screenshot()`, and asks. Nothing is injected into the
 * page and no relay is opened: the screenshot is not uploaded to Solari or to
 * anyone else — this process serves it directly to one page it hosts itself.
 *
 * Yes and it clicks and finishes. No and it mints the native handoff link —
 * the same relay as `examples/browser-login-handoff-ts` — so the person can
 * take the wheel instead. Look first, take the wheel only if needed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"
import type { AddressInfo } from "node:net"
import { Solari } from "@solarisdk/browser"

const API = "https://api.getsolari.com"
const apiKey = requireEnv("SOLARI_API_KEY")
const TARGET = process.argv[2] ?? "https://httpbin.org/forms/post"
/** Loopback unless you opt in. Any other address serves the screenshot over
 *  plain HTTP, so bind to one only your own devices can reach: `0.0.0.0` puts
 *  it on the local network in the clear. The README says what that costs. */
const HOST = process.env.APPROVAL_HOST ?? "127.0.0.1"
const ASK_TIMEOUT_MS = 5 * 60_000
/** Grace past the handoff's own expiry, and a cap on every single request so
 *  that no one call can outlive the deadline it belongs to. */
const HANDOFF_GRACE_MS = 30_000
const TIMEOUT_MS = 15_000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** The handoff endpoints have no SDK wrapper yet, so call them directly. */
async function api<T>(method: string, path: string, body?: unknown, ms = TIMEOUT_MS) {
  const res = await fetch(`${API}${path}`, {
    method,
    signal: AbortSignal.timeout(ms),
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

const browser = await new Solari({ apiKey }).launch()
try {
  const page = await browser.newPage()
  await page.goto(TARGET, { waitUntil: "domcontentloaded" })

  const question = await reachDecisionPoint(page)
  // The agent takes the picture itself, so the person judges exactly what it sees.
  const answer = await ask(question, await page.screenshot())

  if (answer === "approve") {
    console.log(`approved — ${await performAction(page)}`)
  } else if (answer === "deny") {
    // Denied rarely means stop; it means "not like that". So give them the wheel:
    // `reason` is the question they just read, so the link explains itself.
    const handoff = await api<{ shortUrl: string; expiresAt: string }>(
      "POST",
      `/sessions/${encodeURIComponent(browser.id)}/handoff`,
      { reason: question },
    )
    console.log(`\n  denied — hand them the wheel instead:\n  ${handoff.shortUrl}`)
    console.log(`  expires ${handoff.expiresAt}\n`)

    const outcome = await waitForHuman(browser.id, Date.parse(handoff.expiresAt))
    console.log(`handoff ${outcome.label}`)
    if (!outcome.finished) process.exitCode = 1 // Only a finished handoff is a done job.
  } else {
    console.log("nobody answered — doing nothing, which is the safe half")
    process.exitCode = 1
  }
} finally {
  await browser.close()
}

/** Serve one page on a random port, with a one-time token in the URL, and wait
 *  for a click. Plain HTML forms, no JavaScript: a tap on a phone before any
 *  script could have run has to count the same as a click on a laptop. */
async function ask(question: string, png: Buffer): Promise<AskResult> {
  const token = randomBytes(16).toString("hex")
  const shot = `data:image/png;base64,${png.toString("base64")}`
  // One token, one answer: the state leaves "open" before anything is awaited,
  // so two racing submissions cannot both be told that theirs was the one.
  let state: "open" | "claiming" | "timeout" | Answer = "open"
  let settle: (answer: AskResult) => void
  const answered = new Promise<AskResult>((resolve) => (settle = resolve))

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const method = req.method ?? "GET"
    if (url.searchParams.get("t") !== token) return void reply(res, 404, "not found.")
    if (method === "GET" || method === "HEAD") return void reply(res, 200, render())
    if (method !== "POST") {
      return void reply(res, 405, "use the buttons.", { allow: "GET, HEAD, POST" })
    }
    if (state !== "open") return void reply(res, 410, "this link is spent.")
    state = "claiming"

    const raw = await readBody(req)
    const answer = raw === null ? null : new URLSearchParams(raw).get("answer")
    if (answer !== "approve" && answer !== "deny") {
      state = "open" // A malformed post is not an answer, so it must not spend the link.
      return void reply(res, raw === null ? 413 : 400, "expected approve or deny.")
    }
    state = answer
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    // Settle once the reply is on the wire, so teardown cannot truncate it.
    res.end(render(), () => settle(answer))
  })

  function render(): string {
    const done = state === "approve" ? "Approved" : state === "deny" ? "Denied" : null
    return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve?</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;padding:24px;max-width:760px}
h1{font-size:1.3rem}img{width:100%;border:1px solid #d8d8d8}
form{display:flex;gap:12px;margin:20px 0}img,button{border-radius:8px}
button{flex:1;padding:14px;font:inherit;font-weight:600;color:#fff;border:0}
.yes{background:#177245}.no{background:#555}</style>
<h1>${escapeHtml(question)}</h1>
${done ? `<p><b>${done}. Back to the agent.</b></p>` : `<form method="post">
<button name="answer" value="approve" class="yes">Approve</button>
<button name="answer" value="deny" class="no">Deny</button></form>`}
<img alt="what the agent sees right now" src="${shot}">`
  }

  // A bad APPROVAL_HOST must reject here, not surface as a stray 'error' later.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, HOST, () => (server.off("error", reject), resolve()))
  })

  // A wildcard bind listens everywhere, so 127.0.0.1 would send a phone to itself.
  const { port } = server.address() as AddressInfo
  const shown = HOST === "0.0.0.0" ? (lanAddress() ?? "127.0.0.1") : HOST
  const reachable = shown !== "127.0.0.1"
  console.log("\n  a decision is waiting — open this:")
  console.log(`  http://${shown}:${port}/?t=${token}`)
  // Whoever can reach that address can answer, token in hand, in the clear.
  console.log(reachable ? "  anything on that network can reach it\n" : "  local to this machine\n")

  const timer = setTimeout(() => {
    if (state === "open") state = "timeout"
    settle("timeout")
  }, ASK_TIMEOUT_MS)
  try {
    return await answered
  } finally {
    // close() first, then drop the sockets: the other order lets a connection
    // slip in between and hold the process open.
    clearTimeout(timer)
    const closed = new Promise<void>((r) => server.close(() => r()))
    server.closeAllConnections()
    await closed
  }
}

/** Poll until the person is finished. The gateway parks no terminal status:
 *  measured 2026-09-08, a handoff goes `pending` -> `none` within a second of
 *  "I'm done", never through `completed`. The record is dropped when it ends
 *  and again when it expires, so `none` alone cannot tell those apart — but
 *  the link's own expiry can, which is why that is the deadline here. */
async function waitForHuman(sessionId: string, expiresAt: number): Promise<Outcome> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/handoff`
  const deadline = expiresAt + HANDOFF_GRACE_MS
  // A failed request is not a pause to wait out; it ends the wait as itself.
  const failed = (error: Error) => ({ status: `unreachable — ${error.message}` })
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return { finished: false, label: "timed out" }
    const ms = Math.min(TIMEOUT_MS, left)
    const { status } = await api<Status>("GET", path, undefined, ms).catch(failed)
    if (status === "completed") return { finished: true, label: "completed" }
    if (status === "none") {
      const ended = Date.now() < expiresAt
      return { finished: ended, label: ended ? "over" : "expired — nobody finished it" }
    }
    if (status !== "pending") return { finished: false, label: status }
    await new Promise((r) => setTimeout(r, 2000)) // Faster than any transition seen.
  }
}

/** Replace these two with your own decision point and your own click. httpbin
 *  only echoes the form back, so it changes nothing — it stands in for a click
 *  you would not want an agent to take on its own. */
async function reachDecisionPoint(page: Page): Promise<string> {
  await page.fill("input[name=custname]", "Ada Lovelace")
  await page.check("input[value=large]")
  await page.check("input[value=cheese]")
  await page.fill("textarea[name=comments]", "Placed by an agent, approved by a human.")
  const host = new URL(TARGET).hostname
  return `Order a large pizza with extra cheese for Ada Lovelace? ${host} only echoes` +
    " the form back, so this stands in for a click you could not undo."
}

async function performAction(page: Page): Promise<string> {
  await page.click("button")
  await page.waitForLoadState("domcontentloaded")
  const form = JSON.parse((await page.textContent("body")) ?? "{}").form ?? {}
  return `${page.url()} took a ${form.size} order for ${form.custname}`
}

/** The SDK's page type, without adding patchright-core as a dependency. */
type Page = Awaited<ReturnType<Awaited<ReturnType<Solari["launch"]>>["newPage"]>>
type Answer = "approve" | "deny"
type AskResult = Answer | "timeout"
type Outcome = { finished: boolean; label: string }
type Status = { status: string }
type Headers = Record<string, string>

/** Declared, not assigned: the request handler runs while the top-level await
 *  above is still pending, so a `const` down here would be in its dead zone. */
function lanAddress(): string | null {
  const nets = Object.values(networkInterfaces()).flat()
  return nets.find((n) => n?.family === "IPv4" && !n.internal)?.address ?? null
}

/** An answer is two words; cap the body, because this port can be on a LAN. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  let raw = ""
  for await (const chunk of req) if ((raw += chunk).length > 1024) return null
  return raw
}

function reply(res: ServerResponse, code: number, text: string, extra?: Headers) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...extra })
  res.end(`<!doctype html><meta charset="utf-8"><p>${text}</p>`)
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)
}
