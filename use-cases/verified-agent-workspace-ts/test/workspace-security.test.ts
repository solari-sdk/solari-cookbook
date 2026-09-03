import assert from "node:assert/strict"
import test from "node:test"
import { SolariWorkspaceProvider } from "../src/solari-workspace.js"

test("scopes agent secrets to one command and never records the value", async () => {
  const calls: Array<{ env?: Record<string, string>; args?: string[] }> = []
  const sandbox = { commands: { run: async (_cmd: string, options: { env?: Record<string, string>; args?: string[] }) => { calls.push(options); return { exitCode: 0, stdout: options.env?.AGENT_API_KEY ? `accidental ${options.env.AGENT_API_KEY}` : "ok", stderr: options.env?.AGENT_API_KEY ?? "" } } } }
  const provider = new SolariWorkspaceProvider("test-key")
  Object.defineProperty(provider, "sandbox", { value: sandbox, writable: true })
  const agent = await provider.exec("node /tmp/bounded-edit-agent.mjs", 1000, { AGENT_API_KEY: "secret-value" })
  await provider.exec("npm test")
  assert.deepEqual(calls[0]?.env, { AGENT_API_KEY: "secret-value" })
  assert.equal(calls[1]?.env, undefined)
  assert(!JSON.stringify(agent).includes("secret-value"))
  assert.match(agent.stdout, /REDACTED/)
  assert.match(agent.stderr, /REDACTED/)
})

test("rejects allowlisted paths whose real path escapes or redirects", async () => {
  const sandbox = { commands: { run: async (_cmd: string, options: { args?: string[] }) => ({ exitCode: 0, stdout: options.args?.includes("src/safe.ts") ? "/outside/safe.ts\n" : "/workspace/repo/src/ok.ts\n", stderr: "" }) } }
  const provider = new SolariWorkspaceProvider("test-key")
  Object.defineProperty(provider, "sandbox", { value: sandbox, writable: true })
  await assert.rejects(() => provider.assertPathsWithinRepo(["src/safe.ts"]), /resolves outside or through a symlink/)
  await assert.doesNotReject(() => provider.assertPathsWithinRepo(["src/ok.ts"]))
})
