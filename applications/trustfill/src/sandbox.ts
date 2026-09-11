import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { SolariClient } from "@solarisdk/sdk"

const PORT = 3000
const REMOTE = "/tmp/portal"

export interface PortalHandle {
  url: string
  /** Always call this. Sandboxes bill until their idle timeout, and `close()` is not `kill()`. */
  stop: () => Promise<void>
}

export interface StartPortalOptions {
  apiKey: string
  /** Local dir holding portal.py, questionnaire.json, and the evidence corpus. */
  root: string
  /** Rolling idle window, not a hard deadline — it resets on every use. */
  timeoutMs?: number
}

/**
 * Boot the Northwind portal inside a Solari sandbox and expose it publicly.
 *
 * The evidence corpus is uploaded here too: it is the vendor's own SOC 2 report,
 * IR plan and architecture docs, and it belongs in an ephemeral VM that is
 * destroyed at the end of the run rather than on an operator's laptop.
 * (Honest limit, stated in the README: the model API is external, so the corpus
 * does travel to the provider. What the sandbox buys is that it never lands on
 * local disk and does not outlive the run.)
 */
export async function startPortal({ apiKey, root, timeoutMs = 15 * 60_000 }: StartPortalOptions): Promise<PortalHandle> {
  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs })

  const stop = async () => {
    // kill(), not close(): close() only drops our control channel and leaves the
    // VM billing until its idle timeout expires.
    await sandbox.kill().catch(() => {})
  }

  try {
    await sandbox.connect()

    await sandbox.files.write(`${REMOTE}/portal.py`, await readFile(join(root, "simulator", "portal.py"), "utf8"))
    await sandbox.files.write(
      `${REMOTE}/questionnaire.json`,
      await readFile(join(root, "questions", "questionnaire.json"), "utf8"),
    )

    for (const name of ["information-security-policy.md", "incident-response-plan.md", "architecture-overview.md", "soc2-scope-summary.md"]) {
      await sandbox.files.write(`${REMOTE}/evidence/${name}`, await readFile(join(root, "evidence", name), "utf8"))
    }

    // Background it: commands.run waits for exit, so a foreground server would
    // block until the idle timeout. And argv goes in `args` — commands are not
    // shell-interpreted, so run("python3 x.py") looks for a binary with that name.
    await sandbox.commands.run("sh", {
      args: ["-c", `cd ${REMOTE} && PORT=${PORT} nohup python3 portal.py >/tmp/portal.log 2>&1 &`],
    })

    const { url } = await sandbox.previewUrl(PORT)

    // Poll rather than sleep: the server is up when it answers, not after an
    // arbitrary delay that is either flaky or wasteful.
    for (let attempt = 1; attempt <= 20; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const res = await fetch(`${url}/health`)
        if (res.ok) return { url, stop }
      } catch {
        // not listening yet
      }
    }

    const log = await sandbox.commands.run("cat", { args: ["/tmp/portal.log"] }).catch(() => null)
    throw new Error(`portal did not become healthy at ${url}\n${JSON.stringify(log)?.slice(0, 400) ?? ""}`)
  } catch (err) {
    await stop()
    throw err
  }
}
