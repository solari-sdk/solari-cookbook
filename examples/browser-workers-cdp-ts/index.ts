/**
 * Drive a Solari browser from a Cloudflare Worker, over raw CDP.
 *
 * `@solarisdk/browser` bundles a Playwright fork, which wants a Node runtime
 * and raw TCP sockets, so it cannot run on Workers. The usual workaround is to
 * put a small Node service next to the Worker just to hold the browser — an
 * extra hop, an extra deploy, and an extra thing to page someone about.
 *
 * You don't need it. Solari hands out each session's Chrome DevTools Protocol
 * endpoint, and a Worker can hold an outbound WebSocket, so the Worker can
 * speak CDP itself. That is this whole example: a REST call to get a session,
 * about sixty lines of protocol, and no Node process anywhere in the path.
 *
 *     GET /?url=https://example.com
 */

type Env = { SOLARI_API_KEY: string }

const SOLARI_API = "https://api.getsolari.com"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const target =
      new URL(request.url).searchParams.get("url") ?? "https://example.com"

    const session = await createSession(env.SOLARI_API_KEY)
    const cdp = await connect(session.cdpEndpoint)

    try {
      // A CDP connection is the *browser*, not a page. Open a tab, then attach
      // to it. `flatten: true` multiplexes that tab's traffic down this same
      // socket, tagged with a session id you must then pass on every command
      // meant for the page — omit it and you are talking to the browser again,
      // which will politely tell you the method does not exist.
      const { targetId } = await cdp.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      )
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      )

      // Domains are opt-in and silent until enabled: `Page.loadEventFired`
      // below never arrives without this line, and the navigation looks like
      // it hung.
      await cdp.send("Page.enable", {}, sessionId)
      await cdp.send("Runtime.enable", {}, sessionId)

      const loaded = cdp.once("Page.loadEventFired")
      // `Page.navigate` resolves when the navigation *starts*, not when the
      // page is ready. Read the DOM off the back of this promise and you read
      // about:blank. Subscribe before navigating, so a fast page cannot fire
      // the event before anyone is listening.
      await cdp.send("Page.navigate", { url: target }, sessionId)
      await loaded

      return Response.json({
        url: await evaluate<string>(cdp, sessionId, "location.href"),
        title: await evaluate<string>(cdp, sessionId, "document.title"),
        h1: await evaluate<string | null>(
          cdp,
          sessionId,
          "document.querySelector('h1')?.innerText ?? null",
        ),
        session: session.sessionId,
      })
    } finally {
      cdp.close()
      // Sessions are billable and your plan caps how many run at once, so the
      // release is unconditional — a thrown error must not leak a browser.
      // Closing the socket does NOT end the session; the VM runs on until its
      // idle timeout. In a real handler, hand this to `ctx.waitUntil()` so the
      // response is not waiting on it.
      await releaseSession(env.SOLARI_API_KEY, session.sessionId)
    }
  },
} satisfies ExportedHandler<Env>

/* -------------------------------------------------------------------------- */
/* The REST half: get a session, give it back                                  */
/* -------------------------------------------------------------------------- */

type Session = { sessionId: string; cdpEndpoint: string }

async function createSession(apiKey: string): Promise<Session> {
  const response = await fetch(`${SOLARI_API}/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ stealth: false }),
  })
  if (!response.ok) {
    throw new Error(
      `create session failed (${response.status}): ${await response.text()}`,
    )
  }

  const body = (await response.json()) as {
    sessionId?: string
    id?: string
    wsEndpoint: string
    cdpEndpoint?: string
  }

  // Two defensive reads, both earned. The identifier is `sessionId` on the
  // wire but `id` on the SDKs' own `Session` type. And `cdpEndpoint` is
  // optional — when the gateway omits it, the SDKs derive it from the
  // WebSocket endpoint by swapping the path segment, so do the same.
  const sessionId = body.sessionId ?? body.id
  if (!sessionId || !body.wsEndpoint) {
    throw new Error("create session returned no session id or wsEndpoint")
  }

  return {
    sessionId,
    cdpEndpoint: body.cdpEndpoint ?? body.wsEndpoint.replace("/ws/", "/cdp/"),
  }
}

async function releaseSession(apiKey: string, sessionId: string) {
  await fetch(`${SOLARI_API}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}` },
  })
}

/* -------------------------------------------------------------------------- */
/* The protocol half: a CDP client small enough to read                        */
/* -------------------------------------------------------------------------- */

type Cdp = {
  send<T>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>
  once(method: string): Promise<Record<string, unknown>>
  close(): void
}

async function connect(endpoint: string): Promise<Cdp> {
  // A Worker has no `new WebSocket(url)`. You upgrade an outbound `fetch`
  // instead — and `fetch` will not take a ws:// URL, so swap the scheme and
  // ask for the upgrade by header.
  const response = await fetch(
    endpoint.replace(/^ws:/, "http:").replace(/^wss:/, "https:"),
    { headers: { Upgrade: "websocket" } },
  )

  const socket = response.webSocket
  if (!socket) {
    throw new Error(`CDP endpoint did not upgrade (HTTP ${response.status})`)
  }
  // `accept()` is what hands the socket to this Worker. Forget it and nothing
  // errors: you just never receive a single message.
  socket.accept()

  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  const waiting = new Map<string, (params: Record<string, unknown>) => void>()

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return
    const message = JSON.parse(event.data)

    // One socket carries two kinds of frame: a reply, which has the `id` you
    // sent, and an event, which has a `method`. Everything else about CDP
    // follows from keeping those two apart.
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(`CDP: ${message.error.message}`))
      else waiter.resolve(message.result ?? {})
      return
    }

    if (typeof message.method === "string") {
      waiting.get(message.method)?.(message.params ?? {})
    }
  })

  const fail = (reason: string) => {
    for (const [, waiter] of pending) waiter.reject(new Error(reason))
    pending.clear()
  }
  socket.addEventListener("close", () => fail("CDP socket closed"))
  socket.addEventListener("error", () => fail("CDP socket errored"))

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++
      const frame = sessionId
        ? { id, method, params, sessionId }
        : { id, method, params }

      return new Promise((resolve, reject) => {
        // Always bound the wait. A CDP call that never gets an answer would
        // otherwise hang the request until the Worker is killed, and the
        // browser session would go with it — see the `finally` above.
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} timed out`))
        }, 30_000)

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        socket.send(JSON.stringify(frame))
      })
    },

    once(method) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(method)
          reject(new Error(`timed out waiting for ${method}`))
        }, 30_000)

        waiting.set(method, (params) => {
          clearTimeout(timer)
          waiting.delete(method)
          resolve(params)
        })
      })
    },

    close() {
      fail("CDP connection closed by client")
      try {
        socket.close(1000, "done")
      } catch {
        // Already gone. Closing is best effort.
      }
    },
  }
}

/** Run an expression in the page and get its value back. */
async function evaluate<T>(
  cdp: Cdp,
  sessionId: string,
  expression: string,
): Promise<T> {
  const result = await cdp.send<{
    result?: { value?: unknown }
    exceptionDetails?: { text?: string }
  }>(
    "Runtime.evaluate",
    // `returnByValue` serialises the result instead of handing back a remote
    // object reference you would then have to fetch separately.
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )

  // A page that throws comes back as a normal CDP reply, not an error frame.
  // Without this check a broken page reads as `undefined`.
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.text ?? "unknown"}`)
  }
  return result.result?.value as T
}
