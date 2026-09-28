import assert from "node:assert/strict"
import { test } from "node:test"
import { ConnectionError, type SolariClient } from "@solarisdk/sdk"
import { SandboxLost, SandboxSlot } from "../src/sandbox.ts"

/**
 * A fake Solari: sandbox "old" answers the first call with a dropped channel
 * and then refuses to reattach (it's gone); every create hands out a new one.
 */
function fakes() {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => void store.set(k, v),
    delete: async (k: string) => store.delete(k),
  } as unknown as DurableObjectStorage
  const ran: string[] = []
  let created = 0
  const sandbox = (id: string, dropFirst: boolean) => {
    let dropped = !dropFirst
    return {
      id,
      connected: true,
      connect: async () => {},
      close: () => {},
      commands: {
        run: async (_: string, opts: { args: string[] }) => {
          if (!dropped) {
            dropped = true
            throw new ConnectionError("Control channel closed (1005)")
          }
          ran.push(`${id}: ${opts.args[1]}`)
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
    }
  }
  const client = {
    sandboxes: {
      create: async () => sandbox(created++ === 0 ? "old" : `new${created}`, created === 1),
      connect: async () => {
        throw new Error("gone")
      },
    },
  } as unknown as SolariClient
  return { slot: new SandboxSlot(storage, client, "t"), ran }
}

test("a step that needs the old checkout reports the lost sandbox instead of running on a blank one", async () => {
  const { slot, ran } = fakes()
  await assert.rejects(slot.exec("cd /work/abc && git push", {}, { timeoutMs: 1000 }), SandboxLost)
  assert.deepEqual(ran, [])
})

test("a portable step runs again on the new sandbox", async () => {
  const { slot, ran } = fakes()
  await slot.exec("install toolchain", {}, { timeoutMs: 1000, portable: true })
  assert.equal(ran.length, 1)
  assert.match(ran[0], /^new\d+: install toolchain$/)
})
