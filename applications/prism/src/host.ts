/**
 * Host the demo site inside a Solari sandbox, on a public URL.
 *
 * A cloud browser cannot reach `127.0.0.1` on your laptop, so `--backend
 * solari` has nothing to point at unless the site lives somewhere public.
 * Rather than ask the reader to deploy something, Prism serves it from a
 * sandbox and takes the preview URL -- browser and sandbox on the same key,
 * which is the thing the cookbook's own README calls out about Solari.
 *
 * Constraints this is built around, both measured or reported rather than
 * assumed:
 *   - The base image ships Node 18 and has no build step (reported in #34), so
 *     what gets uploaded is the same plain `site.js` / `server.js` the local
 *     run uses. No TypeScript, no npm install, no second copy of the app.
 *   - `previewUrl()` returns a URL that is ALREADY signed: the credential is a
 *     `pt_token` query parameter. Measured 2026-09-08 against a live sandbox:
 *     the returned URL fetches 200, the same origin without the query is
 *     `401 invalid preview token`, and the token is rejected as an
 *     Authorization / x-solari-token header or a cookie. So the query string
 *     is load-bearing -- rebuild the URL and you lock yourself out. Append
 *     paths by setting `pathname`, never by concatenation (the trap in #44).
 */
import { readFileSync } from "node:fs"
import { SolariClient } from "@solarisdk/sdk"

export type HostedSite = {
  url: string
  /** Node version actually running in the guest, for the record. */
  nodeVersion: string
  close: () => Promise<void>
}

const GUEST_DIR = "/tmp/prism-site"
const GUEST_PORT = 3000

export async function hostInSandbox(
  apiKey: string,
  opts: { fix?: boolean; timeoutMs?: number; readyTimeoutMs?: number } = {},
): Promise<HostedSite> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const readyTimeoutMs = opts.readyTimeoutMs ?? 45_000

  const here = new URL("../demo-site/", import.meta.url)
  const site = readFileSync(new URL("site.js", here), "utf8")
  const server = readFileSync(new URL("server.js", here), "utf8")

  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs })

  // Register teardown before anything else can fail: a sandbox that is created
  // and then orphaned by a throw keeps billing and holds one of the two
  // concurrent slots a Starter account gets.
  const close = async () => { await sandbox.kill().catch(() => {}) }

  try {
    await sandbox.connect()

    const node = await sandbox.commands.run("node", { args: ["--version"] })
    const nodeVersion = (node.stdout ?? "").trim() || "unknown"

    await sandbox.files.mkdir(GUEST_DIR)
    await sandbox.files.write(`${GUEST_DIR}/site.js`, site)
    await sandbox.files.write(`${GUEST_DIR}/server.js`, server)
    // `server.js` and `site.js` use ESM. Without this the guest's Node treats
    // a bare `.js` as CommonJS and the import throws.
    await sandbox.files.write(`${GUEST_DIR}/package.json`, JSON.stringify({ type: "module" }))

    // `commands.run` waits for exit, so the server has to be backgrounded or
    // it would block until the sandbox idles out.
    const fixFlag = opts.fix ? " --fix" : ""
    await sandbox.commands.run("sh", {
      args: ["-c", `cd ${GUEST_DIR} && nohup node server.js ${GUEST_PORT}${fixFlag} >/tmp/prism-site.log 2>&1 & echo started`],
    })

    const { url } = await sandbox.previewUrl(GUEST_PORT)
    // Use it verbatim. `new URL("/", url)` looks harmless and is not: it drops
    // the signed query and every request then 401s.
    const ready = url

    const deadline = Date.now() + readyTimeoutMs
    let lastStatus = "no response"
    while (Date.now() < deadline) {
      try {
        const res = await fetch(ready)
        if (res.ok) return { url: ready, nodeVersion, close }
        lastStatus = `HTTP ${res.status}`
      } catch (err) {
        lastStatus = (err as Error).message
      }
      await new Promise((r) => setTimeout(r, 1500))
    }

    // Say what the guest saw rather than just "timed out".
    const log = await sandbox.files.readText("/tmp/prism-site.log").catch(() => "(no log)")
    throw new Error(
      `demo site never became reachable at ${ready} within ${readyTimeoutMs}ms (${lastStatus}).\n` +
        `guest node ${nodeVersion}, guest log:\n${log}`,
    )
  } catch (err) {
    await close()
    throw err
  }
}

/**
 * Append a path to a preview URL without losing the signed `pt_token` query.
 * `previewUrl + "/path"` and `new URL("/path", previewUrl)` both drop it.
 */
export function previewPath(previewUrl: string, path: string): string {
  const u = new URL(previewUrl)
  u.pathname = path
  return u.toString()
}
