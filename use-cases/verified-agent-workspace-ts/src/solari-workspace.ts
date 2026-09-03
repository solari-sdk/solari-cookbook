import { SolariClient } from "@solarisdk/sdk"
import { randomUUID } from "node:crypto"
import type { CommandEvidence } from "./types.js"
import { scrubOutput } from "./evidence.js"

type SandboxHandle = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

export class SolariWorkspaceProvider {
  private readonly client: SolariClient
  private sandbox: SandboxHandle | null = null
  private ownedSandboxId: string | null = null
  private readonly runMetadata = { verifiedAgentRunId: randomUUID() }
  private previewPid: number | null = null

  constructor(apiKey: string) {
    this.client = new SolariClient({ apiKey })
  }

  async create(): Promise<string> {
    try {
      this.sandbox = await this.client.sandboxes.create({
        template: "base",
        metadata: this.runMetadata,
        timeoutMs: 10 * 60_000,
      })
      this.ownedSandboxId = this.sandbox.sandboxId
      await this.sandbox.connect()
      const mkdir = await this.sandbox.commands.run("mkdir", { args: ["-p", "/workspace"] })
      if (mkdir.exitCode !== 0) throw new Error(`Failed to prepare workspace: ${mkdir.stderr}`)
      return this.sandbox.sandboxId
    } catch (error) {
      await this.recoverOwnedSandboxes().catch(() => {})
      this.sandbox = null
      throw error
    }
  }

  async clone(repoUrl: string, ref?: string): Promise<void> {
    const sandbox = this.requireSandbox()
    await sandbox.git.clone(repoUrl, { path: "/workspace/repo" })
    if (ref) await sandbox.git.checkout(ref, { cwd: "/workspace/repo" })
  }


  async assertPathsWithinRepo(paths: string[]): Promise<void> {
    const sandbox = this.requireSandbox()
    for (const path of paths) {
      const result = await sandbox.commands.run("realpath", {
        args: ["--", path],
        cwd: "/workspace/repo",
        timeoutMs: 10_000,
      })
      if (result.exitCode !== 0) throw new Error(`allowlisted path cannot be resolved: ${path}`)
      const expected = `/workspace/repo/${path}`
      if (result.stdout.trim() !== expected) throw new Error(`allowlisted path resolves outside or through a symlink: ${path}`)
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.requireSandbox().files.write(path, content)
  }

  async exec(command: string, timeoutMs = 8 * 60_000, env?: Record<string, string>): Promise<CommandEvidence> {
    const sandbox = this.requireSandbox()
    const result = await sandbox.commands.run("sh", {
      args: ["-lc", command],
      cwd: "/workspace/repo",
      timeoutMs,
      env,
    })
    const secrets = Object.values(env ?? {})
    return {
      command: scrubOutput(command, secrets),
      exitCode: result.exitCode,
      stdout: scrubOutput(result.stdout, secrets),
      stderr: scrubOutput(result.stderr, secrets),
    }
  }

  async start(command: string): Promise<void> {
    await this.stop()
    const sandbox = this.requireSandbox()
    await sandbox.files.write(
      "/tmp/verified-agent-preview.sh",
      `#!/bin/sh\nset -eu\ncd /workspace/repo\n${command}\n`,
    )
    const result = await sandbox.commands.run("sh", {
      args: [
        "-lc",
        "command -v setsid >/dev/null 2>&1 || { echo setsid-missing >&2; exit 127; }; nohup setsid sh /tmp/verified-agent-preview.sh >/tmp/verified-agent-preview.log 2>&1 </dev/null & echo $!",
      ],
    })
    if (result.exitCode !== 0) throw new Error(`Failed to start preview: ${scrubOutput(result.stderr)}`)
    const pid = Number(result.stdout.trim())
    if (!Number.isInteger(pid) || pid < 1) throw new Error(`Failed to capture preview pid: ${scrubOutput(result.stdout)}`)
    this.previewPid = pid
  }

  async stop(): Promise<void> {
    if (this.previewPid === null || !this.sandbox) return
    const pid = this.previewPid
    this.previewPid = null
    await this.sandbox.commands.run("sh", {
      args: ["-lc", `kill -TERM -${pid} 2>/dev/null || true; sleep 0.2; kill -KILL -${pid} 2>/dev/null || true`],
      timeoutMs: 10_000,
    })
  }

  async previewLog(): Promise<string> {
    return scrubOutput(await this.requireSandbox().files.readText("/tmp/verified-agent-preview.log").catch(() => ""))
  }

  async gitDiff(): Promise<string> {
    const result = await this.requireSandbox().commands.run("git", {
      args: ["diff", "--no-ext-diff", "--no-color", "--"],
      cwd: "/workspace/repo",
      timeoutMs: 60_000,
    })
    if (result.exitCode !== 0) throw new Error(`git diff failed: ${scrubOutput(result.stderr)}`)
    return result.stdout
  }

  async gitStatus() {
    return this.requireSandbox().git.status("/workspace/repo")
  }

  async headSha(): Promise<string> {
    const [commit] = await this.requireSandbox().git.log({
      cwd: "/workspace/repo",
      maxCount: 1,
    })
    if (!commit) throw new Error("Repository has no HEAD commit")
    return commit.hash
  }

  async previewUrl(port: number): Promise<string> {
    return (await this.requireSandbox().previewUrl(port)).url
  }

  async ownedSandboxCount(): Promise<number> {
    let count = 0
    for await (const sandbox of this.client.sandboxes.listAll({ metadata: this.runMetadata })) {
      if (this.matchesRunMetadata(sandbox.metadata)) count += 1
    }
    return count
  }

  async destroy(): Promise<void> {
    if (this.sandbox) {
      await this.stop().catch(() => {})
      await this.sandbox.kill()
      this.sandbox = null
    }
  }

  private async recoverOwnedSandboxes(): Promise<void> {
    const ids = new Set<string>()
    const knownSandboxId = this.sandbox?.sandboxId ?? this.ownedSandboxId
    if (knownSandboxId) ids.add(knownSandboxId)
    for await (const sandbox of this.client.sandboxes.listAll({ metadata: this.runMetadata })) {
      if (this.matchesRunMetadata(sandbox.metadata)) ids.add(sandbox.sandboxId)
    }
    for (const sandboxId of ids) await this.client.sandboxes.kill(sandboxId).catch(() => {})
  }

  private matchesRunMetadata(metadata: Record<string, string> | undefined): boolean {
    return metadata?.verifiedAgentRunId === this.runMetadata.verifiedAgentRunId
  }

  private requireSandbox(): SandboxHandle {
    if (!this.sandbox) throw new Error("Workspace has not been created")
    return this.sandbox
  }
}
