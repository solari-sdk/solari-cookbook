/**
 * The agent's one sandbox: created on first use, reattached after the Durable
 * Object is evicted, replaced when it has died. The same pattern as
 * examples/sandbox-from-workers-ts, which explains each step at more length.
 */
import { ConnectionError, SolariClient } from "@solarisdk/sdk"

export type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function solari(apiKey: string): SolariClient {
  // Workers only allow the global `fetch` to be called unbound; the SDK calls
  // it as a method, which throws "Illegal invocation" without this wrapper.
  return new SolariClient({ apiKey, fetch: (input, init) => fetch(input, init) })
}

/** The sandbox went away partway through a task, taking its checkout with it. */
export class SandboxLost extends Error {
  constructor() {
    super("the sandbox was lost partway through the task (idle timeout, or killed); file it again")
  }
}

export class SandboxSlot {
  private sandbox?: Sandbox

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly client: SolariClient,
    private readonly name: string,
  ) {}

  /** The live sandbox, and whether this call had to create it. */
  async attach(): Promise<{ sandbox: Sandbox; created: boolean }> {
    if (this.sandbox?.connected) return { sandbox: this.sandbox, created: false }

    const storedId = await this.storage.get<string>("sandboxId")
    if (storedId) {
      try {
        const sandbox = await this.client.sandboxes.connect(storedId)
        await sandbox.connect()
        // A killed sandbox still looks up and connects; only a real call fails.
        await sandbox.commands.run("true")
        this.sandbox = sandbox
        return { sandbox, created: false }
      } catch {
        await this.storage.delete("sandboxId")
      }
    }

    const sandbox = await this.client.sandboxes.create({
      template: "base",
      // Rolling: every command resets it. Long enough to span a slow agent turn
      // that prints nothing, short enough that an idle agent stops billing.
      idleTimeoutMs: 15 * 60_000,
      metadata: { app: "agentinstance", agent: this.name },
    })
    await sandbox.connect()
    await this.storage.put("sandboxId", sandbox.id)
    this.sandbox = sandbox
    return { sandbox, created: true }
  }

  /**
   * Run a script. A stale handle surfaces as a ConnectionError, and what
   * happens next depends on what's on the other side:
   *
   *  - the same sandbox, still alive: the script may already have run, so it
   *    isn't run twice — the error is reported;
   *  - a new sandbox (the old one timed out or was killed): only a `portable`
   *    script runs again there. Anything that depends on the old machine's
   *    checkout would fail with a misleading "command not found", so the loss
   *    is reported as what it is.
   */
  async exec(
    script: string,
    env: Record<string, string>,
    opts: { timeoutMs: number; onOutput?: (chunk: string) => void; portable?: boolean },
  ): Promise<ExecResult> {
    const once = async () => {
      const { sandbox } = await this.attach()
      return sandbox.commands.run("sh", {
        args: ["-c", script],
        // Commands start without $HOME, and `git config --global` (or any tool
        // that keeps config in ~) fails with "fatal: $HOME not set".
        env: { HOME: "/root", ...env },
        timeoutMs: opts.timeoutMs,
        onStdout: opts.onOutput,
        onStderr: opts.onOutput,
      })
    }
    try {
      return await once()
    } catch (err) {
      if (!(err instanceof ConnectionError) || !this.sandbox) throw err
      const stale = this.sandbox.id
      this.sandbox.close()
      this.sandbox = undefined
      const { sandbox } = await this.attach()
      if (sandbox.id === stale) throw err
      if (!opts.portable) throw new SandboxLost()
      return await once()
    }
  }

  async release(): Promise<string | null> {
    const id = this.sandbox?.id ?? (await this.storage.get<string>("sandboxId")) ?? null
    if (id) await this.client.sandboxes.kill(id).catch(() => {})
    this.sandbox?.close()
    this.sandbox = undefined
    await this.storage.delete("sandboxId")
    return id
  }
}
