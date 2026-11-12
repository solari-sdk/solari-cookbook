import { describe, it, expect } from "vitest";
import { ConcurrencyLimitError } from "@solarisdk/sdk";

import { acquireSandboxSlot } from "../../src/checks/sandbox-slot.js";
import { sandboxCommandCheck } from "../../src/checks/sandbox-command.js";
import { sandboxCleanupCheck } from "../../src/checks/sandbox-cleanup.js";
import { fakeContext } from "../fixtures/fake-context.js";
import { fakeSandboxClient, gatewayError } from "../fixtures/fake-sandbox.js";

const KEY = "slr_live_abcd_efghijklmnop_qrstuvwxyz0123456789";

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("acquireSandboxSlot", () => {
  it("makes a second caller wait until the first releases", async () => {
    const releaseA = await acquireSandboxSlot();
    let bAcquired = false;
    const b = acquireSandboxSlot().then((release) => {
      bAcquired = true;
      return release;
    });

    await flush();
    expect(bAcquired).toBe(false);

    releaseA();
    const releaseB = await b;
    expect(bAcquired).toBe(true);
    releaseB();
  });

  it("treats a second release as a no-op rather than freeing a later holder", async () => {
    const releaseA = await acquireSandboxSlot();
    releaseA();
    const releaseB = await acquireSandboxSlot();

    let cAcquired = false;
    const c = acquireSandboxSlot().then((release) => {
      cAcquired = true;
      return release;
    });
    releaseA(); // stale release from an earlier holder
    await flush();
    expect(cAcquired).toBe(false);

    releaseB();
    (await c)();
  });
});

/**
 * Fakes for both sandbox checks that share one live-VM counter, as the real
 * account limit does (F52).
 */
function sharedLimitClients() {
  const live = { now: 0, max: 0 };
  const create = () => {
    live.now += 1;
    live.max = Math.max(live.max, live.now);
  };
  const kill = () => {
    live.now -= 1;
  };

  const command = fakeSandboxClient({
    sandboxId: "sbx_command",
    create,
    kill,
    run: (cmd) =>
      cmd === "ls -la"
        ? { exitCode: 127, stdout: "", stderr: "not found" }
        : { exitCode: 0, stdout: "total 0", stderr: "" },
  });
  const cleanup = fakeSandboxClient({
    sandboxId: "sbx_cleanup",
    create,
    kill,
    get: (_id, callIndex) => {
      if (callIndex === 0) return { state: "running" };
      throw gatewayError(404, "sandbox not found");
    },
  });
  return { live, command, cleanup };
}

describe("the sandbox checks run concurrently by the scheduler", () => {
  it("never hold two VMs at once, and both pass", async () => {
    const { live, command, cleanup } = sharedLimitClients();

    const [commandResult, cleanupResult] = await Promise.all([
      sandboxCommandCheck.run(fakeContext({ apiKey: KEY, sandboxClient: command.client }).ctx),
      sandboxCleanupCheck.run(fakeContext({ apiKey: KEY, sandboxClient: cleanup.client }).ctx),
    ]);

    expect(live.max).toBe(1);
    expect(live.now).toBe(0);
    expect(commandResult.status).toBe("pass");
    expect(cleanupResult.status).toBe("pass");
  });

  it("releases the slot when create() fails, so the other check still runs", async () => {
    const { client: failing } = fakeSandboxClient({
      create: () => {
        throw new ConcurrencyLimitError("Too many concurrent sessions");
      },
    });
    const { cleanup } = sharedLimitClients();

    const [commandResult, cleanupResult] = await Promise.all([
      sandboxCommandCheck.run(fakeContext({ apiKey: KEY, sandboxClient: failing }).ctx),
      sandboxCleanupCheck.run(fakeContext({ apiKey: KEY, sandboxClient: cleanup.client }).ctx),
    ]);

    expect(commandResult.status).toBe("fail");
    expect(cleanupResult.status).toBe("pass");
    expect(cleanup.calls.killed).toBeGreaterThan(0);
  });
});
