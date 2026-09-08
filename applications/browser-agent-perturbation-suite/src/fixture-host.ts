import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { SolariClient } from "@solarisdk/sdk"
import type { ResourceStack } from "./lifecycle.js"
import type { SiteConfig } from "./perturbations.js"
import type { ServerState } from "./verify.js"

const PORT = 3000
const SHOP = fileURLToPath(new URL("../fixture/shop.py", import.meta.url))

/**
 * Every call to the shop is bounded.
 *
 * `fetch` has no default timeout, and the SDK's own RPC bound is 300 s, so a
 * wedged VM would otherwise hang a trial — and hold its paid browser session —
 * with no upper limit.
 */
const HTTP_TIMEOUT_MS = 15_000

function get(url: string | URL): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
}

/**
 * The benchmark site, hosted in a Solari sandbox and reachable over real HTTPS.
 *
 * This is why a cloud browser earns its place. The site has to be somewhere the
 * remote browser can actually reach — a server on your laptop is not it — and
 * an inline `data:` page cannot hold server-side state at all, which would
 * leave nothing to verify against except the page the agent just touched.
 *
 * One sandbox serves the whole suite. Trials are isolated by run id rather than
 * by VM, which keeps the run inside a free plan's single-sandbox allowance.
 */
export interface FixtureHost {
  /** Build a URL for a run without destroying the preview token. */
  urlFor(path: string, runId: string): string
  register(runId: string, variant: string, seed: number, config: SiteConfig): Promise<void>
  /** Authoritative state, read process-to-server. Never through the page. */
  readState(runId: string): Promise<ServerState>
}

export async function startFixture(
  apiKey: string,
  stack: ResourceStack,
  log: (message: string) => void,
): Promise<FixtureHost> {
  const client = new SolariClient({ apiKey })

  // Registered for teardown in the same expression that creates it, so no
  // statement can run in between and orphan a VM that is already billing.
  const sandbox = stack.add(
    "fixture sandbox",
    await client.sandboxes.create({
      template: "base",
      timeoutMs: 15 * 60_000,
      // If this process dies without unwinding, the gateway destroys the VM
      // rather than pausing it. A paused sandbox is still a sandbox you own.
      lifecycle: { onTimeout: "kill" },
    }),
    // kill(), not close(). close() drops our control channel and leaves the VM
    // running — and billing — until its idle timeout.
    (s) => s.kill(),
  )

  await sandbox.connect()
  const shop = (await readFile(SHOP, "utf8"))
    .replace("PORTNUM", String(PORT))
    .replace("BINDHOST", "0.0.0.0")
  await sandbox.files.write("/tmp/shop.py", shop)

  // `commands.run` is not shell-interpreted — it would look for a binary
  // literally named "python3 /tmp/shop.py &". And it waits for the process to
  // exit, so a foreground server would block until the sandbox times out.
  await sandbox.commands.run("sh", {
    args: ["-c", "nohup python3 /tmp/shop.py >/tmp/shop.log 2>&1 &"],
  })

  const { url } = await sandbox.previewUrl(PORT)

  const urlFor = (path: string, runId: string): string => {
    // `previewUrl` hands back an address that already carries `?pt_token=`.
    // Concatenating a path onto it puts the path *after* the query string and
    // every request 404s, so paths go through URL.
    const u = new URL(url)
    u.pathname = path
    u.searchParams.set("run", runId)
    return u.toString()
  }

  await waitForHealth(url, sandbox, log)
  log(`fixture up at ${new URL(url).host}`)

  return {
    urlFor,
    async register(runId, variant, seed, config) {
      const target = new URL(url)
      target.pathname = "/__suite/session"
      const response = await fetch(target, {
        method: "POST",
        body: JSON.stringify({ runId, variant, seed, config }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`could not register run ${runId}: HTTP ${response.status}`)
    },
    async readState(runId) {
      const response = await get(urlFor("/__suite/state", runId))
      if (!response.ok) throw new Error(`state read failed: HTTP ${response.status}`)
      return (await response.json()) as ServerState
    },
  }
}

/**
 * Wait for the server, then prove a *second* navigation works.
 *
 * The second check is the one that earns its keep. If the preview token were
 * not surviving the links the fixture emits, every trial would fail at the
 * first click and the suite would confidently report an agent that cannot press
 * a button. Finding that out costs two HTTP requests here instead of eight
 * browser sessions later.
 */
async function waitForHealth(
  base: string,
  sandbox: { files: { readText(path: string): Promise<string> } },
  log: (message: string) => void,
): Promise<void> {
  const health = new URL(base)
  health.pathname = "/__suite/health"

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      if ((await get(health)).ok) {
        const probe = new URL(base)
        probe.pathname = "/__suite/state"
        probe.searchParams.set("run", "preflight")
        // 404 is the right answer for an unregistered run: it proves routing
        // and the query string both survived the round trip.
        if ((await get(probe)).status === 404) return
        throw new Error("the preview URL did not preserve its query string")
      }
    } catch (error) {
      if (attempt === 29) throw error
    }
  }

  // Say why it never came up, while the VM is still alive to ask.
  const tail = await sandbox.files.readText("/tmp/shop.log").catch(() => "(no log)")
  throw new Error(`the benchmark site never came up.\n${tail}`)
}
